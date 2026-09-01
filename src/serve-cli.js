// `serve` — run the ScanPro local HTTP service headlessly, without Electron.
//
// This is the faithful shape of the real deployment: the resident service is a separate
// process from ScanPro, and its /start *launches* the app. Here /start hands the payload to
// the OS handler for the URL scheme, so whatever `register` (or a packaged build) claimed
// that scheme is what starts up — the same route the browser's deep link takes.
//
// It is also the quicker way to see what the web side sees: probe the port range, inspect the
// CORS headers, watch the payload arrive. Add --run-flow to handle the payload in-process
// instead of launching anything — exchange the code and upload a scan before answering.

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { loadConfig, loadLocalServerConfig, packageVersion } from './config.js';
import { fail, info, ok, step } from './log.js';
import { runFlow } from './core/flow.js';
import { createConsoleReporter } from './core/console-reporter.js';
import { startScanProLocalServer, summarizeArgument } from './local-server/index.js';
import { reportScannerConnectedOnLaunch } from './telemetry.js';
import { schemeStatus } from './scheme/index.js';
import { openWithOsHandler, waitForApplication } from './scheme/open.js';

const SIM_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES_DIR = resolve(SIM_DIR, 'fixtures');

export const SERVE_COMMANDS = new Set(['serve']);

export const SERVE_USAGE = `Run the ScanPro local HTTP service (loopback only):
    node --env-file-if-exists=.env src/index.js serve [options]

  serve options:
    --port-start <n>       first port to try (default 29083, or $SCANPRO_LOCAL_SERVER_PORT_START)
    --port-end <n>         last port to try  (default 29183, or $SCANPRO_LOCAL_SERVER_PORT_END)
    --version <v>          version string /status reports (default: this package's version)
    --scheme <s>           URL scheme whose OS handler /start launches
                           (default $SCANPRO_URL_SCHEME, else openScanPro)
    --not-installed        report installed=false, to exercise the web side's "not installed" path
    --running              report running=true before any /start call
    --run-flow             handle /start in-process (exchange + upload) instead of launching
                           the desktop app
    --allow-any-host       skip the loopback Host check (DNS-rebinding guard)
    -h, --help             show this help`;

function parseServeArgs(argv) {
  const out = {
    portStart: null,
    portEnd: null,
    version: null,
    scheme: null,
    installed: true,
    running: false,
    runFlow: false,
    allowAnyHost: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') out.help = true;
    else if (a === '--scheme') out.scheme = argv[++i];
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

  // The scheme whose OS handler /start launches — the stand-in for "the installed ScanPro".
  const scheme = (args.scheme ?? env.SCANPRO_URL_SCHEME ?? 'openScanPro').trim();

  // Which app the OS would launch for the scheme — the stand-in for "is ScanPro installed".
  // Cached, because the lookup shells out (~0.4 s on macOS) and a caller probing the port
  // range hits /status up to 101 times. Refreshed around a launch, where the cost is hidden
  // by an already-blocking call.
  let handlerPath = null;

  // The macOS lookup shells out to `swift`, which can take seconds on a cold toolchain, so it
  // is capped and never runs before the port is bound — the web app probing for this service
  // must not be kept waiting on a scheme lookup.
  const HANDLER_LOOKUP_TIMEOUT_MS = 15_000;

  async function refreshHandler() {
    if (args.runFlow) {
      handlerPath = 'in-process';
      return handlerPath;
    }
    try {
      const st = await Promise.race([
        schemeStatus(scheme),
        new Promise((resolveRace) => setTimeout(() => resolveRace(null), HANDLER_LOOKUP_TIMEOUT_MS)),
      ]);
      // `handler` is what LaunchServices/the registry actually resolves, which also covers an
      // installed packaged build. `appExists` only ever sees a handler made by `register`.
      handlerPath = st ? st.handler || (st.appExists ? st.appPath : null) : null;
    } catch {
      handlerPath = null; // scheme lookup unsupported on this platform
    }
    return handlerPath;
  }

  // ScanPro's own state, as this simulator models it. `running` flips once a start succeeds,
  // which is what a caller polling /status after a start would expect to see.
  const state = { installed: args.installed, running: args.running, version: options.reportedVersion };

  const service = {
    getStatus: () => ({ ...state, installed: args.installed && Boolean(handlerPath) }),

    async start({ argument, decoded }) {
      step(`/start received — ${summarizeArgument(decoded)}`);
      info('decoded argument:\n' + JSON.stringify(decoded, null, 2));

      if (!args.installed) {
        fail('ScanPro is reported as not installed — refusing to start');
        return { started: false, errorCode: 'NOT_INSTALLED', message: 'ScanPro is not installed' };
      }

      if (!args.runFlow) {
        // Launch the desktop app through the OS handler for the scheme. The launch is always
        // attempted and the OS is the judge — a cached "no handler" must not turn into a
        // refusal to even try. Answering `true` without launching anything is exactly the
        // failure that reads as "the API succeeded but nothing opened".
        step(`launching ${scheme}:// handler`);
        const result = await openWithOsHandler(`${scheme}://${argument}`);

        if (!result.ok) {
          await refreshHandler();
          const noHandler = !handlerPath || /unable to find application|no application/i.test(result.error);
          fail(`launch failed: ${result.error}`);
          return {
            started: false,
            errorCode: noHandler ? 'NO_HANDLER_REGISTERED' : 'LAUNCH_FAILED',
            message: noHandler
              ? `no application is registered for ${scheme}:// — install a packaged build or ` +
                `run \`npm run register\`, or use --run-flow to handle the payload in-process`
              : result.error,
          };
        }

        // The launcher accepted the request; confirm something is actually running before
        // telling the caller the app started.
        const confirmed = await waitForApplication(handlerPath);
        if (confirmed === false) {
          fail(`${scheme}:// handler did not come up: ${handlerPath}`);
          return {
            started: false,
            errorCode: 'LAUNCH_NOT_CONFIRMED',
            message:
              `the OS accepted the launch but no process for ${handlerPath} is running — ` +
              'the scheme is most likely bound to a stale handler; re-register it or ' +
              'reinstall the app',
          };
        }

        state.running = true;
        ok(
          `ScanPro launched via the ${scheme}:// handler${handlerPath ? ` (${handlerPath})` : ''}` +
            (confirmed === null ? ' — could not verify the process on this platform' : '')
        );
        return { started: true };
      }

      state.running = true;

      // Without --run-flow the launch is handed to the OS handler above, and whatever starts up
      // reports its own scanner.connected. Here the payload is handled in-process, so this is
      // the launch and this is where the event comes from.
      reportScannerConnectedOnLaunch({
        env,
        defaults: { appVersion: options.reportedVersion, installPath: SIM_DIR },
        log: info,
      });

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
  info(`reporting running=${state.running} version=${state.version}`);
  info(
    options.allowedOrigins
      ? `CORS allowlist: ${options.allowedOrigins.join(', ')}`
      : 'CORS: echoing any Origin (set SCANPRO_LOCAL_SERVER_ORIGINS to restrict)'
  );

  // Resolve what /start would launch, without holding up the service.
  refreshHandler().then(() => {
    if (args.runFlow) {
      info('/start handles the payload in-process (--run-flow): exchange + upload, no app launch');
    } else if (handlerPath) {
      info(`/start launches the ${scheme}:// handler — ${handlerPath}`);
    } else {
      fail(
        `nothing is registered for ${scheme}:// — /start will try anyway and report the OS error. ` +
          'Install a packaged build or run `npm run register`.'
      );
    }
  });

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
