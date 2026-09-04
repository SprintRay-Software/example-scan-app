// Local record of the scans this desktop app has already sent, so a re-launch for a case the
// doctor has been through before can open the stored scan instead of re-capturing it.
//
// Keyed on the launch payload's `externalCaseId` — the SprintRay-side case identifier that
// outlives a single scan session. It is deliberately NOT `case.ID`/`scanJobId`: SprintRay mints a
// fresh scan job for every launch, so a session id would never match twice and history would
// never engage. `extractFields` falls back to `case.ID` when a payload carries no
// `externalCaseId`, which is why an id equal to the scanJobId means "legacy payload, no case
// identity" and disengages history entirely rather than storing under a session id.
//
// The store is pure: it owns bytes on disk and nothing else. No reporter, no network, no Electron
// — callers narrate its outcomes through their own reporter.

import { copyFile, mkdir, readFile as readBytes, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { DEFAULT_STATE_DIR } from './identity.js';

const HISTORY_DIR = 'history';
const ENTRY_FILE = 'case.json';

// A key becomes a directory name verbatim, so the allowlist — not an escape or a strip — is what
// keeps raw payload text out of the filesystem. Requiring an alphanumeric first character
// structurally excludes `.`, `..` and dotfiles; the character class excludes both separators; the
// 100-character ceiling keeps the path inside every platform's component limit.
const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/**
 * The history key for a decoded launch payload's fields, or null when this launch has no case
 * identity worth remembering. Null is a normal answer — the caller disengages, which leaves
 * today's capture-and-send behaviour byte-identical.
 */
export function historyKeyFor(fields) {
  const raw = fields?.externalCaseId;
  if (typeof raw !== 'string') return null;

  const key = raw.trim();
  if (!key) return null;
  // No case identity of its own: `extractFields` handed back the session id as a fallback.
  if (key === fields.scanJobId) return null;
  if (!KEY_PATTERN.test(key)) return null;

  return key;
}

// Stored file names become path components exactly as keys do, so they answer to the same
// allowlist. Refusing a name outright beats sanitising one: a scan quietly stored under a name the
// caller did not ask for would later be opened under that name too.
function safeFileName(fileName) {
  const name = String(fileName ?? '');
  return KEY_PATTERN.test(name) ? name : null;
}

/**
 * Open the history store under `<stateDir>/history/`.
 *
 * `stateDir` is injected rather than read from the environment: the CLI and the headless service
 * pass `process.env.SCANPRO_STATE_DIR || undefined`, Electron passes `app.getPath('userData')`,
 * and the shared default lives once — here — next to the identity file it sits beside on disk.
 */
export function createHistoryStore({ stateDir = DEFAULT_STATE_DIR } = {}) {
  const root = join(stateDir, HISTORY_DIR);
  // Re-validating a key here rather than trusting the caller is what lets a renderer- or
  // payload-supplied string reach these functions at all.
  const keyFor = (key) => historyKeyFor({ externalCaseId: key });
  const dirFor = (key) => {
    const valid = keyFor(key);
    return valid ? join(root, valid) : null;
  };

  return {
    /**
     * The stored session for a key, or null when there is none. A key that fails the allowlist, a
     * missing entry and an unreadable or truncated `case.json` are all the same answer — a miss,
     * never a throw — because the caller's fallback for a miss is to capture the scan, which is
     * exactly the right recovery for a damaged entry too.
     */
    async lookup(key) {
      const wanted = keyFor(key);
      if (!wanted) return null;
      const dir = join(root, wanted);
      try {
        const entry = JSON.parse(await readBytes(join(dir, ENTRY_FILE), 'utf8'));

        // A key is used as a directory name, and a filesystem is free to hand back a directory
        // that was created under a DIFFERENT name than the one asked for: macOS APFS and Windows
        // NTFS fold letter case by default, Win32 drops a trailing dot, and other normalisations
        // exist that this code has no way to enumerate. Two ids the allowlist treats as distinct
        // can therefore land in one directory, and the read would otherwise answer with whatever
        // case happened to be written last — one case's stored scan presented under another
        // case's id. So the entry that comes back is checked against the entry that was asked
        // for, instead of trying to predict what each platform will do to a name on the way in.
        // A mismatch is a miss, which is the failure this store is built to absorb: the caller
        // re-captures. The general form of the rule, for anyone reading this store as a
        // reference: check that what you read back is what you asked for.
        //
        // The comparand is the stored `key`, not the stored `externalCaseId`: `key` is the exact
        // value this store keyed the directory on, so it is identical by construction to what a
        // legitimate lookup asks for. Re-deriving the normalisation on the read side instead would
        // put the key rule in two places, and the day that rule changes the guard would quietly
        // stop matching entries it should match — a silent miss, which is the failure mode hardest
        // to notice from outside.
        if (typeof entry.key !== 'string' || entry.key !== wanted) {
          return null;
        }

        return { ...entry, dir };
      } catch {
        return null;
      }
    },

    /**
     * Store one sent session: `entry` is the caller's facts about the run (it must carry
     * `externalCaseId` and `scanJobId` so the key can be derived here, where the rule lives), and
     * `files` are the scans that went up, as `{ path, fileName }`.
     *
     * An existing entry for the same case is REPLACED — last send wins. A case has one stored
     * scan, not a version chain: re-sending a case through the normal flow re-records it, and the
     * next launch must open what was actually sent last.
     *
     * Returns the written entry, or null when the launch has no case identity (no write at all).
     * A filesystem failure throws — the caller reports it and carries on, since the scans are
     * already up by the time this runs.
     */
    async record(entry, files = []) {
      const key = historyKeyFor(entry);
      if (!key) return null;

      // Every name is checked BEFORE anything on disk moves. Recording replaces the case's
      // existing entry, so validating inside the copy loop would mean a rejected name had already
      // destroyed a perfectly good stored scan on its way to throwing — the caller would be left
      // with neither the old scan nor the new one. Names arrive from the call site as
      // `basename(filePath)`, which follows whatever file the operator pointed at, so a name this
      // allowlist refuses is an ordinary input and not a can't-happen. Refusing first makes a
      // rejected record a no-op instead of a deletion.
      const names = files.map((file) => {
        const name = safeFileName(file.fileName);
        if (!name) throw new Error(`history: refusing to store a file named "${file.fileName}"`);
        return name;
      });

      // Replacing the entry begins here, and past this point a failure costs the scan that was
      // already stored. The names are known good by now, but a source file can still have gone
      // missing since the caller chose it, and the copy below will then throw with the old entry
      // already removed — the case reads as a miss on its next launch and is captured again. That
      // is the direction every failure in this store takes deliberately: a miss costs one re-scan
      // and every caller must already handle one, so the entry is replaced in place rather than
      // transactionally. An implementation that needs the stronger guarantee should stage the
      // copies in a sibling directory and swap it into place only once they all succeed, so a
      // record that fails part-way never touches the entry that is already there.
      const dir = join(root, key);
      await rm(dir, { recursive: true, force: true });
      await mkdir(dir, { recursive: true });

      for (const [index, file] of files.entries()) {
        await copyFile(file.path, join(dir, names[index]));
      }

      // `case.json` goes last on purpose: it is what `lookup` reads, so a crash part-way through
      // the copies above leaves a directory that reads as a miss. A half-copied scan can never
      // present itself as "already sent".
      //
      // `key` is spread AFTER `...entry` deliberately, and the order is load-bearing: it means a
      // caller-supplied `key` field cannot override the one derived here, so the value `lookup`
      // compares against is always this store's own. Swapping the two would let a launch payload
      // choose the identity its entry claims — which is precisely what the lookup guard exists to
      // catch, so the guard would be bypassable by the same text it is defending against.
      const stored = { ...entry, key, savedAt: new Date().toISOString(), files: names };
      await writeFile(join(dir, ENTRY_FILE), JSON.stringify(stored, null, 2));
      return stored;
    },

    /**
     * The bytes of one stored file, addressed by key and name. Callers hand over the two
     * identifiers and never a path, which is what keeps a renderer-supplied string from reaching
     * `fs` — the Electron bridge's `history:read` channel is the consumer this exists for.
     */
    async readFile(key, fileName) {
      const dir = dirFor(key);
      const name = safeFileName(fileName);
      if (!dir || !name) throw new Error(`history: no stored file "${fileName}" for case "${key}"`);
      return readBytes(join(dir, name));
    },
  };
}
