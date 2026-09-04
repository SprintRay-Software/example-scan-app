// What these tests protect: the history leg must engage on exactly the launches that carry a case
// identity, must announce a known case BEFORE the one-time code is spent, must store a session
// only when the whole of it succeeded, and must never turn a successful send into a failed run.
//
// They stand in for a gateway. A real end-to-end write needs live SprintRay credentials and an
// unspent code, so `globalThis.fetch` is stubbed with the minimum canned responses each step of
// the flow reads — that keeps the proof automated and keeps the zero-dependency rule (no mocking
// library, just node:test).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runFlow } from '../src/core/flow.js';
import { createReporter } from '../src/core/reporter.js';
import { createHistoryStore } from '../src/history.js';

const FIXTURES_DIR = fileURLToPath(new URL('../fixtures/', import.meta.url));
const CONFIG = { baseUrl: 'https://gateway.test', apiKey: 'k', clientId: 'c', clientSecret: 's' };

function launchUrl(payload) {
  return `openScanPro://${Buffer.from(JSON.stringify(payload)).toString('base64')}`;
}

function formA({ externalCaseId = 'CASE-42', scanJobId = 'job-1' } = {}) {
  return launchUrl({
    auth: { code: 'ONE-TIME-CODE', tokenEndpoint: '/integration/device-login-token' },
    case: { ID: scanJobId },
    ...(externalCaseId === null ? {} : { externalCaseId }),
    treatmentId: 'treat-9',
    fileType: null,
  });
}

// One reporter that records the narration in order, so a test can assert not just THAT the hit was
// reported but that it was reported before the exchange phase opened.
function recordingReporter() {
  const events = [];
  const reporter = createReporter({
    info: (message) => events.push(`info: ${message}`),
    fail: (message) => events.push(`fail: ${message}`),
    phase: (name, status) => events.push(`phase: ${name}/${status}`),
  });
  return { reporter, events, find: (needle) => events.findIndex((e) => e.includes(needle)) };
}

// The gateway, reduced to what the flow actually reads off each response.
function stubGateway({ linkStatus = 200, finishStatus = 200, meshLinks = false, meshStatus = 200 } = {}) {
  const original = globalThis.fetch;
  const json = (body, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  globalThis.fetch = async (url, options = {}) => {
    const method = options.method ?? 'GET';
    if (String(url).includes('device-login-token')) {
      return json({ access_token: 'header.payload.signature', token_type: 'Bearer', expires_in: 3600 });
    }
    if (String(url).includes('integration/file/upload')) {
      if (linkStatus !== 200) return json({ message: 'nope' }, linkStatus);
      return json({ url: 'https://storage.test/presigned' });
    }
    if (method === 'PUT') {
      return new Response('', { status: String(url).includes('/mesh') ? meshStatus : 200 });
    }
    // The finish call. An empty job body means no mesh links, so the mesh batch is a no-op;
    // `meshLinks` hands back one gingiva link so a test can make that batch fail on its own.
    if (String(url).includes('integration/scan-job/complete')) {
      if (finishStatus !== 200) return json({ message: 'nope' }, finishStatus);
      return json(meshLinks ? { gingivaUploadLink: { upper: 'https://storage.test/mesh' } } : {});
    }
    throw new Error(`unexpected request: ${method} ${url}`);
  };
  return () => {
    globalThis.fetch = original;
  };
}

async function scratchStore() {
  const stateDir = await mkdtemp(join(tmpdir(), 'scanpro-flow-history-'));
  return { stateDir, history: createHistoryStore({ stateDir }) };
}

function run(reporter, input, history) {
  return runFlow(reporter, { config: CONFIG, input, fixturesDir: FIXTURES_DIR, history });
}

test('a completed send leaves exactly one entry, keyed on externalCaseId and never on case.ID', async () => {
  const restore = stubGateway();
  try {
    const { stateDir, history } = await scratchStore();
    const { reporter, events } = recordingReporter();

    const summary = await run(reporter, { launchUrl: formA() }, history);
    assert.equal(summary.ok, true);

    // case.ID is a fresh scan job on every launch — an entry stored under it could never be found
    // again, which is the whole reason the key is the case id.
    assert.deepEqual(await readdir(join(stateDir, 'history')), ['CASE-42']);

    const entry = JSON.parse(await readFile(join(stateDir, 'history', 'CASE-42', 'case.json'), 'utf8'));
    assert.equal(entry.scanJobId, 'job-1');
    assert.deepEqual(entry.files.sort(), ['lower.stl', 'upper.stl']);
    assert.equal(entry.uploads.length, 2, 'the stored facts describe what was actually sent');
    assert.ok(!('completed' in entry), 'no tautology field: an entry only exists when the finish landed');
    assert.ok(events.some((e) => e === 'info: history: recorded CASE-42 (2 file(s))'));
  } finally {
    restore();
  }
});

test('a case that was sent before is announced before the one-time code is spent', async () => {
  const restore = stubGateway();
  try {
    const { history } = await scratchStore();
    await run(recordingReporter().reporter, { launchUrl: formA() }, history);

    const { reporter, events, find } = recordingReporter();
    await run(reporter, { launchUrl: formA() }, history);

    const hit = find('history: externalCaseId CASE-42 already sent');
    const exchange = find('phase: exchange/active');
    assert.ok(hit !== -1, `expected a hit line, got:\n${events.join('\n')}`);
    // Ordering is the point, not the wording: the doctor must read "you already sent this" while
    // the code is still unspent, not after the flow has burned it.
    assert.ok(hit < exchange, 'the hit must be reported before the token exchange opens');
  } finally {
    restore();
  }
});

test('a launch with no case identity of its own keeps history out of the run entirely', async () => {
  const restore = stubGateway();
  try {
    const { stateDir, history } = await scratchStore();
    const { reporter, events } = recordingReporter();

    // No externalCaseId in the payload: extractFields falls back to case.ID, so the two ids are
    // equal. This is the legacy payload shape, and today's behaviour for it must not move.
    const summary = await run(reporter, { launchUrl: formA({ externalCaseId: null }) }, history);

    assert.equal(summary.ok, true);
    assert.equal(events.filter((e) => e.includes('history')).length, 0, 'no history narration at all');
    await assert.rejects(readdir(join(stateDir, 'history')), 'no history directory is created');
  } finally {
    restore();
  }
});

test('a case id this app cannot store under is reported with the rule it broke', async () => {
  const restore = stubGateway();
  try {
    const { stateDir, history } = await scratchStore();
    const { reporter, events } = recordingReporter();

    await run(reporter, { launchUrl: formA({ externalCaseId: '../etc/passwd' }) }, history);

    // Errors name the fix: the id is on the SprintRay side of the payload, so the message has to
    // say which rule rejected it rather than silently doing nothing.
    assert.ok(events.some((e) => e.includes('not tracking externalCaseId "../etc/passwd"') && e.includes('^[A-Za-z0-9]')));
    await assert.rejects(readdir(join(stateDir, 'history')));
  } finally {
    restore();
  }
});

test('a run with a failed upload stores nothing — a partial scan must never read as already sent', async () => {
  const restore = stubGateway({ linkStatus: 500 });
  try {
    const { stateDir, history } = await scratchStore();
    const summary = await run(recordingReporter().reporter, { launchUrl: formA() }, history);

    assert.equal(summary.ok, false);
    await assert.rejects(readdir(join(stateDir, 'history')));
  } finally {
    restore();
  }
});

test('a failed finish call stores nothing — an entry claims "sent", and a send includes the finish', async () => {
  const restore = stubGateway({ finishStatus: 500 });
  try {
    const { stateDir, history } = await scratchStore();
    const summary = await run(recordingReporter().reporter, { launchUrl: formA() }, history);

    // The scans are up, but SprintRay has no completed scan job, so the doctor's case has nothing
    // to open. An entry here would make the next launch announce a hit that contradicts what the
    // web app shows — the one surface the stored scan exists to serve.
    assert.equal(summary.ok, false);
    await assert.rejects(readdir(join(stateDir, 'history')));
  } finally {
    restore();
  }
});

test('a failed mesh PUT still stores the case — the meshes are metadata, the scan is whole', async () => {
  const restore = stubGateway({ meshLinks: true, meshStatus: 500 });
  try {
    const { stateDir, history } = await scratchStore();
    const summary = await run(recordingReporter().reporter, { launchUrl: formA() }, history);

    // Up to 34 links make this the flakiest step in the run, and nothing is called after a mesh
    // PUT. Gating the entry on them would make the stored scan miss in exactly the case it is for.
    assert.equal(summary.ok, false, 'the run still reports the mesh failure');
    assert.deepEqual(await readdir(join(stateDir, 'history')), ['CASE-42']);
  } finally {
    restore();
  }
});

test('a history write failure is loud but never fails a run whose scans are already up', async () => {
  const restore = stubGateway();
  try {
    const { reporter, events } = recordingReporter();
    const brokenStore = {
      lookup: async () => null,
      record: async () => {
        throw new Error('disk is full');
      },
    };

    const summary = await run(reporter, { launchUrl: formA() }, brokenStore);

    // The uploads landed on SprintRay's side before this ran. Local bookkeeping cannot retract
    // them, so it must not change the verdict the caller exits on.
    assert.equal(summary.ok, true);
    assert.deepEqual(summary.failures, []);
    assert.ok(events.includes('fail: history: write failed — disk is full'));
  } finally {
    restore();
  }
});
