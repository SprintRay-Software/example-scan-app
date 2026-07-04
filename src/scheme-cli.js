// CLI surface for the OS URL-scheme subcommands: register / unregister / status.
// These make the simulator a REAL desktop app from the OS's point of view: after
// `register`, clicking "OR Scan" in the browser (which sets window.location to
// `<scheme>://<base64>`) launches this simulator with that URL — no copy-paste.

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';

import { step, ok, fail, info } from './log.js';
import { registerScheme, unregisterScheme, schemeStatus, platformName } from './scheme/index.js';

const SELF = fileURLToPath(import.meta.url); // .../src/scheme-cli.js
const SIM_DIR = resolve(dirname(SELF), '..'); // simulator root (holds package.json)
const INDEX_JS = resolve(dirname(SELF), 'index.js');

// RFC-3986 scheme grammar: ALPHA *( ALPHA / DIGIT / "+" / "-" / "." ).
const VALID_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*$/;

export const SCHEME_COMMANDS = new Set(['register', 'unregister', 'status']);

function parseSchemeArgs(argv) {
  const out = { scheme: null, envFile: null, headless: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--scheme') out.scheme = argv[++i];
    else if (a === '--env-file') out.envFile = argv[++i];
    else if (a === '--headless') out.headless = true;
  }
  return out;
}

// The scheme is data, not code: it comes from --scheme (per-run override) or the
// SCANPRO_URL_SCHEME env var (loaded from .env). Nothing is hardcoded.
function resolveScheme(cliScheme, env) {
  const raw = (cliScheme ?? (env && env.SCANPRO_URL_SCHEME) ?? '').trim();
  if (!raw) {
    throw new Error(
      'no URL scheme configured — set SCANPRO_URL_SCHEME in .env (loaded via --env-file) or pass --scheme <s>'
    );
  }
  if (!VALID_SCHEME.test(raw)) {
    throw new Error(`invalid URL scheme "${raw}" — use letters/digits/+/-/. starting with a letter, e.g. openScanPro`);
  }
  return raw;
}

function resolveEnvFile(cliEnvFile) {
  return cliEnvFile ? resolve(cliEnvFile) : resolve(SIM_DIR, '.env');
}

// A minimal, valid launch payload for a smoke test. The dummy code fails the token
// exchange (400), but reaching that proves the OS launched the simulator.
function sampleLaunchUrl(scheme) {
  const zeroGuid = '00000000-0000-0000-0000-000000000000';
  const payload = {
    caller: { name: 'scanpro-sim-smoketest', version: '0' },
    case: { ID: zeroGuid },
    auth: { code: 'SMOKETEST-INVALID', tokenEndpoint: '/api/integration/device-login-token', expiresIn: 600 },
    treatmentId: zeroGuid,
  };
  return `${scheme}://${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')}`;
}

function openerFor(platform) {
  if (platform === 'darwin') return 'open';
  if (platform === 'win32') return 'start';
  return 'xdg-open';
}

async function doRegister(argv, env) {
  const a = parseSchemeArgs(argv);
  const scheme = resolveScheme(a.scheme, env);
  const envFile = resolveEnvFile(a.envFile);
  const platform = platformName();

  step(`Registering OS URL scheme "${scheme}://" on ${platform}`);
  info(`simulator dir = ${SIM_DIR}`);
  info(`env file      = ${envFile}`);
  if (!existsSync(envFile)) {
    info(`⚠ env file not found — create it (cp .env.example .env) and re-run register`);
  }
  if (platform === 'darwin') {
    info(a.headless ? 'mode = headless (logs to a file)' : 'mode = Terminal window');
  }

  const res = await registerScheme({ scheme, simDir: SIM_DIR, indexJs: INDEX_JS, envFile, headless: a.headless });

  ok(`Registered handler at ${res.appPath}`);
  if (res.handler) {
    if (res.isDefault) ok(`OS default handler for "${scheme}://" is now this app`);
    else info(`current default handler for "${scheme}://" = ${res.handler}`);
  }
  if (res.logFile) info(`handler logs → ${res.logFile}`);
  if (platform === 'darwin') {
    info('A self-contained snapshot (src + fixtures + .env) is bundled inside the app —');
    info('re-run register after editing code or .env, else the scan uses the old snapshot.');
    if (res.bundledEnv === false) {
      info('⚠ no .env was bundled — the scan will fail at token exchange until you add .env and re-register.');
    }
    if (!a.headless) {
      info('First scan prompts "…wants to control Terminal" — click OK (needed to show the run).');
      info('Prefer no prompt? Re-run with --headless (output goes to the log file above).');
    }
  }
  const opener = openerFor(platform);
  info('Smoke test (dummy code — proves the OS launches the simulator; token exchange will 400):');
  info(`  ${opener} "${sampleLaunchUrl(scheme)}"`);
  return 0;
}

async function doUnregister(argv, env) {
  const a = parseSchemeArgs(argv);
  const scheme = resolveScheme(a.scheme, env);
  step(`Unregistering OS URL scheme "${scheme}://"`);
  const res = await unregisterScheme(scheme);
  if (res.existed) ok(`Removed handler at ${res.appPath}`);
  else info(`Nothing to remove — no handler at ${res.appPath}`);
  return 0;
}

async function doStatus(argv, env) {
  const a = parseSchemeArgs(argv);
  const scheme = resolveScheme(a.scheme, env);
  step(`Status of OS URL scheme "${scheme}://" on ${platformName()}`);
  const s = await schemeStatus(scheme);
  info(`handler app present: ${s.appExists ? 'yes' : 'no'} (${s.appPath})`);
  if (s.declaredSchemes) info(`declared schemes: ${s.declaredSchemes.join(', ')}`);
  if (s.handler) info(`OS default handler: ${s.handler}`);
  else info('OS default handler: (unknown / not registered)');
  if (s.isDefault === true) ok(`"${scheme}://" resolves to this simulator`);
  else if (s.isDefault === false) info(`"${scheme}://" currently resolves elsewhere — run "register" to claim it`);
  return 0;
}

/**
 * Run a scheme subcommand. Returns a process exit code.
 * @param {'register'|'unregister'|'status'} cmd
 * @param {string[]} argv  args AFTER the subcommand
 * @param {NodeJS.ProcessEnv} env
 */
export async function runSchemeCommand(cmd, argv, env) {
  try {
    if (cmd === 'register') return await doRegister(argv, env);
    if (cmd === 'unregister') return await doUnregister(argv, env);
    if (cmd === 'status') return await doStatus(argv, env);
    fail(`unknown scheme command: ${cmd}`);
    return 1;
  } catch (err) {
    fail(err && err.message ? err.message : String(err));
    return 1;
  }
}
