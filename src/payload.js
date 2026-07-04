// Parses the `openScanPro://<base64_json>` launch URL that the browser hands to the
// desktop app after device login, and extracts the fields the simulator needs.

// Matches any custom URL scheme prefix, e.g. `openScanPro://` or a custom `--scheme`.
const SCHEME_PREFIX = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;

// TreatmentFiles enum (int) — matches the backend enum.
export const TreatmentFileType = {
  UpperJaw: 1,
  LowerJaw: 2,
};

// Human-readable name for a TreatmentFiles value, for logging (e.g. 1 -> "UpperJaw").
export function fileTypeName(value) {
  const name = Object.keys(TreatmentFileType).find((k) => TreatmentFileType[k] === Number(value));
  return name ?? 'unknown';
}

/**
 * Decode + parse a `<scheme>://<base64_json>` launch URL into its JSON payload object.
 * Accepts the URL with or without a scheme prefix (any scheme, not just openScanPro).
 */
export function parseLaunchUrl(url) {
  if (typeof url !== 'string' || url.trim() === '') {
    throw new Error('launch URL is empty');
  }

  let encoded = url.trim();
  // Strip whatever custom scheme prefix is present (registration allows a custom --scheme).
  encoded = encoded.replace(SCHEME_PREFIX, '');

  // A custom-scheme URL may arrive percent-encoded from the OS handler.
  try {
    encoded = decodeURIComponent(encoded);
  } catch {
    // Not percent-encoded; use as-is.
  }

  encoded = encoded.trim();
  if (encoded === '') {
    throw new Error('launch URL has no payload after the scheme');
  }

  let json;
  try {
    json = Buffer.from(encoded, 'base64').toString('utf8');
  } catch (err) {
    throw new Error(`failed to base64-decode launch payload: ${err.message}`);
  }

  let payload;
  try {
    payload = JSON.parse(json);
  } catch (err) {
    throw new Error(`launch payload is not valid JSON: ${err.message}`);
  }

  return payload;
}

/**
 * Pull the fields the simulator uses out of a parsed launch payload.
 * - auth.code            -> device-login code to exchange
 * - auth.tokenEndpoint   -> PATH (not full URL) of the token endpoint
 * - treatmentId          -> top-level treatment id (the upload target)
 * - externalCaseId       -> top-level external case id used on upload. `case.ID` is the
 *                           scan-job id, so we read the dedicated field and only fall back
 *                           to case.ID for older payloads that carried it there.
 * - fileType             -> requested TreatmentFiles type for the upload body; null for a
 *                           full (both-jaw) scan, in which case the per-file default is used.
 */
export function extractFields(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('launch payload did not decode to an object');
  }

  const auth = payload.auth || {};
  const caseObj = payload.case || payload.Case || {};

  const code = auth.code ?? auth.Code;
  const tokenEndpoint = auth.tokenEndpoint ?? auth.TokenEndpoint;

  const externalCaseId =
    payload.externalCaseId ??
    payload.ExternalCaseId ??
    caseObj.ID ??
    caseObj.Id ??
    caseObj.id ??
    null;

  const treatmentId = payload.treatmentId ?? payload.TreatmentId ?? payload.treatmentID ?? null;

  const rawFileType = payload.fileType ?? payload.FileType ?? null;
  const fileType = rawFileType === null || rawFileType === undefined ? null : Number(rawFileType);

  if (!code) {
    throw new Error('launch payload missing auth.code');
  }
  if (!tokenEndpoint) {
    throw new Error('launch payload missing auth.tokenEndpoint');
  }

  return {
    code,
    tokenEndpoint,
    treatmentId,
    externalCaseId,
    fileType,
  };
}
