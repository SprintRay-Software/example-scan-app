// Scan-file upload flow: get a presigned S3 URL from the backend, then PUT the bytes to S3.
// Uses global fetch + fs (Node >=18). No dependencies.

import { readFile } from 'node:fs/promises';
import { step, ok, info } from './log.js';
import { createProgress } from './progress.js';
import { logRequest, logResponse } from './http.js';

function joinUrl(baseUrl, path) {
  const b = String(baseUrl).replace(/\/+$/, '');
  const p = String(path).replace(/^\/+/, '');
  return `${b}/${p}`;
}

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
export async function getUploadLink({
  baseUrl,
  accessToken,
  fileName,
  fileSize,
  treatmentId,
  treatmentFileType,
  externalCaseId,
}) {
  const url = joinUrl(baseUrl, 'api/file/upload');
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    Authorization: `Bearer ${accessToken}`,
  };
  const model = { fileName, fileSize, treatmentId, treatmentFileType, externalCaseId };

  step(`Requesting presigned upload URL for ${fileName} (treatmentFileType=${treatmentFileType})`);
  logRequest({ label: `file/upload (${fileName})`, method: 'POST', url, headers, body: model });

  let res;
  try {
    res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(model) });
  } catch (err) {
    throw new Error(`getUploadLink(${fileName}): network error contacting ${url} — ${err.message}`);
  }

  const raw = await logResponse(`file/upload (${fileName})`, res);
  if (!res.ok) {
    throw new Error(`getUploadLink(${fileName}): HTTP ${res.status}${raw ? ` — ${raw.slice(0, 500)}` : ''}`);
  }

  // The body may be a raw JSON string (the URL) or an object { url }.
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = raw.trim();
  }

  const presigned = extractPresignedUrl(parsed);
  if (!presigned || typeof presigned !== 'string') {
    throw new Error(
      `getUploadLink(${fileName}): could not extract a presigned URL from response: ${raw.slice(0, 300)}`
    );
  }

  ok(`Got presigned URL for ${fileName}`);
  return presigned;
}

/**
 * PUT the raw file bytes to the presigned S3 URL, streaming so upload progress can be
 * reported. NO Authorization header on the S3 PUT — the presigned URL is self-authorizing.
 * `Content-Length` is set explicitly so S3 gets a non-chunked PUT. Expects 200/204.
 * @param {(sent:number,total:number)=>void} [onProgress]
 */
export async function putFile(presignedUrl, bytes, onProgress) {
  const total = bytes.length;
  const headers = { 'Content-Type': 'application/octet-stream', 'Content-Length': String(total) };

  step(`Uploading ${total} bytes to presigned S3 URL`);
  logRequest({ label: 'S3 PUT', method: 'PUT', url: presignedUrl, headers, bodyNote: `<binary ${total} bytes> (streamed)` });

  let sent = 0;
  const CHUNK = 256 * 1024;
  const body = new ReadableStream({
    pull(controller) {
      if (sent >= total) {
        controller.close();
        return;
      }
      const end = Math.min(sent + CHUNK, total);
      controller.enqueue(bytes.subarray(sent, end));
      sent = end;
      if (onProgress) onProgress(sent, total);
    },
  });

  let res;
  try {
    res = await fetch(presignedUrl, { method: 'PUT', headers, body, duplex: 'half' });
  } catch (err) {
    throw new Error(`putFile: network error PUTting to S3 — ${err.message}`);
  }

  const text = await logResponse('S3 PUT', res);
  if (res.status !== 200 && res.status !== 204) {
    throw new Error(`putFile: S3 PUT returned HTTP ${res.status}${text ? ` — ${text.slice(0, 500)}` : ''}`);
  }

  ok(`S3 PUT succeeded (HTTP ${res.status})`);
}

/**
 * Upload one fixture end-to-end: read bytes -> getUploadLink -> putFile.
 * Returns a small result record for the final summary.
 */
export async function uploadFixture({
  baseUrl,
  accessToken,
  filePath,
  fileName,
  treatmentId,
  treatmentFileType,
  externalCaseId,
}) {
  const bytes = await readFile(filePath);
  info(`Read scan ${fileName} (${bytes.length} bytes)`);

  const presignedUrl = await getUploadLink({
    baseUrl,
    accessToken,
    fileName,
    fileSize: bytes.length,
    treatmentId,
    treatmentFileType,
    externalCaseId,
  });

  const progress = createProgress(fileName);
  await putFile(presignedUrl, bytes, (s, t) => progress.update(s, t));
  progress.done();

  return { fileName, treatmentFileType, fileSize: bytes.length };
}
