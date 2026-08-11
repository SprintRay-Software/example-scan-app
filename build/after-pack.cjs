// Ad-hoc sign the macOS bundle after packing.
//
// These builds are not signed with a Developer ID, and electron-builder then leaves the
// bundle carrying the signature that came with the prebuilt Electron binary. Renaming the
// app and rewriting Info.plist and Resources invalidates it:
//
//   Identifier=Electron  Signature=adhoc  Info.plist=not bound
//   codesign --verify -> "code has no resources but signature indicates they must be present"
//
// A broken signature is worse than none on Apple silicon: launching the binary straight from
// a terminal still works, but LaunchServices refuses it — so double-clicking in Finder, the
// URL scheme, and the local service's /start all silently fail to start anything. Re-signing
// ad-hoc gives the bundle a valid signature for its actual contents. It is still unsigned as
// far as Gatekeeper is concerned (the first launch needs right-click > Open, or clearing the
// quarantine attribute), but it does launch.

const { execFile } = require('node:child_process');
const { join } = require('node:path');
const { promisify } = require('node:util');

const run = promisify(execFile);

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const appPath = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);

  // --deep is the pragmatic choice for an ad-hoc signature: it covers the Electron helper
  // bundles and frameworks in one pass, and there is no identity or entitlement to get wrong.
  await run('codesign', ['--force', '--deep', '--sign', '-', appPath]);
  await run('codesign', ['--verify', '--deep', '--strict', appPath]);

  console.log(`  • ad-hoc signed and verified  ${appPath}`);
};
