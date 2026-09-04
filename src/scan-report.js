// The scan report: what the session captured, sent with the scan-finish call.
//
// A real scanner knows all of this from its own capture — which arches it took, the mode the
// operator picked, the teeth it segmented, the ones that are not there, the state each tooth is
// in. This app has no scanner behind it, so it derives a plausible report from the arches it just
// uploaded and lets every part of it be overridden from the CLI. Every field is optional on the
// wire: `--no-metadata` sends none of it and the session still closes, which is how a shipped
// client behaves.
//
// Tooth numbers are ALWAYS universal (1-32) here, whatever the launch payload's `toothSystem`
// says — that governs how teeth are shown to the doctor, never what is reported back.

import { ArchType } from './payload.js';

// The provider's own vocabulary, not a SprintRay enum. Unseen names are registered against the
// integration on first sight and an admin maps them once; keep the spelling stable.
export const DEFAULT_SCAN_MODE = 'quickScan';
export const DEFAULT_SCAN_FILE_TYPES = { upper: 'UpperArch', lower: 'LowerArch' };

// The state a segmented tooth is in. Unlike scanMode this IS a fixed SprintRay vocabulary —
// a closed string enum, and the only values `condition` accepts.
export const ToothCondition = Object.freeze({
  Prepared: 'prepared',
  Missing: 'missing',
  Restored: 'restored',
});

export const TOOTH_CONDITIONS = Object.freeze(Object.values(ToothCondition));

// Universal numbering: 1-16 is the upper arch, 17-32 the lower.
export const UPPER_TEETH = Array.from({ length: 16 }, (_, i) => i + 1);
export const LOWER_TEETH = Array.from({ length: 16 }, (_, i) => i + 17);

/** The universal tooth numbers an arch covers. */
export function teethOfArch(arch) {
  if (arch === ArchType.Upper) return [...UPPER_TEETH];
  if (arch === ArchType.Lower) return [...LOWER_TEETH];
  return [...UPPER_TEETH, ...LOWER_TEETH];
}

/**
 * Parse a `--missing-teeth 1,16` / `--segmented-teeth 8,9` list into universal tooth numbers.
 * Throws on anything outside 1-32 rather than letting the backend answer with a 400.
 */
export function parseTeethList(value, flag) {
  const parts = String(value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const teeth = [];
  for (const part of parts) {
    const n = Number(part);
    if (!Number.isInteger(n) || n < 1 || n > 32) {
      throw new Error(`${flag}: "${part}" is not a universal tooth number (1-32)`);
    }
    if (!teeth.includes(n)) teeth.push(n);
  }
  return teeth.sort((a, b) => a - b);
}

/**
 * Parse a `--tooth-condition 8=prepared,9=restored` list into a Map of tooth number -> condition.
 * Rejects a value outside the enum here rather than letting the backend answer with a 400 —
 * `condition` is a closed vocabulary, so a typo is a client bug, not a new name to register.
 */
export function parseToothConditions(value, flag) {
  const conditions = new Map();

  const parts = String(value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq < 0) {
      throw new Error(`${flag}: "${part}" is not a <tooth>=<condition> pair`);
    }

    const [tooth] = parseTeethList(part.slice(0, eq), flag);
    if (tooth === undefined) {
      throw new Error(`${flag}: "${part}" names no tooth`);
    }

    const condition = part.slice(eq + 1).trim();
    if (!TOOTH_CONDITIONS.includes(condition)) {
      throw new Error(
        `${flag}: "${condition}" is not a tooth condition (${TOOTH_CONDITIONS.join(', ')})`
      );
    }

    conditions.set(tooth, condition);
  }

  return conditions;
}

// Deterministic stand-in for a segmentation score, so two runs produce identical logs.
function confidenceFor(toothNumber) {
  return Number((0.9 + ((toothNumber * 7) % 10) / 100).toFixed(2));
}

/**
 * Build the report for a session that captured `arches`.
 *
 * @param {object} opts
 * @param {number[]} opts.arches            ArchType values the session captured
 * @param {string} [opts.scanMode]          the provider's own mode name
 * @param {number[]} [opts.missingTeeth]    universal tooth numbers that are not there
 * @param {number[]|null} [opts.segmentedTeeth]  explicit tooth list; null = every tooth of the
 *                                          captured arches that is not missing
 * @param {Map<number, string>|null} [opts.toothConditions]  per-tooth condition; a tooth not in
 *                                          the map is reported with condition null
 * @returns {{ scanMode: string, hasUpper: boolean, hasLower: boolean, missingTeeth: number[],
 *            segmentedTeeth: { toothNumber: number, filename: string, confidence: number,
 *                              condition: string|null }[] }}
 */
export function buildScanReport({
  arches,
  scanMode = DEFAULT_SCAN_MODE,
  missingTeeth = [],
  segmentedTeeth = null,
  toothConditions = null,
}) {
  const captured = new Set(arches);
  const hasUpper = captured.has(ArchType.Upper) || captured.has(ArchType.Both);
  const hasLower = captured.has(ArchType.Lower) || captured.has(ArchType.Both);

  const missing = [...new Set(missingTeeth)].sort((a, b) => a - b);
  const conditions = toothConditions ?? new Map();

  // A scanner only segments teeth it actually captured, and never a tooth it just reported as
  // missing — a report that contradicts itself would be a bad example to copy.
  const inCapturedArch = (t) => (t <= 16 ? hasUpper : hasLower);
  const numbers = (segmentedTeeth ?? teethOfArch(hasUpper && hasLower ? ArchType.Both : hasUpper ? ArchType.Upper : ArchType.Lower))
    .filter((t) => inCapturedArch(t) && !missing.includes(t))
    .sort((a, b) => a - b);

  return {
    scanMode,
    hasUpper,
    hasLower,
    missingTeeth: missing,
    segmentedTeeth: numbers.map((toothNumber) => ({
      toothNumber,
      // The filename decides the S3 object's extension. A tooth reported without one, and every
      // gingiva mesh, is named by SprintRay and defaults to .ply.
      filename: `tooth_${toothNumber}.ply`,
      confidence: confidenceFor(toothNumber),
      // What the tooth is: prepared, missing, restored — or null when the scanner did not
      // classify it. A confidence score can be invented for an example; a clinical state cannot,
      // so this app reports null unless the run named a condition (--tooth-condition). The key
      // is sent either way, so the wire log shows where a real client puts its value.
      condition: conditions.get(toothNumber) ?? null,
    })),
  };
}

/** One-line summary of a report, for the narrated log. */
export function describeScanReport(report) {
  const arches = [report.hasUpper ? 'upper' : null, report.hasLower ? 'lower' : null]
    .filter(Boolean)
    .join(' + ');
  const conditioned = report.segmentedTeeth.filter((t) => t.condition);
  return (
    `scanMode=${report.scanMode}, arches=${arches || 'none'}, ` +
    `${report.segmentedTeeth.length} segmented teeth, ` +
    `missing=${report.missingTeeth.length > 0 ? report.missingTeeth.join(',') : 'none'}, ` +
    `conditions=${conditioned.length > 0 ? conditioned.map((t) => `${t.toothNumber}:${t.condition}`).join(' ') : 'none'}`
  );
}
