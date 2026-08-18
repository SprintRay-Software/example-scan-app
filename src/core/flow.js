// The single, instrumented desktop-app flow: decode the launch payload, exchange the
// device-login code for the doctor's tokens, optionally refresh, then upload one scan.
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
 * Run the device-login + upload flow.
 *
 * @param {import('./reporter.js').createReporter} reporter
 * @param {object} opts
 * @param {{ baseUrl: string, apiKey: string, clientId: string, clientSecret: string }} opts.config
 * @param {object} opts.input
 *   Form A: { launchUrl }
 *   Form B: { code, baseUrlOverride?, treatmentId? }
 *   both:   { demoRefresh?, filePathOverride? }
 * @param {string} opts.fixturesDir  where upper.stl / lower.stl live
 * @returns {Promise<{ ok: boolean, results: object[], failures: object[] }>}
 */
export async function runFlow(reporter, { config, input, fixturesDir }) {
  let baseUrl = config.baseUrl;
  let tokenPath = DEFAULT_TOKEN_PATH;
  let code;
  let treatmentId;
  let externalCaseId;
  // Requested TreatmentFiles type from the launch payload; null = full scan (use per-file default).
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
        ? 'launch payload fileType = null (full scan; per-file default will be used)'
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

  // 2) Upload exactly one scan, chosen by the requested fileType (upper vs lower).
  const hasType = payloadFileType !== null && payloadFileType !== undefined;
  const treatmentFileType = hasType ? Number(payloadFileType) : TreatmentFileType.UpperJaw;
  const fileTypeSource = hasType ? 'launch payload' : 'default (no fileType in payload)';
  const isLower = treatmentFileType === TreatmentFileType.LowerJaw;
  const defaultFile = isLower ? 'lower.stl' : 'upper.stl';

  const filePath = input.filePathOverride
    ? resolve(input.filePathOverride)
    : resolve(fixturesDir, defaultFile);
  const fileName = basename(filePath);

  reporter.step(
    `Uploading one scan for FileType ${treatmentFileType} (${fileTypeName(treatmentFileType)}) ` +
      `from ${fileTypeSource}: ${fileName}`
  );

  const results = [];
  const failures = [];

  try {
    const r = await uploadFixture(reporter, {
      baseUrl,
      apiKey: config.apiKey,
      accessToken: tokens.access_token,
      filePath,
      fileName,
      treatmentId,
      treatmentFileType,
      fileTypeSource,
      externalCaseId,
    });
    results.push(r);
  } catch (err) {
    reporter.fail(`Upload failed for ${fileName}: ${err.message}`);
    failures.push({ fileName, error: err.message });
  }

  const summary = { ok: failures.length === 0, results, failures };
  reporter.result(summary);
  return summary;
}
