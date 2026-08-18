// The single, instrumented desktop-app flow: decode the launch payload, exchange the
// device-login code for the doctor's tokens, optionally refresh, then upload the scans.
// It is UI-agnostic — every observable event goes through the injected reporter, so the
// CLI console and the Electron UI run the exact same steps and see the exact same wire
// traffic. See ../../README.md and the DS spec (docs/third-party-desktop-scanner-integration.md).

import { resolve, basename } from 'node:path';

import { normalizeBaseUrl } from '../config.js';
import { parseLaunchUrl, extractFields, TreatmentFileType, fileTypeName } from '../payload.js';
import { exchangeCodeForTokens, refreshTokens } from '../auth.js';
import { uploadFixture } from '../upload.js';

// Fallback only. Form A always takes the path from the launch payload's auth.tokenEndpoint —
// that field exists so SprintRay can move the route without a desktop-app release.
export const DEFAULT_TOKEN_PATH = '/integration/device-login-token';

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
function buildUpload(treatmentFileType, fileTypeSource, input, fixturesDir) {
  const isLower = treatmentFileType === TreatmentFileType.LowerJaw;
  const override = isLower ? input.lowerFileOverride : input.upperFileOverride;
  const filePath = override
    ? resolve(override)
    : resolve(fixturesDir, isLower ? 'lower.stl' : 'upper.stl');
  return { treatmentFileType, fileTypeSource, filePath, fileName: basename(filePath) };
}

/**
 * Run the device-login + upload flow.
 *
 * @param {import('./reporter.js').createReporter} reporter
 * @param {object} opts
 * @param {{ baseUrl: string, apiKey: string, clientId: string, clientSecret: string }} opts.config
 * @param {object} opts.input
 *   Form A: { launchUrl }
 *   Form B: { code, baseUrlOverride?, treatmentId? }
 *   both:   { demoRefresh?, upperFileOverride?, lowerFileOverride? }
 * @param {string} opts.fixturesDir  where upper.stl / lower.stl live
 * @returns {Promise<{ ok: boolean, results: object[], failures: object[] }>}
 */
export async function runFlow(reporter, { config, input, fixturesDir }) {
  let baseUrl = config.baseUrl;
  let tokenPath = DEFAULT_TOKEN_PATH;
  let code;
  let treatmentId;
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
    externalCaseId = fields.externalCaseId;
    payloadFileType = fields.fileType;

    reporter.info(`code=${code}`);
    reporter.info(`tokenEndpoint (path)=${tokenPath}`);
    reporter.info(`treatmentId=${treatmentId}`);
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
  const hasType = payloadFileType !== null && payloadFileType !== undefined;
  const uploads = hasType
    ? [buildUpload(Number(payloadFileType), 'launch payload', input, fixturesDir)]
    : [
        buildUpload(TreatmentFileType.UpperJaw, 'full-mouth scan (no fileType in payload)', input, fixturesDir),
        buildUpload(TreatmentFileType.LowerJaw, 'full-mouth scan (no fileType in payload)', input, fixturesDir),
      ];

  const describe = (u) => `${u.fileName} (FileType ${u.treatmentFileType}/${fileTypeName(u.treatmentFileType)})`;
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
        treatmentFileType: upload.treatmentFileType,
        fileTypeSource: upload.fileTypeSource,
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

  const summary = { ok: failures.length === 0, results, failures };
  reporter.result(summary);
  return summary;
}
