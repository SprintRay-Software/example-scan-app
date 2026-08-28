// Upload progress display, adaptive to where the output goes AND to how many files are in
// flight at once:
//   - a real terminal (TTY): ONE line redrawn in place with \r. Uploads run concurrently, so
//     a bar per file would mean several writers fighting over the same line; the line shows
//     the file when there is one and the aggregate — bytes over every file in the batch —
//     when there are several.
//   - a pipe/log file (the OS handler tees or redirects to a log): milestone % lines per file.
//     Those carry their own label, so they stay readable however the batch interleaves them.

function fmtBytes(n) {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

/**
 * A progress renderer shared by every file of a batch.
 *
 * @param {{ isTTY?: boolean, write: (s: string) => void }} [out]
 * @returns {{ update(label:string, sent:number, total:number):void, interrupt():void }}
 */
export function createProgressGroup(out = process.stdout) {
  const isTty = Boolean(out.isTTY);
  const files = new Map(); // label -> { sent, total }
  const milestones = new Map(); // label -> last 10% step printed (non-TTY only)
  let lastRenderMs = 0;
  let lineOpen = false;

  function totals() {
    let sent = 0;
    let total = 0;
    let complete = 0;
    for (const f of files.values()) {
      sent += f.sent;
      total += f.total;
      if (f.total > 0 && f.sent >= f.total) complete += 1;
    }
    return { sent, total, complete, count: files.size };
  }

  function render() {
    const { sent, total, complete, count } = totals();
    const pct = total > 0 ? Math.min(100, Math.floor((sent / total) * 100)) : 100;
    const width = 24;
    const filled = Math.round((pct / 100) * width);
    const bar = '█'.repeat(filled) + '░'.repeat(width - filled);
    // One file: name it. Several: name the batch, since the bytes are everyone's.
    const label = count === 1 ? [...files.keys()][0] : `${complete}/${count} files`;
    // \x1b[K clears whatever the previous, possibly longer, line left behind.
    out.write(`\r  ↑ ${label} [${bar}] ${String(pct).padStart(3)}% (${fmtBytes(sent)}/${fmtBytes(total)})\x1b[K`);
    lineOpen = true;
  }

  return {
    update(label, sent, total) {
      const known = files.get(label);
      const isNew = !known;
      if (known) {
        known.sent = sent;
        known.total = total;
      } else {
        files.set(label, { sent, total });
      }

      if (!isTty) {
        const pct = total > 0 ? Math.min(100, Math.floor((sent / total) * 100)) : 100;
        const milestone = Math.floor(pct / 10) * 10; // 0,10,…,100
        if (milestones.get(label) !== milestone) {
          milestones.set(label, milestone);
          console.log(`  ↑ ${label} ${milestone}% (${fmtBytes(sent)}/${fmtBytes(total)})`);
        }
        return;
      }

      const agg = totals();
      const batchDone = agg.total > 0 && agg.sent >= agg.total;
      // Throttle redraws, but never skip the frame that adds a file or finishes the batch.
      const now = Date.now();
      if (!isNew && !batchDone && now - lastRenderMs < 60) return;
      lastRenderMs = now;
      render();

      if (batchDone) {
        out.write('\n');
        lineOpen = false;
        // Every file of this batch is up; the next one starts its own line.
        files.clear();
        milestones.clear();
      }
    },

    // Close the live line before anything else writes to the terminal, so a log line never
    // lands on top of a half-drawn bar.
    interrupt() {
      if (!lineOpen) return;
      out.write('\n');
      lineOpen = false;
    },
  };
}
