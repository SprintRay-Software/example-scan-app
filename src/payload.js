// Parses the `openScanPro://<base64_json>` launch URL that the browser hands to the
// desktop app after device login, and extracts the fields the simulator needs.

// Matches any custom URL scheme prefix, e.g. `openScanPro://` or a custom `--scheme`.
const SCHEME_PREFIX = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;

// TreatmentFiles enum (int) — matches the backend enum.
export const TreatmentFileType = {
  UpperJaw: 1,
  LowerJaw: 2,
};

// ArchType enum (int) — matches the backend enum. Which arch a file captures, sent as `arch`
// on the upload. `Both` is for one file carrying the whole mouth; a file that captures no one
// arch (a bite scan) sends no arch at all.
export const ArchType = {
  Upper: 1,
  Lower: 2,
  Both: 3,
};

// Human-readable name for a TreatmentFiles value, for logging (e.g. 1 -> "UpperJaw").
export function fileTypeName(value) {
  const name = Object.keys(TreatmentFileType).find((k) => TreatmentFileType[k] === Number(value));
  return name ?? 'unknown';
}

// Human-readable name for an ArchType value, for logging (e.g. 1 -> "Upper").
export function archName(value) {
  const name = Object.keys(ArchType).find((k) => ArchType[k] === Number(value));
  return name ?? 'unknown';
}

/**
 * The arch a single-jaw scan captures. Only the two jaw file types map to one — anything else
 * captures no single arch, and its upload sends no `arch`.
 */
export function archForFileType(value) {
  if (Number(value) === TreatmentFileType.UpperJaw) return ArchType.Upper;
  if (Number(value) === TreatmentFileType.LowerJaw) return ArchType.Lower;
  return null;
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
 * - scanJobId            -> `case.ID`: the scan session of THIS launch. Sent on every upload
 *                           and it is what the scan-finish call keys on.
 * - externalCaseId       -> top-level external case id used on upload (the correlation key of
 *                           SprintRay's upload event). A different thing from the scan session:
 *                           the fall back to case.ID is only for payloads predating the
 *                           dedicated field.
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

  const scanJobId = caseObj.ID ?? caseObj.Id ?? caseObj.id ?? null;

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
    scanJobId,
    externalCaseId,
    fileType,
  };
}
