// The single, instrumented desktop-app flow: decode the launch payload, exchange the
// device-login code for the doctor's tokens, optionally refresh, upload the scans, then tell
// SprintRay the scan session is finished.
// It is UI-agnostic — every observable event goes through the injected reporter, so the
// CLI console and the Electron UI run the exact same steps and see the exact same wire
// traffic. See ../../README.md and the DS spec (docs/third-party-desktop-scanner-integration.md).

import { resolve, basename } from 'node:path';

import { normalizeBaseUrl } from '../config.js';
import {
  parseLaunchUrl,
  extractFields,
  TreatmentFileType,
  fileTypeName,
  archName,
  archForFileType,
} from '../payload.js';
import { exchangeCodeForTokens, refreshTokens } from '../auth.js';
import { uploadFixture } from '../upload.js';
import { completeScanJob } from '../complete.js';
import { uploadScanArtifacts } from '../artifacts.js';
import { buildScanReport, describeScanReport, DEFAULT_SCAN_MODE, DEFAULT_SCAN_FILE_TYPES } from '../scan-report.js';

// Fallback only. Form A always takes the path from the launch payload's auth.tokenEndpoint —
// that field exists so SprintRay can move the route without a desktop-app release.
export const DEFAULT_TOKEN_PATH = '/integration/device-login-token';

/**
 * The scan vocabulary this run uses: the provider's own names for its scan file types and its
 * scan mode. They belong to the integration, not to a run, so they come from config (.env) with
 * a per-run CLI override on top and a built-in default under both — the Electron UI has no field
 * for them, and an unset one must still produce a working call.
 */
function scanVocabulary(config, input) {
  return {
    scanMode: input.scanMode ?? config.scanMode ?? DEFAULT_SCAN_MODE,
    upper: input.upperScanFileType ?? config.scanFileTypes?.upper ?? DEFAULT_SCAN_FILE_TYPES.upper,
    lower: input.lowerScanFileType ?? config.scanFileTypes?.lower ?? DEFAULT_SCAN_FILE_TYPES.lower,
  };
}

/**
 * Decode a launch URL to its payload + extracted fields, without touching the network.
 * Used by the UI's "Decode" preview and internally by runFlow.
 */
export function decodeLaunch(launchUrl) {
  const decoded = parseLaunchUrl(launchUrl);
  const fields = extractFields(decoded);
  return { decoded, fields };
}

/**
 * Resolve one arch to the file that will be sent for it: the caller's own pick when there is
 * one, else the bundled fixture for that arch.
 */
function buildUpload(treatmentFileType, fileTypeSource, input, fixturesDir, vocabulary) {
  const isLower = treatmentFileType === TreatmentFileType.LowerJaw;
  const override = isLower ? input.lowerFileOverride : input.upperFileOverride;
  const filePath = override
    ? resolve(override)
    : resolve(fixturesDir, isLower ? 'lower.stl' : 'upper.stl');
  return {
    treatmentFileType,
    fileTypeSource,
    filePath,
    fileName: basename(filePath),
    // This app's own name for the file's scan type, and the arch it captures. Both travel on the
    // upload body; the name is what an admin maps once to a SprintRay file type.
    externalScanFileType: isLower ? vocabulary.lower : vocabulary.upper,
    arch: archForFileType(treatmentFileType),
  };
}

/**
 * Run the device-login + upload flow.
 *
 * @param {import('./reporter.js').createReporter} reporter
 * @param {object} opts
 * @param {{ baseUrl: string, apiKey: string, clientId: string, clientSecret: string }} opts.config
 * @param {object} opts.input
 *   Form A: { launchUrl }
 *   Form B: { code, baseUrlOverride?, scanJobId?, treatmentId? }
 *   both:   { demoRefresh?, upperFileOverride?, lowerFileOverride?,
 *             scanMode?, upperScanFileType?, lowerScanFileType?,
 *             missingTeeth?, segmentedTeeth?, noMetadata?,
 *             toothFileOverride?, gingivaFileOverride? }
 * @param {string} opts.fixturesDir  where upper.stl / lower.stl and the tooth.ply / gingiva.ply
 *                                    meshes live
 * @returns {Promise<{ ok: boolean, results: object[], failures: object[],
 *                     completed: object|null, report: object|null, meshes: object[] }>}
 */
export async function runFlow(reporter, { config, input, fixturesDir }) {
  let baseUrl = config.baseUrl;
  let tokenPath = DEFAULT_TOKEN_PATH;
  let code;
  let treatmentId;
  let scanJobId;
  let externalCaseId;
  // Requested TreatmentFiles type from the launch payload; null = full-mouth scan (both arches).
  let payloadFileType = null;

  const hasFormA = Boolean(input.launchUrl && String(input.launchUrl).trim());

  if (hasFormA) {
    reporter.phase('decode', 'active', 'Parsing launch URL');
    reporter.step('Form A: parsing launch URL');
    const { decoded, fields } = decodeLaunch(input.launchUrl);
    reporter.payload({ decoded, fields });
    reporter.info('decoded launch payload (base64 JSON):\n' + JSON.stringify(decoded, null, 2));

    code = fields.code;
    // tokenEndpoint from the payload is a PATH; effective endpoint = BASE_URL + path.
    tokenPath = fields.tokenEndpoint;
    treatmentId = fields.treatmentId;
    scanJobId = fields.scanJobId;
    externalCaseId = fields.externalCaseId;
    payloadFileType = fields.fileType;

    reporter.info(`code=${code}`);
    reporter.info(`tokenEndpoint (path)=${tokenPath}`);
    reporter.info(`treatmentId=${treatmentId}`);
    reporter.info(`scanJobId (case.ID)=${scanJobId}`);
    reporter.info(`externalCaseId=${externalCaseId}`);
    reporter.info(
      payloadFileType === null
        ? 'launch payload fileType = null (full-mouth scan; upper AND lower will be uploaded)'
        : `launch payload fileType = ${payloadFileType} (${fileTypeName(payloadFileType)})`
    );
    reporter.phase('decode', 'done', `code=${code}`);
  } else {
    reporter.phase('decode', 'done', 'explicit flags (no launch URL)');
    reporter.step('Form B: using explicit flags');
    code = input.code;
    if (input.baseUrlOverride) baseUrl = normalizeBaseUrl(input.baseUrlOverride);
    tokenPath = DEFAULT_TOKEN_PATH;
    treatmentId = input.treatmentId ?? null;
    // There is no launch payload to read case.ID from, so the session has to be named explicitly:
    // --scan-job-id takes the `scanJobId` the device-login-code response returned. Naming it is
    // what lets the uploads be recorded against the session — and what lets the backend resolve
    // which integration they belong to, since a device-login token authenticates as the shared
    // exchange client and its `azp` names no integration. Without it the uploads are rejected.
    scanJobId = input.scanJobId ?? null;
    externalCaseId = scanJobId ?? input.treatmentId ?? null;
    reporter.info(`code=${code}`);
    reporter.info(`baseUrl=${baseUrl}`);
    reporter.info(`treatmentId=${treatmentId ?? '(none)'}`);
    reporter.info(`scanJobId=${scanJobId ?? '(none)'}`);
    if (!scanJobId && !treatmentId) {
      reporter.info(
        'Form B with neither --scan-job-id nor --treatment-id: the uploads name no scan session, ' +
          'so the backend cannot tell which integration they belong to and will reject them with 400.'
      );
    }
  }

  reporter.info(
    `Effective token endpoint = ${baseUrl}${tokenPath.startsWith('/') ? '' : '/'}${tokenPath}`
  );

  // 1) Exchange the code for tokens.
  let tokens = await exchangeCodeForTokens(reporter, {
    baseUrl,
    apiKey: config.apiKey,
    tokenPath,
    code,
    clientId: config.clientId,
    clientSecret: config.clientSecret,
  });

  // Optional: exercise the refresh endpoint.
  if (input.demoRefresh) {
    tokens = await refreshTokens(reporter, {
      baseUrl,
      apiKey: config.apiKey,
      refreshToken: tokens.refresh_token,
      clientId: config.clientId,
      clientSecret: config.clientSecret,
    });
  }

  // 2) Upload the scans. A real scanner captures both arches in one session and sends them
  // together, which is exactly what a launch carrying no fileType — a full-mouth scan — means,
  // so that path uploads upper AND lower. A launch that does name a fileType is the web app
  // asking for one arch on its own (a rescan of a single jaw); then only that one goes up.
  const vocabulary = scanVocabulary(config, input);
  const hasType = payloadFileType !== null && payloadFileType !== undefined;
  const uploads = hasType
    ? [buildUpload(Number(payloadFileType), 'launch payload', input, fixturesDir, vocabulary)]
    : [
        buildUpload(TreatmentFileType.UpperJaw, 'full-mouth scan (no fileType in payload)', input, fixturesDir, vocabulary),
        buildUpload(TreatmentFileType.LowerJaw, 'full-mouth scan (no fileType in payload)', input, fixturesDir, vocabulary),
      ];

  const describe = (u) =>
    `${u.fileName} (FileType ${u.treatmentFileType}/${fileTypeName(u.treatmentFileType)}, ` +
    `externalScanFileType ${u.externalScanFileType}, arch ${archName(u.arch)})`;
  reporter.step(
    hasType
      ? `Uploading one scan, requested by the launch payload: ${describe(uploads[0])}`
      : `Uploading ${uploads.length} scans captured in one session: ${uploads.map(describe).join(', ')}`
  );

  const results = [];
  const failures = [];

  // Sequential, not parallel: the progress bar and the per-request transaction log are the
  // whole point of this app, and two uploads racing would interleave both into noise.
  for (const upload of uploads) {
    try {
      const r = await uploadFixture(reporter, {
        baseUrl,
        apiKey: config.apiKey,
        accessToken: tokens.access_token,
        filePath: upload.filePath,
        fileName: upload.fileName,
        treatmentId,
        scanJobId,
        treatmentFileType: upload.treatmentFileType,
        fileTypeSource: upload.fileTypeSource,
        externalScanFileType: upload.externalScanFileType,
        arch: upload.arch,
        externalCaseId,
      });
      results.push(r);
    } catch (err) {
      // Keep going: one arch failing should still get the other one up, and the summary
      // reports exactly which succeeded.
      reporter.fail(`Upload failed for ${upload.fileName}: ${err.message}`);
      failures.push({ fileName: upload.fileName, error: err.message });
    }
  }

  // 3) Tell SprintRay the session is over, and report what it captured. Needs the session id —
  // Form A reads it from the launch payload's case.ID, Form B takes it from --scan-job-id. With
  // neither, the step reports as skipped rather than guessing an id.
  //
  // The report describes the CAPTURE, not the transfer: it is built from the arches this session
  // scanned, so an arch whose upload failed above is still reported as captured. `--no-metadata`
  // sends none of it — the pre-metadata call, which still closes the session out.
  let completed = null;
  let report = null;
  let meshes = [];
  if (scanJobId) {
    if (!input.noMetadata) {
      report = buildScanReport({
        arches: uploads.map((u) => u.arch).filter((a) => a !== null),
        scanMode: vocabulary.scanMode,
        missingTeeth: input.missingTeeth ?? [],
        segmentedTeeth: input.segmentedTeeth ?? null,
      });
      reporter.info(`Scan report: ${describeScanReport(report)}`);
    } else {
      reporter.info('Reporting no scan metadata (--no-metadata): the finish call sends the id alone.');
    }

    try {
      completed = await completeScanJob(reporter, {
        baseUrl,
        apiKey: config.apiKey,
        accessToken: tokens.access_token,
        scanJobId,
        externalCaseId,
        report,
      });
    } catch (err) {
      // The scans are already up; failing to close the session out is worth reporting, not worth
      // discarding the uploads over.
      reporter.fail(err.message);
      failures.push({ step: 'scan-job/complete', error: err.message });
    }

    // 4) PUT each segmented-tooth and gingiva mesh to the link the finish call returned. Nothing
    // follows this — the meshes are session metadata, so there is no confirm to call.
    if (completed) {
      const artifacts = await uploadScanArtifacts(reporter, {
        job: completed,
        toothFilePath: input.toothFileOverride
          ? resolve(input.toothFileOverride)
          : resolve(fixturesDir, 'tooth.ply'),
        gingivaFilePath: input.gingivaFileOverride
          ? resolve(input.gingivaFileOverride)
          : resolve(fixturesDir, 'gingiva.ply'),
      });
      meshes = artifacts.results;
      failures.push(...artifacts.failures);
    } else {
      reporter.phase('meshes', 'skipped', 'the session was not finished');
    }
  } else {
    reporter.phase('complete', 'skipped', 'no scan session named');
    reporter.info(
      'Skipping scan-job/complete: this run named no scan session. Form A reads it from the ' +
        "launch payload's case.ID; for Form B pass --scan-job-id."
    );
    reporter.phase('meshes', 'skipped', 'no scan session named');
  }

  const summary = { ok: failures.length === 0, results, failures, completed, report, meshes };
  reporter.result(summary);
  return summary;
}
