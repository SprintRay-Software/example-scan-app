// Windows URL-scheme registrar (per-user, HKCU — no admin needed).
//
// Windows delivers the scheme URL as a command-line argument (%1), so the handler
// command just runs `node --env-file=<env> src/index.js "%1"` and the existing
// Form-A launch-URL path handles it. Registration is a few HKCU\Software\Classes keys.
//
// Standard recipe; run/verify on Windows. macOS/darwin.js is the tested path.

import { run, runOrThrow } from './exec.js';

function classKey(scheme) {
  return `HKCU\\Software\\Classes\\${scheme}`;
}

/** The command Windows runs for the scheme; %1 is the full URL. */
function command({ nodeBin, indexJs, envFile }) {
  return `"${nodeBin}" "--env-file=${envFile}" "${indexJs}" "%1"`;
}

export async function register(opts) {
  const { scheme, nodeBin, indexJs, envFile } = opts;
  const key = classKey(scheme);

  await runOrThrow('reg', ['add', key, '/ve', '/d', `URL:${scheme}`, '/f']);
  await runOrThrow('reg', ['add', key, '/v', 'URL Protocol', '/d', '', '/f']);
  await runOrThrow('reg', ['add', `${key}\\shell\\open\\command`, '/ve', '/d', command({ nodeBin, indexJs, envFile }), '/f']);

  return { appPath: key, handler: key, isDefault: true };
}

export async function unregister(scheme) {
  const key = classKey(scheme);
  const r = await run('reg', ['query', key]);
  const existed = r.code === 0;
  if (existed) await runOrThrow('reg', ['delete', key, '/f']);
  return { appPath: key, existed };
}

export async function status(scheme) {
  const key = classKey(scheme);
  const r = await run('reg', ['query', `${key}\\shell\\open\\command`]);
  const appExists = r.code === 0;
  const handler = appExists ? r.stdout.trim() : null;
  return { appPath: key, appExists, declaredSchemes: appExists ? [scheme] : null, handler, isDefault: appExists };
}
