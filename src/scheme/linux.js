// Linux URL-scheme registrar (freedesktop, per-user).
//
// Linux delivers the scheme URL as an argument (%u) to the Exec of a .desktop file
// registered as the x-scheme-handler/<scheme> default, so the existing Form-A path
// handles it. We drop a .desktop into ~/.local/share/applications and point xdg-mime
// at it.
//
// Standard recipe; run/verify on Linux. macOS/darwin.js is the tested path.

import { writeFile, rm, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { run, runOrThrow, which } from './exec.js';

function paths(scheme) {
  const appsDir = join(homedir(), '.local', 'share', 'applications');
  const fileName = `scanpro-sim-${scheme}.desktop`;
  return { appsDir, fileName, desktopFile: join(appsDir, fileName), mime: `x-scheme-handler/${scheme}` };
}

export async function register(opts) {
  const { scheme, nodeBin, indexJs, envFile } = opts;
  const { appsDir, fileName, desktopFile, mime } = paths(scheme);

  const entry = `[Desktop Entry]
Type=Application
Name=ScanPro Simulator (${scheme})
Exec=${nodeBin} --env-file=${envFile} ${indexJs} %u
Terminal=true
NoDisplay=true
MimeType=${mime};
`;

  await mkdir(appsDir, { recursive: true });
  await writeFile(desktopFile, entry);
  if (await which('xdg-mime')) await runOrThrow('xdg-mime', ['default', fileName, mime]);
  if (await which('update-desktop-database')) await run('update-desktop-database', [appsDir]);

  const handler = await defaultHandler(mime);
  return { appPath: desktopFile, handler, isDefault: handler == null ? null : handler === fileName };
}

export async function unregister(scheme) {
  const { desktopFile, appsDir } = paths(scheme);
  const existed = existsSync(desktopFile);
  if (existed) {
    await rm(desktopFile, { force: true });
    if (await which('update-desktop-database')) await run('update-desktop-database', [appsDir]);
  }
  return { appPath: desktopFile, existed };
}

export async function status(scheme) {
  const { desktopFile, fileName, mime } = paths(scheme);
  const appExists = existsSync(desktopFile);
  const handler = await defaultHandler(mime);
  return {
    appPath: desktopFile,
    appExists,
    declaredSchemes: appExists ? [scheme] : null,
    handler,
    isDefault: handler == null ? null : handler === fileName,
  };
}

async function defaultHandler(mime) {
  if (!(await which('xdg-mime'))) return null;
  const r = await run('xdg-mime', ['query', 'default', mime]);
  const out = r.stdout.trim();
  return r.code === 0 && out ? out : null;
}
