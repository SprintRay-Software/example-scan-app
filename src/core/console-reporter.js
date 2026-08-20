// Console reporter — renders flow events to stdout/stderr for the CLI. Reproduces the
// original simulator's output: timestamped step/ok/fail/info lines, full request/response
// dumps, and an adaptive upload progress bar. Pipeline `phase` events are ignored here
// because the step() lines already narrate the flow for a console reader.

import { step, ok, fail, info } from '../log.js';
import { createProgress } from '../progress.js';
import { createReporter } from './reporter.js';
import { fileTypeName } from '../payload.js';

export function createConsoleReporter() {
  // One progress renderer per file label, created lazily on the first progress event.
  const bars = new Map();
  function bar(label) {
    let b = bars.get(label);
    if (!b) {
      b = createProgress(label);
      bars.set(label, b);
    }
    return b;
  }

  return createReporter({
    step: (msg) => step(msg),
    ok: (msg) => ok(msg),
    fail: (msg) => fail(msg),
    info: (msg) => info(msg),

    httpStart: ({ label, method, url, headers, body, bodyNote }) => {
      info(`> REQUEST — ${label}`);
      info(`    ${method} ${url}`);
      info(`    headers: ${JSON.stringify(headers)}`);
      if (bodyNote !== undefined) info(`    body: ${bodyNote}`);
      else if (body === undefined || body === null) info(`    body: (none)`);
      else info(`    body: ${body}`);
    },

    httpEnd: ({ label, status, statusText, headers, body, durationMs }) => {
      info(`< RESPONSE — ${label ?? ''}`.trimEnd());
      info(`    status: ${status} ${statusText} (${durationMs} ms)`);
      info(`    headers: ${JSON.stringify(headers)}`);
      info(`    body: ${body === '' ? '(empty)' : body}`);
    },

    httpError: ({ message, durationMs }) => {
      fail(`network error after ${durationMs} ms — ${message}`);
    },

    progress: ({ label, sent, total }) => {
      const b = bar(label);
      b.update(sent, total);
      if (sent >= total) b.done();
    },

    result: ({ results, failures, completed }) => {
      console.log('\n──────── summary ────────');
      // A full-mouth scan uploads both arches, so the count is however many went up.
      info(`uploaded: ${results.length}`);
      for (const r of results) {
        ok(
          `${r.fileName} — FileType ${r.treatmentFileType} (${fileTypeName(r.treatmentFileType)}) ` +
            `from ${r.fileTypeSource}, ${r.fileSize} bytes`
        );
      }
      if (completed) {
        ok(`scan session finished — scanJobId ${completed.id}, status ${completed.status}`);
      }
      for (const f of failures) fail(`${f.fileName ?? f.step}: ${f.error}`);
    },
  });
}
