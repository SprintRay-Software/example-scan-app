// Fetching the update package, two ways.
//
//   real       streams `package.url` to disk, computing the MD5 on the way through — the file is
//              2.1 GB, so it is never held in memory and never read twice just to hash it.
//   simulated  no network at all: pretends to receive `simulatedSizeBytes` at a set speed, then
//              writes a small placeholder file so there is still a package on disk to persist,
//              re-verify and delete. The default for demos, since the real installer is 2.1 GB.
//
// Both report progress through `checkpoint(percent)`, which is also where the controller injects
// stalls and forced failures — so a fault behaves the same whichever way the bytes arrive.

import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { rename, rm, statfs, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { once } from 'node:events';

import { OtaAborted, OtaFailure } from './errors.js';

const MB = 1024 * 1024;
const TICK_MS = 200;

export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new OtaAborted());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(new OtaAborted());
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** MD5 of a file on disk, streamed. */
export async function md5File(path) {
  const hash = createHash('md5');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

// Free bytes on the volume holding `dir`, or null when the platform cannot say.
async function freeBytes(dir) {
  try {
    const s = await statfs(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

function insufficientSpace(needed, free) {
  return new OtaFailure(
    'E_INSUFFICIENT_DISK_SPACE',
    `not enough disk space for the package: needs ${Math.ceil(needed / MB)} MB, ${Math.floor(free / MB)} MB free`
  );
}

const percentOf = (received, total) => (total ? Math.min(100, Math.floor((received / total) * 100)) : null);

/**
 * Stream `url` into `dest`.
 * @returns {Promise<{ size: number, md5: string }>}
 */
export async function realDownload({ url, dest, signal, bytesPerSec = 0, checkpoint }) {
  const part = `${dest}.part`;
  let res;
  try {
    res = await fetch(url, { signal, redirect: 'follow' });
  } catch (err) {
    if (signal?.aborted) throw new OtaAborted();
    throw new OtaFailure('E_DOWNLOAD_FAILED', `could not reach ${url}: ${err.cause?.code ?? err.message}`);
  }
  if (!res.ok || !res.body) {
    throw new OtaFailure('E_DOWNLOAD_FAILED', `package download answered HTTP ${res.status}`);
  }

  const total = Number.parseInt(res.headers.get('content-length') ?? '', 10) || null;
  if (total) {
    const free = await freeBytes(dirname(dest));
    if (free !== null && free < total) throw insufficientSpace(total, free);
  }

  const hash = createHash('md5');
  const out = createWriteStream(part);
  // Without a listener a write error (disk full, or a write racing an abort) would be an uncaught
  // 'error' event that takes the whole service down; it is recorded and rethrown in the loop instead.
  let writeError = null;
  out.on('error', (err) => {
    writeError = err;
  });
  let received = 0;
  let lastPercent = -1;
  const startedAt = Date.now();

  try {
    await checkpoint(percentOf(0, total));
    for await (const chunk of res.body) {
      if (signal?.aborted) throw new OtaAborted();
      if (writeError) throw writeError;
      hash.update(chunk);
      if (!out.write(chunk)) await once(out, 'drain');
      received += chunk.length;

      const percent = percentOf(received, total);
      if (percent !== lastPercent) {
        lastPercent = percent;
        await checkpoint(percent);
      }
      // Throttle: hold back until the elapsed time matches the configured speed, so a QA run can
      // watch a small local file download as slowly as a 2.1 GB one over a clinic's line.
      if (bytesPerSec > 0) {
        const due = (received / bytesPerSec) * 1000 - (Date.now() - startedAt);
        if (due > 0) await sleep(due, signal);
      }
    }
    if (writeError) throw writeError;
    out.end();
    await once(out, 'finish');
  } catch (err) {
    out.destroy();
    await rm(part, { force: true });
    if (err instanceof OtaFailure || err instanceof OtaAborted) throw err;
    if (signal?.aborted) throw new OtaAborted();
    if (err.code === 'ENOSPC') throw insufficientSpace(total ?? received, (await freeBytes(dirname(dest))) ?? 0);
    throw new OtaFailure('E_DOWNLOAD_FAILED', `package download broke off after ${received} bytes: ${err.message}`);
  }

  if (total && received !== total) {
    await rm(part, { force: true });
    throw new OtaFailure('E_DOWNLOAD_FAILED', `package download ended at ${received} of ${total} bytes`);
  }
  await rename(part, dest);
  return { size: received, md5: hash.digest('hex') };
}

/**
 * Pretend to download `sizeBytes` at `bytesPerSec`, then leave a placeholder file at `dest`.
 * @returns {Promise<{ size: number, md5: string, simulated: true }>}
 */
export async function simulatedDownload({ url, version, dest, signal, sizeBytes, bytesPerSec, checkpoint }) {
  const total = Math.max(1, sizeBytes);
  const perTick = Math.max(1, (bytesPerSec || total) * (TICK_MS / 1000));
  let received = 0;
  let lastPercent = -1;

  await checkpoint(0);
  while (received < total) {
    await sleep(TICK_MS, signal);
    received = Math.min(total, received + perTick);
    const percent = percentOf(received, total);
    if (percent !== lastPercent) {
      lastPercent = percent;
      await checkpoint(percent);
    }
  }

  // The placeholder's bytes are what install re-verifies against, so tampering with or deleting
  // it between download and install is still caught, as it would be with a real installer.
  const body = `ScanPro OTA simulator placeholder\nurl: ${url}\nversion: ${version}\npretended size: ${total}\n`;
  await writeFile(dest, body, 'utf8');
  return { size: total, md5: createHash('md5').update(body).digest('hex'), simulated: true };
}
