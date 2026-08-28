// Console reporter — renders flow events to stdout/stderr for the CLI. Reproduces the
// original simulator's output: timestamped step/ok/fail/info lines, full request/response
// dumps, and an adaptive upload progress bar. Pipeline `phase` events are ignored here
// because the step() lines already narrate the flow for a console reader.
//
// Uploads run concurrently, so one progress group covers the whole batch, and every other
// line closes the live bar first instead of printing over it.

import { step, ok, fail, info } from '../log.js';
import { createProgressGroup } from '../progress.js';
import { createReporter } from './reporter.js';
import { fileTypeName } from '../payload.js';
import { describeScanReport } from '../scan-report.js';

export function createConsoleReporter() {
  // One renderer for every file in flight — see createProgressGroup.
  const progressBar = createProgressGroup();

  // Anything that is not the progress bar takes the line back first.
  const line =
    (write) =>
    (...args) => {
      progressBar.interrupt();
      write(...args);
    };

  return createReporter({
    step: line(step),
    ok: line(ok),
    fail: line(fail),
    info: line(info),

    httpStart: line(({ label, method, url, headers, body, bodyNote }) => {
      info(`> REQUEST — ${label}`);
      info(`    ${method} ${url}`);
      info(`    headers: ${JSON.stringify(headers)}`);
      if (bodyNote !== undefined) info(`    body: ${bodyNote}`);
      else if (body === undefined || body === null) info(`    body: (none)`);
      else info(`    body: ${body}`);
    }),

    httpEnd: line(({ label, status, statusText, headers, body, durationMs }) => {
      info(`< RESPONSE — ${label ?? ''}`.trimEnd());
      info(`    status: ${status} ${statusText} (${durationMs} ms)`);
      info(`    headers: ${JSON.stringify(headers)}`);
      info(`    body: ${body === '' ? '(empty)' : body}`);
    }),

    httpError: line(({ message, durationMs }) => {
      fail(`network error after ${durationMs} ms — ${message}`);
    }),

    progress: ({ label, sent, total }) => progressBar.update(label, sent, total),

    result: line(({ results, failures, completed, report, meshes }) => {
      console.log('\n──────── summary ────────');
      // A full-mouth scan uploads both arches, so the count is however many went up.
      info(`uploaded: ${results.length}`);
      for (const r of results) {
        ok(
          `${r.fileName} — FileType ${r.treatmentFileType} (${fileTypeName(r.treatmentFileType)}) ` +
            `from ${r.fileTypeSource}, externalScanFileType ${r.externalScanFileType ?? '(none)'}, ` +
            `${r.fileSize} bytes`
        );
      }
      if (report) {
        info(`reported: ${describeScanReport(report)}`);
      }
      if (completed) {
        ok(`scan session finished — scanJobId ${completed.id}, status ${completed.status}`);
      }
      if (meshes?.length) {
        ok(`meshes uploaded: ${meshes.length} (${meshes.map((m) => m.label).join(', ')})`);
      }
      for (const f of failures) fail(`${f.fileName ?? f.step}: ${f.error}`);
    }),
  });
}
