// Version handling exactly as ScanPro_OTA_API.md §4.1 defines it: `digits.digits.digits[.digits]`,
// compared segment by segment with a missing segment counted as 0 (`1.0.44` = `1.0.44.0`).
// Anything else — Allied Star's internal builds carry suffixes like `1.0.12.0-Fixbug11421` — is not
// a comparable version, and the caller must not treat it as older or newer.

const VERSION_RE = /^\d+\.\d+\.\d+(\.\d+)?$/;

/** @returns {boolean} whether `v` is a version the contract allows comparing */
export function isComparableVersion(v) {
  return typeof v === 'string' && VERSION_RE.test(v.trim());
}

/**
 * Compare two versions.
 * @returns {number|null} <0, 0, >0 like a sort comparator; null when either side is not comparable
 */
export function compareVersions(a, b) {
  if (!isComparableVersion(a) || !isComparableVersion(b)) return null;
  const pa = a.trim().split('.').map(Number);
  const pb = b.trim().split('.').map(Number);
  for (let i = 0; i < 4; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}
