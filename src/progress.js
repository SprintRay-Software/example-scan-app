// Upload progress display, adaptive to where output goes:
//   - a real terminal (TTY): an in-place bar redrawn with \r
//   - a pipe/log file (the OS handler tees or redirects to a log): milestone % lines,
//     so a redirected run still shows progress without \r spam.

function fmtBytes(n) {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

/**
 * @param {string} label  usually the file name being uploaded
 * @returns {{ update(sent:number,total:number):void, done():void }}
 */
export function createProgress(label) {
  const isTty = Boolean(process.stdout.isTTY);
  let lastRenderMs = 0;
  let lastMilestone = -1;

  return {
    update(sent, total) {
      const pct = total > 0 ? Math.min(100, Math.floor((sent / total) * 100)) : 100;

      if (isTty) {
        const now = Date.now();
        if (pct < 100 && now - lastRenderMs < 60) return; // throttle redraws
        lastRenderMs = now;
        const width = 24;
        const filled = Math.round((pct / 100) * width);
        const bar = '█'.repeat(filled) + '░'.repeat(width - filled);
        process.stdout.write(`\r  ↑ ${label} [${bar}] ${String(pct).padStart(3)}% (${fmtBytes(sent)}/${fmtBytes(total)})`);
      } else {
        const milestone = Math.floor(pct / 10) * 10; // 0,10,…,100
        if (milestone !== lastMilestone) {
          lastMilestone = milestone;
          console.log(`  ↑ ${label} ${milestone}% (${fmtBytes(sent)}/${fmtBytes(total)})`);
        }
      }
    },
    done() {
      if (isTty) process.stdout.write('\n');
    },
  };
}
