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
import { exchangeCodeForTokens, refreshTokens, subjectFromAccessToken } from '../auth.js';
import { uploadFixture } from '../upload.js';
import { completeScanJob } from '../complete.js';
import { uploadScanArtifacts } from '../artifacts.js';
import { mapWithConcurrency, toPositiveInt } from './concurrency.js';
import { createBufferingReporter } from './reporter.js';
import { buildScanReport, describeScanReport, DEFAULT_SCAN_MODE, DEFAULT_SCAN_FILE_TYPES } from '../scan-report.js';

// Files go up concurrently. This is how many at once when nothing overrides it — a run only ever
// has two scans, so it is the mesh batch (up to 34 PUTs) that this number is really for.
export const DEFAULT_UPLOAD_CONCURRENCY = 4;

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
 * @param {{ baseUrl: string, apiKey: string, clientId: string, clientSecret: string,
 *           uploadConcurrency?: number }} opts.config
 * @param {object} opts.input
 *   Form A: { launchUrl }
 *   Form B: { code, baseUrlOverride?, treatmentId? }
 *   both:   { demoRefresh?, upperFileOverride?, lowerFileOverride?,
 *             scanMode?, upperScanFileType?, lowerScanFileType?,
 *             missingTeeth?, segmentedTeeth?, noMetadata?,
 *             toothFileOverride?, gingivaFileOverride?, concurrency? }
 * @param {string} opts.fixturesDir  where upper.stl / lower.stl and the tooth.ply / gingiva.ply
 *                                    meshes live
 * @returns {Promise<{ ok: boolean, results: object[], failures: object[],
 *                     completed: object|null, report: object|null, meshes: object[] }>}
 */
export async function runFlow(reporter, { config, input, fixturesDir, launchTelemetry }) {
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
    // No launch payload means no real scan session: this dev path reuses the treatment id as the
    // case reference and has no case.ID at all, which is why it skips the scan-finish call below.
    scanJobId = null;
    externalCaseId = input.treatmentId ?? null;
    reporter.info(`code=${code}`);
    reporter.info(`baseUrl=${baseUrl}`);
    reporter.info(`treatmentId=${treatmentId ?? '(none)'}`);
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

  // 1b) The launch's scanner.connected has been waiting for exactly this: the doctor's id. It
  // was stamped when the launch arrived (that is when the scanner connected), and only now can
  // it name who the case belongs to — the payload carries a one-time code, not an identity.
  // Telemetry never decides whether a scan happens, so a failure here is logged and stepped
  // over; and it goes through the reporter, so the full batch is visible in the traffic log.
  if (launchTelemetry && !launchTelemetry.sent) {
    const userId = subjectFromAccessToken(tokens.access_token);
    reporter.phase('telemetry', 'active', 'Reporting scanner.connected');
    reporter.step(`Reporting scanner.connected${userId ? ` for ${userId}` : ' (no userId on the token)'}`);
    const result = await launchTelemetry.send({ userId, reporter });
    if (result.ok) {
      reporter.ok(`scanner.connected accepted (HTTP ${result.status})`);
      reporter.phase('telemetry', 'done', userId ? `userId=${userId}` : 'no userId');
    } else if (result.skipped) {
      reporter.info(`scanner.connected not sent — ${result.skipped}`);
      reporter.phase('telemetry', 'skipped', result.skipped);
    } else {
      reporter.fail(`scanner.connected failed — ${result.error ?? `HTTP ${result.status}`}`);
      reporter.phase('telemetry', 'error', result.error ?? `HTTP ${result.status}`);
    }
  }

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

  // Concurrent, not sequential: a session captures both arches and there is no reason for the
  // lower jaw to wait behind the upper — each file's link request and its S3 PUT are independent
  // of the other's. What must NOT interleave is the narration, since the per-request transaction
  // log is the whole point of this app: every file reports into its own buffer, and the pool
  // replays them in list order as they settle, so the log still reads one file at a time while
  // the bytes overlap on the wire.
  const concurrency = toPositiveInt(
    input.concurrency,
    toPositiveInt(config.uploadConcurrency, DEFAULT_UPLOAD_CONCURRENCY)
  );
  if (uploads.length > 1) {
    reporter.info(`Uploading up to ${concurrency} file(s) at a time`);
  }

  const uploadTasks = uploads.map((upload) => ({ upload, buffered: createBufferingReporter(reporter) }));

  await mapWithConcurrency(
    uploadTasks,
    concurrency,
    ({ upload, buffered }) =>
      uploadFixture(buffered.reporter, {
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
      }),
    (outcome, { upload, buffered }) => {
      buffered.flush();
      if (outcome.status === 'fulfilled') {
        results.push(outcome.value);
        return;
      }
      // Keep going: one arch failing should still get the other one up, and the summary
      // reports exactly which succeeded.
      const message = outcome.reason?.message ?? String(outcome.reason);
      reporter.fail(`Upload failed for ${upload.fileName}: ${message}`);
      failures.push({ fileName: upload.fileName, error: message });
    }
  );

  // 3) Tell SprintRay the session is over, and report what it captured. Only a real Form A
  // launch has a scan session to finish; Form B has no case.ID, so it reports the step as
  // skipped rather than guessing an id.
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
        concurrency,
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
    reporter.phase('complete', 'skipped', 'no scan session (Form B)');
    reporter.info('Skipping scan-job/complete: this run has no launch payload, so no case.ID.');
    reporter.phase('meshes', 'skipped', 'no scan session (Form B)');
  }

  const summary = { ok: failures.length === 0, results, failures, completed, report, meshes };
  reporter.result(summary);
  return summary;
}
