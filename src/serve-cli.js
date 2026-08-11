// `serve` — run the ScanPro local HTTP service headlessly, without Electron.
//
// The Electron app also serves these endpoints (there the app itself plays ScanPro), but a
// terminal is the quicker way to check what the web side sees: probe the port range, inspect
// the CORS headers, and watch the launch payload arrive. Add --run-flow to make /start do the
// whole job — exchange the code and upload a scan — so the endpoint blocks exactly as the
// contract says it does, until the work is finished.

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync } from 'node:fs';

import { loadConfig, loadLocalServerConfig } from './config.js';
import { fail, info, ok, step } from './log.js';
import { runFlow } from './core/flow.js';
import { createConsoleReporter } from './core/console-reporter.js';
import { startScanProLocalServer, summarizeArgument } from './local-server/index.js';

const SIM_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES_DIR = resolve(SIM_DIR, 'fixtures');

// The version /status reports by default — this app stands in for ScanPro, so it reports its own.
function packageVersion() {
  try {
    return JSON.parse(readFileSync(resolve(SIM_DIR, 'package.json'), 'utf8')).version;
  } catch {
    return undefined;
  }
}

export const SERVE_COMMANDS = new Set(['serve']);

export const SERVE_USAGE = `Run the ScanPro local HTTP service (loopback only):
    node --env-file-if-exists=.env src/index.js serve [options]

  serve options:
    --port-start <n>       first port to try (default 29083, or $SCANPRO_LOCAL_SERVER_PORT_START)
    --port-end <n>         last port to try  (default 29183, or $SCANPRO_LOCAL_SERVER_PORT_END)
    --version <v>          version string /status reports (default: this package's version)
    --not-installed        report installed=false, to exercise the web side's "not installed" path
    --running              report running=true before any /start call
    --run-flow             on /start, actually run the exchange + upload flow with the payload
    --allow-any-host       skip the loopback Host check (DNS-rebinding guard)
    -h, --help             show this help`;

function parseServeArgs(argv) {
  const out = {
    portStart: null,
    portEnd: null,
    version: null,
    installed: true,
    running: false,
    runFlow: false,
    allowAnyHost: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') out.help = true;
    else if (a === '--port-start') out.portStart = Number.parseInt(argv[++i], 10);
    else if (a === '--port-end') out.portEnd = Number.parseInt(argv[++i], 10);
    else if (a === '--version') out.version = argv[++i];
    else if (a === '--not-installed') out.installed = false;
    else if (a === '--running') out.running = true;
    else if (a === '--run-flow') out.runFlow = true;
    else if (a === '--allow-any-host') out.allowAnyHost = true;
    else throw new Error(`unknown option for serve: ${a}`);
  }
  return out;
}

/**
 * Run the service until the process is interrupted.
 * @returns {Promise<number>} an exit code; only returned when the service could not start
 */
export async function runServeCommand(argv, env = process.env) {
  const args = parseServeArgs(argv);

  if (args.help) {
    console.log(SERVE_USAGE);
    return 0;
  }

  const options = loadLocalServerConfig(env, { appVersion: packageVersion(), installPath: SIM_DIR });

  if (args.portStart) options.portRangeStart = args.portStart;
  if (args.portEnd) options.portRangeEnd = args.portEnd;
  if (args.version) options.reportedVersion = args.version;
  if (args.allowAnyHost) options.checkHost = false;

  // --run-flow needs the client credentials up front, so a missing .env fails now rather
  // than in the middle of the first /start.
  const flowConfig = args.runFlow ? loadConfig(env) : null;

  // ScanPro's own state, as this simulator models it. `running` flips on the first /start,
  // which is what a caller polling /status after a start would expect to see.
  const state = { installed: args.installed, running: args.running, version: options.reportedVersion };

  const service = {
    getStatus: () => state,

    async start({ argument, decoded }) {
      step(`/start received — ${summarizeArgument(decoded)}`);
      info('decoded argument:\n' + JSON.stringify(decoded, null, 2));

      if (!state.installed) {
        fail('ScanPro is reported as not installed — refusing to start');
        return { started: false, errorCode: 'NOT_INSTALLED', message: 'ScanPro is not installed' };
      }

      state.running = true;

      if (!args.runFlow) {
        ok('ScanPro "started" (payload accepted; pass --run-flow to also exchange + upload)');
        return { started: true };
      }

      // The contract says /start blocks until ScanPro is up or has failed. Awaiting the whole
      // flow here reproduces that: the HTTP response lands only once the upload is done.
      try {
        const summary = await runFlow(createConsoleReporter(), {
          config: flowConfig,
          input: { launchUrl: argument },
          fixturesDir: FIXTURES_DIR,
        });
        if (summary.ok) return { started: true };
        return {
          started: false,
          errorCode: 'FLOW_FAILED',
          message: summary.failures.map((f) => `${f.fileName}: ${f.error}`).join('; '),
        };
      } catch (err) {
        fail(`flow failed: ${err.message}`);
        return { started: false, errorCode: 'FLOW_ERROR', message: err.message };
      }
    },
  };

  const result = await startScanProLocalServer({ service, options, log: (msg) => info(msg) });

  if (!result.ok) {
    fail(
      `local service did not start — every port in ` +
        `${options.portRangeStart}-${options.portRangeEnd} is taken`
    );
    return 1;
  }

  ok(`local service listening on ${result.url}`);
  for (const endpoint of result.endpoints) info(endpoint);
  info(`reporting installed=${state.installed} running=${state.running} version=${state.version}`);
  info(
    options.allowedOrigins
      ? `CORS allowlist: ${options.allowedOrigins.join(', ')}`
      : 'CORS: echoing any Origin (set SCANPRO_LOCAL_SERVER_ORIGINS to restrict)'
  );
  info('press Ctrl+C to stop');

  await new Promise((resolvePromise) => {
    const shutdown = async () => {
      info('shutting down');
      await result.close();
      resolvePromise();
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });

  return 0;
}
