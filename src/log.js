// Minimal timestamped step logger. No dependencies.

function ts() {
  return new Date().toISOString();
}

export function step(msg, ...rest) {
  console.log(`[${ts()}] → ${msg}`, ...rest);
}

export function ok(msg, ...rest) {
  console.log(`[${ts()}] ✓ ${msg}`, ...rest);
}

export function fail(msg, ...rest) {
  console.error(`[${ts()}] ✗ ${msg}`, ...rest);
}

export function info(msg, ...rest) {
  console.log(`[${ts()}]   ${msg}`, ...rest);
}
