// A reporter is the single sink for everything the flow wants an observer to see:
// narrated steps, the decoded launch payload, every HTTP request/response in full,
// upload progress, and the final result. The flow never writes to the console or an
// IPC channel directly — it calls the reporter, and each front end (CLI console,
// Electron UI) supplies a reporter that renders these events however it likes.
//
// This keeps ONE instrumented flow that both the CLI and the GUI drive, so what a
// tester observes in the UI is exactly what the CLI does on the wire.

// Every method a flow may call. A reporter only needs to implement the ones it
// cares about; missing ones are filled with no-ops so callers never have to guard.
const METHODS = [
  // pipeline stage lifecycle — (stage, status, detail?)
  // stage:  'decode' | 'exchange' | 'telemetry' | 'refresh' | 'link' | 'put' | 'complete' | 'meshes'
  // status: 'active' | 'done' | 'error' | 'skipped'
  'phase',
  // narrated log lines (mirror the CLI's step/ok/fail/info)
  'step',
  'ok',
  'fail',
  'info',
  // the decoded launch payload + the fields the flow extracted from it
  // ({ decoded, fields })
  'payload',
  // one HTTP transaction, reported as start then end (or error)
  // start: { id, label, method, url, headers, body?, bodyNote? }
  // end:   { id, ok, status, statusText, headers, body, durationMs }
  // error: { id, message, durationMs }
  'httpStart',
  'httpEnd',
  'httpError',
  // upload progress — ({ label, sent, total, pct })
  'progress',
  // final summary — ({ ok, results, failures, completed, report, meshes })
  'result',
];

/**
 * Build a reporter from a set of handlers. Any method not supplied becomes a no-op.
 * @param {Partial<Record<string, Function>>} handlers
 */
export function createReporter(handlers = {}) {
  const r = {};
  for (const name of METHODS) {
    const fn = handlers[name];
    r[name] = typeof fn === 'function' ? fn : () => {};
  }
  return r;
}

export const REPORTER_METHODS = METHODS;

/**
 * Wrap a reporter so a concurrent task's narration is held and replayed as one block.
 *
 * Uploads run in parallel, but their step/ok/HTTP events are the record this app exists to
 * show — two files racing would shuffle every request and response together. So each task
 * narrates into its own buffer and the caller flushes them in file order.
 *
 * `live` names the events that are NOT buffered because they only mean something as they
 * happen: `progress` drives a bar, and `phase` drives a pipeline view where several stages
 * genuinely are active at once.
 *
 * @param {ReturnType<createReporter>} target  the real reporter to replay into
 * @param {{ live?: string[] }} [options]
 * @returns {{ reporter: ReturnType<createReporter>, flush: () => void }}
 */
export function createBufferingReporter(target, { live = ['progress', 'phase'] } = {}) {
  const queued = [];
  const reporter = {};

  for (const name of METHODS) {
    reporter[name] = live.includes(name)
      ? (...args) => target[name](...args)
      : (...args) => {
          queued.push([name, args]);
        };
  }

  return {
    reporter,
    // Safe to call more than once: a second flush has nothing left to replay.
    flush() {
      for (const [name, args] of queued.splice(0)) target[name](...args);
    },
  };
}
