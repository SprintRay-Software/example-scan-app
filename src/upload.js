// Scan-file upload flow: get a presigned S3 URL from the backend, then PUT the bytes to S3.
// Every call is fully reported (request + response) via the injected reporter. Uses global
// fetch + fs (Node/Electron >= 18). No dependencies.

import { readFile } from 'node:fs/promises';
import { httpJson, httpPutStream, joinUrl } from './core/net.js';
import { fileTypeName } from './payload.js';

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
 * POST {baseUrl}/api/file/upload  Authorization: Bearer <accessToken>
 * Body is an ExternalProviderFileInputModel-like shape.
 */
export async function getUploadLink(
  reporter,
  { baseUrl, accessToken, fileName, fileSize, treatmentId, treatmentFileType, fileTypeSource = 'fixture default', externalCaseId }
) {
  const url = joinUrl(baseUrl, 'api/file/upload');
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    Authorization: `Bearer ${accessToken}`,
  };
  const model = { fileName, fileSize, treatmentId, treatmentFileType, externalCaseId };

  // Highlight which FileType is being sent in the upload body and where it came from.
  reporter.phase('link', 'active', `FileType ${treatmentFileType} (${fileTypeName(treatmentFileType)})`);
  reporter.step(
    `Upload FileType for ${fileName}: ${treatmentFileType} (${fileTypeName(treatmentFileType)}) — source: ${fileTypeSource}`
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
 * reported. NO Authorization header on the S3 PUT — the presigned URL is self-authorizing.
 * Expects 200/204.
 */
export async function putFile(reporter, presignedUrl, bytes, fileName) {
  const total = bytes.length;
  reporter.phase('put', 'active', `PUT ${total} bytes to S3`);
  reporter.step(`Uploading ${total} bytes to presigned S3 URL`);

  const { res, text } = await httpPutStream(reporter, {
    label: 'S3 PUT',
    url: presignedUrl,
    bytes,
    onProgress: (sent, t) => {
      const pct = t > 0 ? Math.min(100, Math.floor((sent / t) * 100)) : 100;
      reporter.progress({ label: fileName, sent, total: t, pct });
    },
  });

  if (res.status !== 200 && res.status !== 204) {
    reporter.phase('put', 'error', `HTTP ${res.status}`);
    throw new Error(`putFile: S3 PUT returned HTTP ${res.status}${text ? ` — ${text.slice(0, 500)}` : ''}`);
  }

  reporter.ok(`S3 PUT succeeded (HTTP ${res.status})`);
  reporter.phase('put', 'done', `HTTP ${res.status}`);
}

/**
 * Upload one fixture end-to-end: read bytes -> getUploadLink -> putFile.
 * Returns a small result record for the final summary.
 */
export async function uploadFixture(
  reporter,
  { baseUrl, accessToken, filePath, fileName, treatmentId, treatmentFileType, fileTypeSource = 'fixture default', externalCaseId }
) {
  const bytes = await readFile(filePath);
  reporter.info(`Read scan ${fileName} (${bytes.length} bytes)`);

  const presignedUrl = await getUploadLink(reporter, {
    baseUrl,
    accessToken,
    fileName,
    fileSize: bytes.length,
    treatmentId,
    treatmentFileType,
    fileTypeSource,
    externalCaseId,
  });

  await putFile(reporter, presignedUrl, bytes, fileName);

  return { fileName, treatmentFileType, fileTypeSource, fileSize: bytes.length };
}
