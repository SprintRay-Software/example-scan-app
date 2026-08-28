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
 * PUT every mesh the finish call handed back a link for.
 *
 * One failure does not stop the rest — the scans are already up and the session is already
 * closed, so a mesh that did not land is worth reporting, not worth unwinding anything over.
 *
 * @returns {Promise<{ results: object[], failures: object[] }>}
 */
export async function uploadScanArtifacts(reporter, { job, toothFilePath, gingivaFilePath }) {
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
    `Uploading ${uploads.length} mesh(es) to the links the finish call returned: ` +
      uploads.map((u) => u.label).join(', ')
  );

  // Read each distinct fixture once — a full-mouth report is up to 34 PUTs of the same bytes.
  const cache = new Map();
  async function bytesOf(filePath) {
    if (!cache.has(filePath)) {
      const bytes = await readFile(filePath);
      reporter.info(`Read mesh ${basename(filePath)} (${bytes.length} bytes)`);
      cache.set(filePath, bytes);
    }
    return cache.get(filePath);
  }

  // Sequential, like the scan uploads: the per-request transaction log is the point of this app,
  // and parallel PUTs would interleave it into noise.
  for (const upload of uploads) {
    try {
      const bytes = await bytesOf(upload.filePath);
      await putFile(reporter, upload.url, bytes, upload.name, {
        // The 'meshes' stage is reported once around the whole set, above and below.
        phase: null,
        label: `S3 PUT (${upload.label})`,
      });
      results.push({ label: upload.label, fileName: upload.name, fileSize: bytes.length });
    } catch (err) {
      reporter.fail(`Mesh upload failed for ${upload.label}: ${err.message}`);
      failures.push({ step: `mesh ${upload.label}`, fileName: upload.name, error: err.message });
    }
  }

  if (failures.length === 0) {
    reporter.phase('meshes', 'done', `${results.length} mesh(es) uploaded`);
  } else {
    reporter.phase('meshes', 'error', `${failures.length} of ${uploads.length} failed`);
  }

  return { results, failures };
}
