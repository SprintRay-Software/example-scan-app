// What these tests protect: history must engage on a case identity and only a case identity, it
// must never let payload text steer a filesystem path, and a re-sent case must leave exactly one
// stored scan. Each of those is a rule an integrator would otherwise have to infer from the code.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createHistoryStore, historyKeyFor } from '../src/history.js';

async function scratch() {
  return mkdtemp(join(tmpdir(), 'scanpro-history-'));
}

// A fixture scan to "send": the store copies bytes, so the test needs real ones.
async function scanFile(dir, fileName, body) {
  const path = join(dir, fileName);
  await writeFile(path, body);
  return { path, fileName };
}

test('historyKeyFor engages only on a case identity distinct from the session', () => {
  assert.equal(historyKeyFor({ externalCaseId: 'CASE-42', scanJobId: 'job-1' }), 'CASE-42');
  assert.equal(historyKeyFor({ externalCaseId: '  CASE-42  ', scanJobId: 'job-1' }), 'CASE-42');

  // extractFields falls back to case.ID when the payload carries no externalCaseId. Storing under
  // that would key history on a session id that never repeats, so it must disengage instead.
  assert.equal(historyKeyFor({ externalCaseId: 'job-1', scanJobId: 'job-1' }), null);

  assert.equal(historyKeyFor({ scanJobId: 'job-1' }), null);
  assert.equal(historyKeyFor({ externalCaseId: null }), null);
  assert.equal(historyKeyFor({ externalCaseId: 12345 }), null);
  assert.equal(historyKeyFor({ externalCaseId: '' }), null);
  assert.equal(historyKeyFor({ externalCaseId: '   ' }), null);
  assert.equal(historyKeyFor(undefined), null);
});

test('historyKeyFor rejects every id that could steer a path, and never throws', () => {
  for (const hostile of ['../x', '..', '.', '../../etc/passwd', 'a/b', 'a\\b', '/abs', '.hidden', 'a b', 'ü', 'x'.repeat(101)]) {
    assert.equal(historyKeyFor({ externalCaseId: hostile, scanJobId: 'job-1' }), null, hostile);
  }
  // The ceiling is 100 characters, not 99 or 101 — the boundary is the part that rots silently.
  assert.equal(historyKeyFor({ externalCaseId: 'x'.repeat(100), scanJobId: 'job-1' }), 'x'.repeat(100));
});

test('a recorded case is found again with its files and its facts', async () => {
  const dir = await scratch();
  const store = createHistoryStore({ stateDir: dir });
  const upper = await scanFile(dir, 'upper.stl', 'UPPER');

  const written = await store.record(
    { externalCaseId: 'CASE-42', scanJobId: 'job-1', scanMode: 'FULL_ARCH' },
    [upper]
  );

  assert.equal(written.key, 'CASE-42');
  assert.deepEqual(written.files, ['upper.stl']);
  assert.ok(Date.parse(written.savedAt), 'savedAt must be a real timestamp a UI can show');

  const entry = await store.lookup('CASE-42');
  // The caller's own facts survive the round trip — they are what the stored-scan view renders.
  assert.equal(entry.scanMode, 'FULL_ARCH');
  assert.equal(entry.scanJobId, 'job-1');
  assert.equal(entry.dir, join(dir, 'history', 'CASE-42'));
  assert.equal(await readFile(join(entry.dir, 'upper.stl'), 'utf8'), 'UPPER');
});

test('a case with no entry, a rejected key and a truncated entry all read as a plain miss', async () => {
  const dir = await scratch();
  const store = createHistoryStore({ stateDir: dir });

  assert.equal(await store.lookup('CASE-42'), null);
  assert.equal(await store.lookup('../etc'), null);

  // A crash between the file copies and case.json leaves exactly this. It must read as a miss so
  // the caller re-captures, never as a half-scan presented as "already sent".
  await store.record({ externalCaseId: 'CASE-42', scanJobId: 'job-1' }, []);
  await writeFile(join(dir, 'history', 'CASE-42', 'case.json'), '{ truncated');
  assert.equal(await store.lookup('CASE-42'), null);
});

test('a launch with no case identity is never written at all', async () => {
  const dir = await scratch();
  const store = createHistoryStore({ stateDir: dir });

  assert.equal(await store.record({ externalCaseId: 'job-1', scanJobId: 'job-1' }, []), null);
  await assert.rejects(readdir(join(dir, 'history')), 'no history directory should be created');
});

test('re-sending a case replaces its entry — one stored scan per case, last send wins', async () => {
  const dir = await scratch();
  const store = createHistoryStore({ stateDir: dir });
  const first = await scanFile(dir, 'upper.stl', 'FIRST');
  const second = await scanFile(dir, 'lower.stl', 'SECOND');

  await store.record({ externalCaseId: 'CASE-42', scanJobId: 'job-1' }, [first]);
  await store.record({ externalCaseId: 'CASE-42', scanJobId: 'job-2' }, [second]);

  const entry = await store.lookup('CASE-42');
  assert.equal(entry.scanJobId, 'job-2', 'the latest send owns the entry');
  assert.deepEqual(entry.files, ['lower.stl']);
  // The first send's file must be gone, not merely unlisted: an orphan would be reachable through
  // readHistoryFile and would open as part of a scan that was never sent that way.
  assert.deepEqual((await readdir(entry.dir)).sort(), ['case.json', 'lower.stl']);
});

test('stored bytes are addressed by key and name, so no caller-supplied path reaches the disk', async () => {
  const dir = await scratch();
  const store = createHistoryStore({ stateDir: dir });
  await store.record(
    { externalCaseId: 'CASE-42', scanJobId: 'job-1' },
    [await scanFile(dir, 'upper.stl', 'UPPER')]
  );

  assert.equal(String(await store.readFile('CASE-42', 'upper.stl')), 'UPPER');
  await assert.rejects(store.readFile('CASE-42', '../case.json'));
  await assert.rejects(store.readFile('CASE-42', '../../identity.json'));
  await assert.rejects(store.readFile('../CASE-42', 'upper.stl'));
  await assert.rejects(store.readFile('CASE-42', 'missing.stl'));
});

test('a file name that could escape the case directory is refused rather than stored', async () => {
  const dir = await scratch();
  const store = createHistoryStore({ stateDir: dir });
  await assert.rejects(
    store.record({ externalCaseId: 'CASE-42', scanJobId: 'job-1' }, [{ path: join(dir, 'x'), fileName: '../escape.stl' }]),
    /refusing to store/
  );
});

// The three tests below protect the store's answer against the FILESYSTEM's idea of identity,
// which is not the allowlist's. `CASE-42` and `case-42` are two ids to this module and one
// directory to APFS and NTFS; `abc.` and `abc` are two ids and one directory to Win32. What must
// hold everywhere is that an entry handed back belongs to the id that was asked for.

test('a returned entry always belongs to the id that was asked for, on any filesystem', async () => {
  // Deliberately asserts an INVARIANT rather than a filesystem behaviour: on a case-sensitive fs
  // both ids keep their own entry and both lookups hit, on a case-insensitive one they share a
  // directory and the loser's lookup misses. Both outcomes are correct; a hit carrying the OTHER
  // id would not be, and that is the single thing asserted, so this suite is green on either.
  for (const [first, second] of [['CASE-42', 'case-42'], ['ABC', 'abc'], ['abc.', 'abc']]) {
    const dir = await scratch();
    const store = createHistoryStore({ stateDir: dir });

    await store.record({ externalCaseId: first, scanJobId: 'job-first' }, []);
    await store.record({ externalCaseId: second, scanJobId: 'job-second' }, []);

    for (const requested of [first, second]) {
      const entry = await store.lookup(requested);
      if (entry !== null) {
        assert.equal(
          entry.externalCaseId,
          requested,
          `lookup(${requested}) returned the entry for ${entry.externalCaseId}`
        );
      }
    }
  }
});

test('a case-colliding id reads as a miss rather than the other case\'s stored scan', async () => {
  const dir = await scratch();
  const store = createHistoryStore({ stateDir: dir });
  const upper = await scanFile(dir, 'upper.stl', 'UPPER');
  const lower = await scanFile(dir, 'lower.stl', 'LOWER');

  await store.record({ externalCaseId: 'CASE-42', scanJobId: 'job-1' }, [upper]);
  await store.record({ externalCaseId: 'case-42', scanJobId: 'job-2' }, [lower]);

  // The id written last owns its own name on every filesystem.
  const winner = await store.lookup('case-42');
  assert.equal(winner.scanJobId, 'job-2');

  // The other one is either its own intact entry (case-sensitive fs) or a miss (case-insensitive,
  // where the second record replaced the directory — the priced residual: one re-capture). What it
  // must never be is job-2, which would show one case's scan under another case's id.
  const other = await store.lookup('CASE-42');
  assert.notEqual(other?.scanJobId, 'job-2', 'a collision must degrade to a miss, never a wrong hit');
  if (other !== null) assert.equal(other.scanJobId, 'job-1');
});

test('an id stored with surrounding whitespace is still found by the key it was stored under', async () => {
  const dir = await scratch();
  const store = createHistoryStore({ stateDir: dir });

  // record() keys on the trimmed id but stores the caller's raw string, so the identity check has
  // to trim both sides or padded ids would record and then never be found again.
  await store.record({ externalCaseId: '  CASE-42  ', scanJobId: 'job-1' }, []);
  assert.equal((await store.lookup('CASE-42'))?.scanJobId, 'job-1');
});

test('a record rejected for its file name leaves the previously stored scan intact', async () => {
  const dir = await scratch();
  const store = createHistoryStore({ stateDir: dir });

  await store.record(
    { externalCaseId: 'CASE-42', scanJobId: 'job-1' },
    [await scanFile(dir, 'upper.stl', 'UPPER')]
  );

  // A space is the realistic shape here, not a hostile one: the call site names files with
  // basename(filePath), so any scan the operator points at supplies its own name. Recording
  // replaces the case's entry, so a name refused mid-write would take the good scan with it and
  // leave the doctor with neither. A refused record must change nothing at all.
  const spaced = await scanFile(dir, 'my scan.stl', 'NEW');
  await assert.rejects(
    store.record({ externalCaseId: 'CASE-42', scanJobId: 'job-2' }, [spaced]),
    /refusing to store/
  );

  const entry = await store.lookup('CASE-42');
  assert.equal(entry?.scanJobId, 'job-1', 'the refused record must not have destroyed the stored scan');
  assert.deepEqual(entry.files, ['upper.stl']);
  assert.equal(String(await store.readFile('CASE-42', 'upper.stl')), 'UPPER');
});

// THE PROOF for the lookup guard. The two collision tests above provoke a REAL collision, which
// only happens on a case-insensitive volume — on ext4 or a case-sensitive APFS they pass without
// exercising the guard at all, so they are companions that show the real-world shape, never the
// proof. This one reproduces the collision's RESULT instead: a directory whose name disagrees with
// the id recorded inside it. That state is hand-writable on every filesystem, so this test fails an
// unguarded store and passes a guarded one identically everywhere, with no platform branch.
test('an entry whose stored key disagrees with its directory name is a miss on every filesystem', async () => {
  const dir = await scratch();
  const store = createHistoryStore({ stateDir: dir });

  await store.record({ externalCaseId: 'CASE-42', scanJobId: 'job-1' }, []);
  assert.ok(await store.lookup('CASE-42'), 'the entry must read as a hit before it is tampered with');

  // What a case-insensitive volume leaves behind when `case-42` is recorded over `CASE-42`: one
  // directory, still named for the first id, holding the second id's entry.
  const entryFile = join(dir, 'history', 'CASE-42', 'case.json');
  const stored = JSON.parse(await readFile(entryFile, 'utf8'));
  await writeFile(entryFile, JSON.stringify({ ...stored, key: 'case-42' }, null, 2));

  assert.equal(
    await store.lookup('CASE-42'),
    null,
    'an entry that belongs to another id must be a miss, never that other case\'s stored scan'
  );
});
