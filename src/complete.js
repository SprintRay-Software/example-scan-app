// Save scan metadata and request mesh links through complete, then notify uploaded only
// after every upload succeeds. The uploaded callback closes the job and publishes AppSync.

import { httpJson, joinUrl } from './core/net.js';

/** Map an error status + body to a clear, actionable message. */
function describeError(status, body) {
  const snippet = body ? ` — ${body.slice(0, 800)}` : '';
  switch (status) {
    case 400:
      // Two ways in: no id at all, or metadata SprintRay refuses (a tooth number outside 1-32,
      // the same toothNumber twice, a filename whose extension is not allowed). The body says
      // which, so it is quoted above rather than guessed at here.
      return `completeScanJob: 400 — no id was sent, or the reported scan metadata is malformed${snippet}`;
    case 401:
      return `completeScanJob: 401 unauthorized — the doctor's access token is missing or expired${snippet}`;
    case 403:
      return `completeScanJob: 403 forbidden — missing or invalid x-api-key; the API gateway rejected the call before it reached SprintRay${snippet}`;
    case 404:
      return `completeScanJob: 404 — no scan job for this id/caseId, or it belongs to another doctor${snippet}`;
    default:
      return `completeScanJob: unexpected HTTP ${status}${snippet}`;
  }
}

/** How many mesh links came back, for the narrated log. */
function describeLinks(job) {
  const teeth = job?.segmentedTeethUploadLinks?.length ?? 0;
  const gingiva = [job?.gingivaUploadLink?.upper, job?.gingivaUploadLink?.lower].filter(Boolean).length;
  if (teeth === 0 && gingiva === 0) return 'no mesh links';
  return `${teeth} tooth link(s) + ${gingiva} gingiva link(s)`;
}

/**
 * POST {baseUrl}/integration/scan-job/complete
 *   Authorization: Bearer <accessToken>   x-api-key: <apiKey>
 *   { id, caseId?, scanMode?, hasUpper?, hasLower?, missingTeeth?, segmentedTeeth? }
 *
 * `id` is the launch payload's `case.ID`. (`scanJobId` is the original name for the same field
 * and is still accepted, so a shipped app needs no change; `id` wins when both are sent.)
 * `caseId` is only a fallback for a client that did not keep the id — it is not unique per
 * launch, so SprintRay resolves the newest session carrying it.
 *
 * Every metadata field is optional. This call leaves the session open for uploads.
 * Idempotent — a retry re-issues links to the SAME S3
 * objects and overwrites the metadata, so a same-payload retry converges.
 *
 * @param {object} opts
 * @param {import('./scan-report.js').buildScanReport|null} [opts.report] what the session captured
 * @returns {Promise<object>} the session + its mesh upload links
 */
export async function completeScanJob(
  reporter,
  { baseUrl, apiKey, accessToken, scanJobId, externalCaseId, report = null }
) {
  const url = joinUrl(baseUrl, 'integration/scan-job/complete');
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    Authorization: `Bearer ${accessToken}`,
    'x-api-key': apiKey,
  };
  const body = { id: scanJobId, caseId: externalCaseId, ...(report ?? {}) };

  reporter.phase('complete', 'active', `id=${scanJobId}`);
  reporter.step(`Saving scan metadata and requesting mesh upload links (id=${scanJobId})`);

  const { res, text } = await httpJson(reporter, {
    label: 'scan-job/complete',
    method: 'POST',
    url,
    headers,
    body,
  });

  if (!res.ok) {
    reporter.phase('complete', 'error', `HTTP ${res.status}`);
    throw new Error(describeError(res.status, text));
  }

  let job = null;
  try {
    job = JSON.parse(text);
  } catch {
    throw new Error('completeScanJob: invalid session response');
  }

  if (!job) {
    throw new Error('completeScanJob: missing session');
  }
  reporter.ok(`Scan metadata saved — ${describeLinks(job)}`);
  return job;
}

/** Notify the backend that all scan and mesh uploads succeeded. */
export async function markScanJobUploaded(reporter, { baseUrl, apiKey, accessToken, scanJobId }) {
  const { res, text } = await httpJson(reporter, {
    label: 'scan-job/uploaded',
    method: 'POST',
    url: joinUrl(baseUrl, `integration/scan-job/${encodeURIComponent(scanJobId)}/uploaded`),
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${accessToken}`,
      'x-api-key': apiKey,
    },
  });
  if (!res.ok) {
    reporter.phase('complete', 'error', `HTTP ${res.status}`);
    throw new Error(`scan-job/uploaded: HTTP ${res.status} — ${text.slice(0, 800)}`);
  }
  const job = JSON.parse(text);
  if (job?.status !== 3) throw new Error('scan-job/uploaded: missing Done status');
  reporter.ok('Scan session finished — all uploads succeeded');
  reporter.phase('complete', 'done', `HTTP ${res.status}`);
  return job;
}
