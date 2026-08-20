// Scan-finish call: tells SprintRay the scan session is over, so it closes the scan job out
// and pushes one event the web app can act on. Without it SprintRay can only guess "the scan
// is done" from individual upload events, which cannot tell "one arch arrived" from "finished".
//
// This is the LAST thing the desktop app does, after its final upload. Fully reported (request +
// response) via the injected reporter, like every other call.

import { httpJson, joinUrl } from './core/net.js';

/** Map an error status + body to a clear, actionable message. */
function describeError(status, body) {
  const snippet = body ? ` — ${body.slice(0, 800)}` : '';
  switch (status) {
    case 400:
      return `completeScanJob: 400 — neither scanJobId nor caseId was sent${snippet}`;
    case 401:
      return `completeScanJob: 401 unauthorized — the doctor's access token is missing or expired${snippet}`;
    case 403:
      return `completeScanJob: 403 forbidden — missing or invalid x-api-key; the API gateway rejected the call before it reached SprintRay${snippet}`;
    case 404:
      return `completeScanJob: 404 — no scan job for this scanJobId/caseId, or it belongs to another doctor${snippet}`;
    default:
      return `completeScanJob: unexpected HTTP ${status}${snippet}`;
  }
}

/**
 * POST {baseUrl}/integration/scan-job/complete
 *   Authorization: Bearer <accessToken>   x-api-key: <apiKey>
 *   { scanJobId, caseId? }
 *
 * `scanJobId` is the launch payload's `case.ID`. `caseId` is only a fallback for a client that
 * did not keep the id — it is not unique per launch, so SprintRay resolves the newest session
 * carrying it. Idempotent: calling it again on a finished session is a 200 no-op.
 */
export async function completeScanJob(
  reporter,
  { baseUrl, apiKey, accessToken, scanJobId, externalCaseId }
) {
  const url = joinUrl(baseUrl, 'integration/scan-job/complete');
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    Authorization: `Bearer ${accessToken}`,
    'x-api-key': apiKey,
  };
  const body = { scanJobId, caseId: externalCaseId };

  reporter.phase('complete', 'active', `scanJobId=${scanJobId}`);
  reporter.step(`Finishing the scan session (scanJobId=${scanJobId})`);

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
    // The status alone is the contract; a body we cannot parse is not a failure.
  }

  reporter.ok(`Scan session finished${job?.status ? ` (status ${job.status})` : ''}`);
  reporter.phase('complete', 'done', `HTTP ${res.status}`);
  return job;
}
