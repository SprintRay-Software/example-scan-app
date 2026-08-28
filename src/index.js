#!/usr/bin/env node
// ScanPro desktop-app simulator.
// Simulates the desktop half of the device-login + scan-upload flow so a developer
// can test the Design-Service backend end to end.
//
// Invocation forms:
//   A) node src/index.js "openScanPro://<base64_json>"          (handle a launch URL)
//   B) node src/index.js --code <c> --base-url <u> [--treatment-id <guid>]
//   C) node src/index.js register|unregister|status [--scheme <s>] [--env-file <p>] [--headless]
//   D) node src/index.js serve [--port-start <n>] [--run-flow] ...
//
// Forms A/B run the device-login + upload flow. Form C registers this simulator as the
// OS handler for the scanner's URL scheme, so the browser can launch it for real. Form D
// runs the local HTTP service the web app probes on 127.0.0.1 (the other launch transport).
//
// Optional (A/B): --demo-refresh  (also exercises the token refresh endpoint), plus the
//   scan-report flags below (--scan-mode / --missing-teeth / --segmented-teeth / --no-metadata).
//
// Env (via `node --env-file=.env`): SCANPRO_BASE_URL, SCANPRO_API_KEY, SCANPRO_CLIENT_ID,
//   SCANPRO_CLIENT_SECRET, and optional SCANPRO_URL_SCHEME (default scheme for `register`).

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { loadConfig } from './config.js';
import { parseTeethList } from './scan-report.js';
import { fail } from './log.js';
import { runFlow } from './core/flow.js';
import { createConsoleReporter } from './core/console-reporter.js';
import { SCHEME_COMMANDS, runSchemeCommand } from './scheme-cli.js';
import { SERVE_COMMANDS, SERVE_USAGE, runServeCommand } from './serve-cli.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = resolve(__dirname, '..', 'fixtures');

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

  Form D (run the local HTTP service on 127.0.0.1 that the web app probes —
          the second launch transport, alongside the URL scheme):
${SERVE_USAGE.split('\n').slice(1).join('\n')}

Options:
    --code <code>          device-login code to exchange (Form B)
    --base-url <url>       override SCANPRO_BASE_URL for this run (Form B)
    --treatment-id <guid>  treatmentId to attach uploads to (Form B)
    --upper-file <p>       scan to send as FileType 1 (default fixtures/upper.stl)
    --lower-file <p>       scan to send as FileType 2 (default fixtures/lower.stl)
    --demo-refresh         also call the token refresh endpoint after exchange
    --scheme <s>           override the URL scheme for register/status/unregister
                           (else read from $SCANPRO_URL_SCHEME in .env)
    --env-file <p>         env file the registered handler loads (default: ./.env)
    --headless             (macOS register) run headless to a log file instead of a Terminal window
    -h, --help             show this help

  Scan report — what the finish call tells SprintRay the session captured. Every field is
  optional on the wire; these flags override what this app derives from the arches it uploaded:
    --scan-mode <name>     your own mode name (default $SCANPRO_SCAN_MODE or quickScan)
    --missing-teeth <list> universal tooth numbers not there, e.g. 1,16 (default none)
    --segmented-teeth <l>  universal tooth numbers you segmented, or "none"
                           (default: every tooth of the captured arches that is not missing)
    --no-metadata          report nothing: finish the session the pre-metadata way
    --upper-scan-type <n>  externalScanFileType for the upper file (default UpperArch)
    --lower-scan-type <n>  externalScanFileType for the lower file (default LowerArch)
    --tooth-file <p>       mesh PUT for each segmented tooth (default fixtures/tooth.ply)
    --gingiva-file <p>     mesh PUT for each gingiva link (default fixtures/gingiva.ply)

  Uploads run concurrently — the scans of a full-mouth session together, and the meshes the
  finish call unlocks in batches. Each file still narrates as one block, in file order:
    --concurrency <n>      files uploaded at once (default $SCANPRO_UPLOAD_CONCURRENCY or 4)

Environment (loaded via --env-file=.env):
    SCANPRO_BASE_URL       SprintRay API-gateway origin, e.g. https://apx.sprintray.com
    SCANPRO_API_KEY        gateway API key, sent as x-api-key on every SprintRay call
    SCANPRO_CLIENT_ID, SCANPRO_CLIENT_SECRET
    SCANPRO_URL_SCHEME     (optional)
    SCANPRO_SCAN_MODE, SCANPRO_SCAN_FILE_TYPE_UPPER, SCANPRO_SCAN_FILE_TYPE_LOWER
                           (optional) your own scan vocabulary — the names SprintRay registers
                           for your integration and an admin maps once
    SCANPRO_UPLOAD_CONCURRENCY
                           (optional) files uploaded at once, default 4
`;

// Very small flag parser — no dependencies.
function parseArgs(argv) {
  const args = {
    launchUrl: null,
    code: null,
    baseUrlOverride: null,
    treatmentId: null,
    upperFile: null,
    lowerFile: null,
    demoRefresh: false,
    scanMode: null,
    missingTeeth: null,
    segmentedTeeth: null,
    noMetadata: false,
    upperScanType: null,
    lowerScanType: null,
    toothFile: null,
    gingivaFile: null,
    concurrency: null,
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
      case '--upper-file':
        args.upperFile = argv[++i];
        break;
      case '--lower-file':
        args.lowerFile = argv[++i];
        break;
      case '--demo-refresh':
        args.demoRefresh = true;
        break;
      case '--scan-mode':
        args.scanMode = argv[++i];
        break;
      case '--missing-teeth':
        args.missingTeeth = parseTeethList(argv[++i], '--missing-teeth');
        break;
      case '--segmented-teeth': {
        const raw = argv[++i];
        // `none` is not the same as omitting the flag: it reports zero segmented teeth, so no
        // tooth links come back — the way a mode that segments nothing behaves.
        args.segmentedTeeth =
          String(raw ?? '').trim().toLowerCase() === 'none' ? [] : parseTeethList(raw, '--segmented-teeth');
        break;
      }
      case '--no-metadata':
        args.noMetadata = true;
        break;
      case '--upper-scan-type':
        args.upperScanType = argv[++i];
        break;
      case '--lower-scan-type':
        args.lowerScanType = argv[++i];
        break;
      case '--tooth-file':
        args.toothFile = argv[++i];
        break;
      case '--gingiva-file':
        args.gingivaFile = argv[++i];
        break;
      case '--concurrency':
        args.concurrency = argv[++i];
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

  // Form D: the local HTTP service. Runs until interrupted.
  if (SERVE_COMMANDS.has(argv[0])) {
    const code = await runServeCommand(argv.slice(1), process.env);
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
  const reporter = createConsoleReporter();

  // Both forms accept the same per-arch file overrides and the same scan-report overrides.
  // (Form B has no scan session, so its report is never sent — see runFlow.)
  const files = {
    upperFileOverride: args.upperFile,
    lowerFileOverride: args.lowerFile,
    toothFileOverride: args.toothFile,
    gingivaFileOverride: args.gingivaFile,
  };
  const report = {
    scanMode: args.scanMode,
    missingTeeth: args.missingTeeth,
    segmentedTeeth: args.segmentedTeeth,
    noMetadata: args.noMetadata,
    upperScanFileType: args.upperScanType,
    lowerScanFileType: args.lowerScanType,
  };
  // Per-run overrides that belong to neither set: how many files go up at once.
  const run = { concurrency: args.concurrency };
  const input = hasFormA
    ? { launchUrl: args.launchUrl, demoRefresh: args.demoRefresh, ...files, ...report, ...run }
    : {
        code: args.code,
        baseUrlOverride: args.baseUrlOverride,
        treatmentId: args.treatmentId,
        demoRefresh: args.demoRefresh,
        ...files,
        ...report,
        ...run,
      };

  const summary = await runFlow(reporter, { config, input, fixturesDir: FIXTURES_DIR });
  process.exit(summary.ok ? 0 : 1);
}

main().catch((err) => {
  fail(err && err.message ? err.message : String(err));
  process.exit(1);
});
