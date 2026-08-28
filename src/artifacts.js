// The mesh uploads the scan-finish call unlocks: one presigned PUT per segmented tooth, plus
// one per captured arch's gingiva.
//
// These are session metadata, not treatment files. They never attach to the treatment and never
// show up in the doctor's Cloud Drive, and — unlike the scan upload — there is NOTHING to call
// after the PUT: no confirm, no second finish call. The links expire in 30 minutes; calling the
// finish endpoint again re-issues links to the same objects, so a retry never duplicates a mesh.

import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

import { putFile } from './upload.js';
import { mapWithConcurrency } from './core/concurrency.js';
import { createBufferingReporter } from './core/reporter.js';

// How many mesh PUTs run at once when the caller does not say. Enough to keep the 30-minute
// link window busy, low enough that the batch is still one readable block of output.
export const DEFAULT_MESH_CONCURRENCY = 4;

/**
 * Pair the links SprintRay returned with the local file that stands in for each mesh.
 * A real scanner has one mesh per tooth; this app has one fixture, PUT under each link.
 */
export function collectArtifactUploads(job, { toothFilePath, gingivaFilePath }) {
  const uploads = [];

  for (const link of job?.segmentedTeethUploadLinks ?? []) {
    if (!link?.url) continue;
    uploads.push({
      label: `tooth ${link.toothNumber}`,
      // The object's name and extension were fixed by the filename reported on the finish call;
      // this is only what the log calls it.
      name: `tooth_${link.toothNumber}.ply`,
      url: link.url,
      filePath: toothFilePath,
    });
  }

  for (const arch of ['upper', 'lower']) {
    const url = job?.gingivaUploadLink?.[arch];
    if (!url) continue;
    uploads.push({
      label: `gingiva ${arch}`,
      name: `gingiva_${arch}.ply`,
      url,
      filePath: gingivaFilePath,
    });
  }

  return uploads;
}

/**
 * PUT every mesh the finish call handed back a link for, `concurrency` at a time.
 *
 * A full-mouth report is up to 34 links, and every one of them is an independent PUT to S3
 * against a link that expires in 30 minutes — sending them one after another is the slowest
 * possible way to spend that window.
 *
 * One failure does not stop the rest — the scans are already up and the session is already
 * closed, so a mesh that did not land is worth reporting, not worth unwinding anything over.
 *
 * @returns {Promise<{ results: object[], failures: object[] }>}
 */
export async function uploadScanArtifacts(
  reporter,
  { job, toothFilePath, gingivaFilePath, concurrency = DEFAULT_MESH_CONCURRENCY }
) {
  const uploads = collectArtifactUploads(job, { toothFilePath, gingivaFilePath });
  const results = [];
  const failures = [];

  if (uploads.length === 0) {
    reporter.phase('meshes', 'skipped', 'no mesh links returned');
    reporter.info(
      'No segmented-tooth or gingiva links came back: the finish call reported no teeth and no arches.'
    );
    return { results, failures };
  }

  reporter.phase('meshes', 'active', `${uploads.length} mesh(es)`);
  reporter.step(
    `Uploading ${uploads.length} mesh(es) to the links the finish call returned, ` +
      `${concurrency} at a time: ` +
      uploads.map((u) => u.label).join(', ')
  );

  // Read each distinct fixture once — a full-mouth report is up to 34 PUTs of the same bytes.
  // The cache holds the in-flight PROMISE, not the bytes: concurrent PUTs ask for the same
  // file before any read has finished, and caching the result alone would read it 34 times.
  const cache = new Map();
  function bytesOf(filePath, taskReporter) {
    if (!cache.has(filePath)) {
      cache.set(
        filePath,
        readFile(filePath).then((bytes) => {
          taskReporter.info(`Read mesh ${basename(filePath)} (${bytes.length} bytes)`);
          return bytes;
        })
      );
    }
    return cache.get(filePath);
  }

  // Concurrent PUTs, ordered narration: each mesh writes into its own buffer, and the pool
  // replays them in list order as they settle, so the transaction log still reads one mesh at
  // a time. The 'meshes' stage is reported once around the whole set, above and below.
  const tasks = uploads.map((upload) => ({ upload, buffered: createBufferingReporter(reporter) }));

  await mapWithConcurrency(
    tasks,
    concurrency,
    async ({ upload, buffered }) => {
      const bytes = await bytesOf(upload.filePath, buffered.reporter);
      await putFile(buffered.reporter, upload.url, bytes, upload.name, {
        phase: null,
        label: `S3 PUT (${upload.label})`,
      });
      return { label: upload.label, fileName: upload.name, fileSize: bytes.length };
    },
    (outcome, { upload, buffered }) => {
      buffered.flush();
      if (outcome.status === 'fulfilled') {
        results.push(outcome.value);
      } else {
        const message = outcome.reason?.message ?? String(outcome.reason);
        reporter.fail(`Mesh upload failed for ${upload.label}: ${message}`);
        failures.push({ step: `mesh ${upload.label}`, fileName: upload.name, error: message });
      }
    }
  );

  if (failures.length === 0) {
    reporter.phase('meshes', 'done', `${results.length} mesh(es) uploaded`);
  } else {
    reporter.phase('meshes', 'error', `${failures.length} of ${uploads.length} failed`);
  }

  return { results, failures };
}
