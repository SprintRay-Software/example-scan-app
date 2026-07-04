// Tiny promisified process runner used by the scheme registrars.
// Uses node:child_process spawn (built-in) with an args array — no shell, so
// values (paths, JSON, URLs) never need shell-escaping. Zero dependencies.

import { spawn } from 'node:child_process';

/**
 * Run a command and resolve with { code, stdout, stderr }. Never rejects on a
 * non-zero exit — only on spawn failure (e.g. binary not found).
 * @param {string} cmd
 * @param {string[]} [args]
 * @param {{ input?: string, cwd?: string }} [opts]
 */
export function run(cmd, args = [], opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    if (opts.input != null) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}

/** Run a command, throwing a clear error if it exits non-zero. */
export async function runOrThrow(cmd, args = [], opts = {}) {
  let r;
  try {
    r = await run(cmd, args, opts);
  } catch (err) {
    throw new Error(`failed to run ${cmd}: ${err.message}`);
  }
  if (r.code !== 0) {
    const detail = (r.stderr || r.stdout || '').trim();
    throw new Error(`${cmd} ${args.join(' ')} exited ${r.code}${detail ? ` — ${detail}` : ''}`);
  }
  return r;
}

/** True if a command is resolvable on PATH. */
export async function which(cmd) {
  try {
    const r = await run(process.platform === 'win32' ? 'where' : 'which', [cmd]);
    return r.code === 0 && r.stdout.trim() !== '';
  } catch {
    return false;
  }
}
