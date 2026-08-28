// Scan-file upload flow: get a presigned S3 URL from the backend, then PUT the bytes to S3.
// Every call is fully reported (request + response) via the injected reporter. Uses global
// fetch + fs (Node/Electron >= 18). No dependencies.

import { readFile } from 'node:fs/promises';
import { httpJson, httpPutStream, joinUrl } from './core/net.js';
import { archName, fileTypeName } from './payload.js';

/**
 * The /file/upload response may be:
 *   - a raw JSON string (the URL itself), or
 *   - an object { url } / { Url }.
 * Normalize both into a plain URL string.
 */
function extractPresignedUrl(parsed) {
  if (typeof parsed === 'string') return parsed;
  if (parsed && typeof parsed === 'object') {
    return parsed.url ?? parsed.Url ?? parsed.uploadUrl ?? parsed.UploadUrl ?? null;
  }
  return null;
}

/**
 * Ask the backend for a presigned upload URL for one file.
 * POST {baseUrl}/integration/file/upload  Authorization: Bearer <accessToken>  x-api-key: <apiKey>
 * Body is an ExternalProviderFileInputModel-like shape.
 */
export async function getUploadLink(
  reporter,
  {
    baseUrl,
    apiKey,
    accessToken,
    fileName,
    fileSize,
    treatmentId,
    scanJobId,
    treatmentFileType,
    fileTypeSource = 'fixture default',
    externalScanFileType,
    arch,
    externalCaseId,
  }
) {
  const url = joinUrl(baseUrl, 'integration/file/upload');
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    Authorization: `Bearer ${accessToken}`,
    'x-api-key': apiKey,
  };
  // scanJobId names the scan session this file belongs to; treatmentId binds it to the treatment.
  // They coexist, and a launch with no treatment behind it sends scanJobId alone — that is the only
  // way its uploads get recorded.
  //
  // externalScanFileType is this app's OWN name for what the file is. SprintRay registers an
  // unseen name against the integration on first sight, and once an admin has mapped it, that
  // mapping — not the treatmentFileType below — decides the file's SprintRay type. `arch` says
  // which jaw the file captures; it is what the scan-finish metadata is split by, so a file with
  // no arch gets none of it.
  const model = {
    fileName,
    fileSize,
    treatmentId,
    scanJobId,
    treatmentFileType,
    externalScanFileType,
    arch,
    externalCaseId,
  };

  // Highlight which FileType is being sent in the upload body and where it came from.
  reporter.phase('link', 'active', `FileType ${treatmentFileType} (${fileTypeName(treatmentFileType)})`);
  reporter.step(
    `Upload FileType for ${fileName}: ${treatmentFileType} (${fileTypeName(treatmentFileType)}) — source: ${fileTypeSource}`
  );
  reporter.step(
    `Scan type for ${fileName}: externalScanFileType=${externalScanFileType ?? '(none)'}` +
      `, arch=${arch === null || arch === undefined ? '(none)' : `${arch} (${archName(arch)})`}` +
      ' — a mapped externalScanFileType outranks the treatmentFileType above'
  );
  reporter.step(`Requesting presigned upload URL for ${fileName} (treatmentFileType=${treatmentFileType})`);

  const { res, text } = await httpJson(reporter, {
    label: `file/upload (${fileName})`,
    method: 'POST',
    url,
    headers,
    body: model,
  });

  if (!res.ok) {
    reporter.phase('link', 'error', `HTTP ${res.status}`);
    throw new Error(`getUploadLink(${fileName}): HTTP ${res.status}${text ? ` — ${text.slice(0, 500)}` : ''}`);
  }

  // The body may be a raw JSON string (the URL) or an object { url }.
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text.trim();
  }

  const presigned = extractPresignedUrl(parsed);
  if (!presigned || typeof presigned !== 'string') {
    reporter.phase('link', 'error', 'no presigned URL in response');
    throw new Error(
      `getUploadLink(${fileName}): could not extract a presigned URL from response: ${text.slice(0, 300)}`
    );
  }

  reporter.ok(`Got presigned URL for ${fileName}`);
  reporter.phase('link', 'done', 'presigned URL received');
  return presigned;
}

/**
 * PUT the raw file bytes to the presigned S3 URL, streaming so upload progress can be
 * reported. NO Authorization and NO x-api-key on the S3 PUT — the presigned URL is
 * self-authorizing, and an extra header breaks its signature. Expects 200/204.
 */
export async function putFile(reporter, presignedUrl, bytes, fileName, { phase = 'put', label = 'S3 PUT' } = {}) {
  const total = bytes.length;
  // `phase` may be null: a caller that drives its own pipeline stage (the mesh uploads, which are
  // one stage covering many PUTs) reports it once around the whole set instead of per file.
  if (phase) reporter.phase(phase, 'active', `PUT ${total} bytes to S3`);
  reporter.step(`Uploading ${total} bytes to presigned S3 URL`);

  const { res, text } = await httpPutStream(reporter, {
    label,
    url: presignedUrl,
    bytes,
    onProgress: (sent, t) => {
      const pct = t > 0 ? Math.min(100, Math.floor((sent / t) * 100)) : 100;
      reporter.progress({ label: fileName, sent, total: t, pct });
    },
  });

  if (res.status !== 200 && res.status !== 204) {
    if (phase) reporter.phase(phase, 'error', `HTTP ${res.status}`);
    throw new Error(`putFile: S3 PUT returned HTTP ${res.status}${text ? ` — ${text.slice(0, 500)}` : ''}`);
  }

  reporter.ok(`S3 PUT succeeded (HTTP ${res.status})`);
  if (phase) reporter.phase(phase, 'done', `HTTP ${res.status}`);
}

/**
 * Upload one fixture end-to-end: read bytes -> getUploadLink -> putFile.
 * Returns a small result record for the final summary.
 */
export async function uploadFixture(
  reporter,
  {
    baseUrl,
    apiKey,
    accessToken,
    filePath,
    fileName,
    treatmentId,
    scanJobId,
    treatmentFileType,
    fileTypeSource = 'fixture default',
    externalScanFileType,
    arch,
    externalCaseId,
  }
) {
  const bytes = await readFile(filePath);
  reporter.info(`Read scan ${fileName} (${bytes.length} bytes)`);

  const presignedUrl = await getUploadLink(reporter, {
    baseUrl,
    apiKey,
    accessToken,
    fileName,
    fileSize: bytes.length,
    treatmentId,
    scanJobId,
    treatmentFileType,
    fileTypeSource,
    externalScanFileType,
    arch,
    externalCaseId,
  });

  await putFile(reporter, presignedUrl, bytes, fileName);

  return {
    fileName,
    treatmentFileType,
    fileTypeSource,
    externalScanFileType,
    arch,
    fileSize: bytes.length,
  };
}
