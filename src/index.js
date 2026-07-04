#!/usr/bin/env node
// ScanPro desktop-app simulator.
// Simulates the desktop half of the device-login + scan-upload flow so a developer
// can test the Design-Service backend end to end.
//
// Invocation forms:
//   A) node src/index.js "openScanPro://<base64_json>"          (handle a launch URL)
//   B) node src/index.js --code <c> --base-url <u> [--treatment-id <guid>]
//   C) node src/index.js register|unregister|status [--scheme <s>] [--env-file <p>] [--headless]
//
// Forms A/B run the device-login + upload flow. Form C registers this simulator as the
// OS handler for the scanner's URL scheme, so the browser can launch it for real.
//
// Optional (A/B): --demo-refresh  (also exercises the token refresh endpoint)
//
// Env (via `node --env-file=.env`): SCANPRO_BASE_URL, SCANPRO_CLIENT_ID, SCANPRO_CLIENT_SECRET,
//   and optional SCANPRO_URL_SCHEME (default scheme for `register`).

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { loadConfig, normalizeBaseUrl } from './config.js';
import { step, ok, fail, info } from './log.js';
import { parseLaunchUrl, extractFields, TreatmentFileType } from './payload.js';
import { exchangeCodeForTokens, refreshTokens } from './auth.js';
import { uploadFixture } from './upload.js';
import { SCHEME_COMMANDS, runSchemeCommand } from './scheme-cli.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = resolve(__dirname, '..', 'fixtures');

const DEFAULT_TOKEN_PATH = '/api/integration/device-login-token';

const USAGE = `ScanPro desktop-app simulator

Usage:
  Form A (launch URL from the browser handoff):
    node --env-file=.env src/index.js "openScanPro://<base64_json>"

  Form B (explicit flags):
    node --env-file=.env src/index.js --code <code> [--base-url <url>] [--treatment-id <guid>]

  Form C (register this simulator as the OS handler for the scanner URL scheme,
          so clicking "OR Scan" in the browser launches it for real):
    node src/index.js register   [--scheme <s>] [--env-file <p>] [--headless]
    node src/index.js status     [--scheme <s>]
    node src/index.js unregister [--scheme <s>]

Options:
    --code <code>          device-login code to exchange (Form B)
    --base-url <url>       override SCANPRO_BASE_URL for this run (Form B)
    --treatment-id <guid>  treatmentId to attach uploads to (Form B)
    --demo-refresh         also call the token refresh endpoint after exchange
    --scheme <s>           override the URL scheme for register/status/unregister
                           (else read from $SCANPRO_URL_SCHEME in .env)
    --env-file <p>         env file the registered handler loads (default: ./.env)
    --headless             (macOS register) run headless to a log file instead of a Terminal window
    -h, --help             show this help

Environment (loaded via --env-file=.env):
    SCANPRO_BASE_URL, SCANPRO_CLIENT_ID, SCANPRO_CLIENT_SECRET, SCANPRO_URL_SCHEME (optional)
`;

// Very small flag parser — no dependencies.
function parseArgs(argv) {
  const args = {
    launchUrl: null,
    code: null,
    baseUrlOverride: null,
    treatmentId: null,
    demoRefresh: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '-h':
      case '--help':
        args.help = true;
        break;
      case '--code':
        args.code = argv[++i];
        break;
      case '--base-url':
        args.baseUrlOverride = argv[++i];
        break;
      case '--treatment-id':
        args.treatmentId = argv[++i];
        break;
      case '--demo-refresh':
        args.demoRefresh = true;
        break;
      default:
        // First non-flag positional is treated as the launch URL (Form A).
        if (!a.startsWith('--') && args.launchUrl === null) {
          args.launchUrl = a;
        }
        break;
    }
  }

  return args;
}

// Any custom-scheme URL positional (openScanPro://…, or a custom --scheme registered app).
function isLaunchUrl(s) {
  return typeof s === 'string' && /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(s.trim());
}

async function main() {
  const argv = process.argv.slice(2);

  // Form C: OS URL-scheme registration subcommands run and exit before the scan flow.
  if (SCHEME_COMMANDS.has(argv[0])) {
    const code = await runSchemeCommand(argv[0], argv.slice(1), process.env);
    process.exit(code);
  }

  const args = parseArgs(argv);

  if (args.help) {
    console.log(USAGE);
    process.exit(0);
  }

  // No usable input at all -> print usage and exit non-zero.
  const hasFormA = isLaunchUrl(args.launchUrl);
  const hasFormB = Boolean(args.code);
  if (!hasFormA && !hasFormB) {
    fail('No launch URL and no --code provided.');
    console.error('\n' + USAGE);
    process.exit(1);
  }

  const config = loadConfig(process.env);

  // Resolve the run parameters from whichever form was used.
  let baseUrl = config.baseUrl;
  let tokenPath = DEFAULT_TOKEN_PATH;
  let code;
  let treatmentId;
  let externalCaseId;

  if (hasFormA) {
    step('Form A: parsing launch URL');
    const payload = parseLaunchUrl(args.launchUrl);
    info('decoded launch payload (base64 JSON):\n' + JSON.stringify(payload, null, 2));
    const fields = extractFields(payload);
    code = fields.code;
    // tokenEndpoint from the payload is a PATH; effective endpoint = BASE_URL + path.
    tokenPath = fields.tokenEndpoint;
    treatmentId = fields.treatmentId;
    externalCaseId = fields.externalCaseId;
    info(`code=${code}`);
    info(`tokenEndpoint (path)=${tokenPath}`);
    info(`treatmentId=${treatmentId}`);
    info(`externalCaseId=${externalCaseId}`);
  } else {
    step('Form B: using explicit flags');
    code = args.code;
    if (args.baseUrlOverride) {
      baseUrl = normalizeBaseUrl(args.baseUrlOverride);
    }
    tokenPath = DEFAULT_TOKEN_PATH;
    treatmentId = args.treatmentId ?? null;
    externalCaseId = args.treatmentId ?? null;
    info(`code=${code}`);
    info(`baseUrl=${baseUrl}`);
    info(`treatmentId=${treatmentId ?? '(none)'}`);
  }

  info(`Effective token endpoint = ${baseUrl}${tokenPath.startsWith('/') ? '' : '/'}${tokenPath}`);

  // 1) Exchange the code for tokens.
  let tokens = await exchangeCodeForTokens({
    baseUrl,
    tokenPath,
    code,
    clientId: config.clientId,
    clientSecret: config.clientSecret,
  });

  // Optional: exercise the refresh endpoint.
  if (args.demoRefresh) {
    const refreshed = await refreshTokens({
      baseUrl,
      refreshToken: tokens.refresh_token,
      clientId: config.clientId,
      clientSecret: config.clientSecret,
    });
    // Use the freshly refreshed access token for the uploads.
    tokens = refreshed;
  }

  // 2) Upload the two example scans (upper + lower jaw) with live progress.
  step('Uploading example scans: upper.stl, lower.stl');
  const plan = [
    { fileName: 'upper.stl', filePath: resolve(FIXTURES_DIR, 'upper.stl'), treatmentFileType: TreatmentFileType.UpperJaw },
    { fileName: 'lower.stl', filePath: resolve(FIXTURES_DIR, 'lower.stl'), treatmentFileType: TreatmentFileType.LowerJaw },
  ];

  const results = [];
  const failures = [];

  for (const item of plan) {
    try {
      const r = await uploadFixture({
        baseUrl,
        accessToken: tokens.access_token,
        filePath: item.filePath,
        fileName: item.fileName,
        treatmentId,
        treatmentFileType: item.treatmentFileType,
        externalCaseId,
      });
      results.push(r);
    } catch (err) {
      fail(`Upload failed for ${item.fileName}: ${err.message}`);
      failures.push({ fileName: item.fileName, error: err.message });
    }
  }

  // 3) Final summary.
  console.log('\n──────── summary ────────');
  info(`uploaded: ${results.length}/${plan.length}`);
  for (const r of results) {
    ok(`${r.fileName} (treatmentFileType=${r.treatmentFileType}, ${r.fileSize} bytes)`);
  }
  for (const f of failures) {
    fail(`${f.fileName}: ${f.error}`);
  }

  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((err) => {
  fail(err && err.message ? err.message : String(err));
  process.exit(1);
});
