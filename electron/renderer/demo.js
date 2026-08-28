// Demo mode — the app's default skin.
//
// Its lifecycle is the desktop app's real one, the same one the developer skin runs on: the
// window sits idle until a launch payload arrives (the OS URL scheme, or POST /start on the
// local service), plays the case, and steps back out of the way so the browser the doctor came
// from is in front again.
//
// In between it plays the chairside story end to end: the scanner warms up, captures the upper
// arch, then the lower, registers the bite, refines the meshes, and sends the case to SprintRay.
// Everything up to the send is a scripted rendering of a scan (see scan-view.js, which sweeps the
// bundled STL arches the way a wand would). The send is NOT scripted — it is the same runFlow()
// the developer skin drives, so with credentials configured the demo really does the device-login
// exchange, the presigned PUT and the scan-finish call, and the panel is reporting actual HTTP
// progress.
//
// Pressing d five times swaps to the developer skin (and back) — see wireModeGesture().

'use strict';

(function () {
  const $ = (id) => document.getElementById(id);
  const CANCELLED = Symbol('demo-cancelled');

  // Sequence timings, seconds. A real full-mouth capture takes minutes; a demo has to hold
  // attention, so the sweeps are compressed while keeping the rhythm of the real thing.
  const SCAN_SECONDS = 17;
  const BITE_SECONDS = 7.5;
  const REFINE_SECONDS = 9;
  // How long the "case sent" card stays up before the window steps aside for the browser.
  const RETURN_SECONDS = 4;

  const els = {};
  let view = null;
  let defaults = null;
  // The launch that opened the app, if any: { url, decoded, fields }.
  let launch = null;
  // The launch a run has already been started for, so switching skins never replays a case.
  let played = null;

  let runToken = 0;
  let paused = true; // the demo advances only while its skin is on screen
  let sending = false;

  // ---------------------------------------------------------------------------
  // small helpers
  // ---------------------------------------------------------------------------
  function loop(token, step) {
    return new Promise((resolve, reject) => {
      let last = 0;
      function frame(now) {
        if (token !== runToken) { reject(CANCELLED); return; }
        if (paused) { last = now; requestAnimationFrame(frame); return; }
        const dt = last ? Math.min(0.05, (now - last) / 1000) : 0.016;
        last = now;
        let go;
        try { go = step(dt); } catch (err) { reject(err); return; }
        if (go === false) { resolve(); return; }
        requestAnimationFrame(frame);
      }
      requestAnimationFrame(frame);
    });
  }

  function hold(token, seconds) {
    let t = 0;
    return loop(token, (dt) => {
      t += dt;
      return t < seconds;
    });
  }

  /** Animate 0..1 over `seconds`, easing in and out like a hand-held movement. */
  function ramp(token, seconds, onFrame) {
    let t = 0;
    return loop(token, (dt) => {
      t = Math.min(seconds, t + dt);
      const p = seconds > 0 ? t / seconds : 1;
      onFrame(p * p * (3 - 2 * p), p);
      return t < seconds;
    });
  }

  // Smooth pseudo-noise in 1D: enough to make a wand's speed look human.
  function wobble(x) {
    return (
      0.5 +
      0.28 * Math.sin(x * 1.7) +
      0.14 * Math.sin(x * 4.3 + 1.1) +
      0.08 * Math.sin(x * 9.1 + 2.7)
    );
  }

  const clamp01 = (v) => Math.max(0, Math.min(1, v));

  /** First readable sentence of a backend error, for a card a doctor is looking at. */
  function briefError(text) {
    let msg = String(text || 'the upload did not complete').trim();
    // Cut at the point the response body stops being prose: a JSON envelope or a stack trace.
    const cut = msg.search(/\s[-—]\s[[{]|\n|\bat [A-Z][\w.]+\(/);
    if (cut > 20) msg = msg.slice(0, cut);
    return msg.length > 190 ? msg.slice(0, 190).trimEnd() + '…' : msg;
  }
  const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  function fmtBytes(n) {
    if (!Number.isFinite(n)) return '—';
    if (n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB';
    if (n >= 1024) return Math.round(n / 1024) + ' KB';
    return n + ' B';
  }

  // ---------------------------------------------------------------------------
  // chrome: step tracker, arch selector, HUD, prompts, toasts
  // ---------------------------------------------------------------------------
  function setStep(active) {
    const seq = ['scan', 'refine', 'finish'];
    const at = seq.indexOf(active);
    for (const node of document.querySelectorAll('#demo-root .dm-step')) {
      const i = seq.indexOf(node.dataset.step);
      node.classList.toggle('active', i === at);
      node.classList.toggle('done', i < at);
    }
  }

  function setArchChip(name) {
    for (const btn of document.querySelectorAll('#demo-root .dm-arch-btn[data-arch]')) {
      btn.classList.toggle('active', btn.dataset.arch === name);
    }
    for (const [i, jaw] of [...document.querySelectorAll('#demo-root .dm-jaw')].entries()) {
      jaw.classList.toggle('on', i === { upper: 0, lower: 1, bite: 2 }[name]);
    }
  }

  function markArchCaptured(name) {
    const btn = document.querySelector(`#demo-root .dm-arch-btn[data-arch="${name}"]`);
    if (btn) btn.classList.add('filled');
  }

  function showHud(on) {
    els.hud.classList.toggle('show', on);
  }

  function hud({ arch, coverage, frames, fps, elapsed }) {
    if (arch !== undefined) els.hudArch.textContent = arch;
    if (coverage !== undefined) els.hudCov.textContent = Math.round(coverage * 100) + '%';
    if (frames !== undefined) els.hudFrames.textContent = String(Math.floor(frames));
    if (fps !== undefined) els.hudFps.textContent = String(Math.round(fps));
    if (elapsed !== undefined) els.hudTime.textContent = mmss(elapsed);
  }

  function prompt(main, sub) {
    if (main === null) {
      els.prompt.classList.remove('show');
      return;
    }
    els.promptMain.textContent = main;
    els.promptSub.textContent = sub || '';
    els.prompt.classList.add('show');
  }

  let toastTimer = 0;
  function toast(text, ms = 2200) {
    els.toastText.textContent = text;
    els.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.remove('show'), ms);
  }

  // ---------------------------------------------------------------------------
  // the one overlay card, reused by boot / refine / send / done
  // ---------------------------------------------------------------------------
  // True only while the idle card is the one on screen, so the live footer never overwrites the
  // footer of a card that is saying something else.
  let idleCard = false;

  function overlay(cfg) {
    idleCard = false;
    if (cfg === null) {
      els.overlay.classList.remove('show');
      setTimeout(() => {
        if (!els.overlay.classList.contains('show')) els.overlay.hidden = true;
      }, 260);
      return;
    }
    els.overlay.hidden = false;
    // Force a reflow so the fade-in runs even when the card is re-shown immediately.
    void els.overlay.offsetWidth;
    els.overlay.classList.add('show');

    els.ovMark.hidden = !cfg.mark;
    els.ovEyebrow.textContent = cfg.eyebrow || '';
    els.ovTitle.textContent = cfg.title || '';
    els.ovSub.textContent = cfg.sub || '';
    els.ovSub.hidden = !cfg.sub;

    els.ovBar.hidden = !cfg.bar;
    els.ovBarNote.hidden = !cfg.bar;
    if (cfg.bar) setBar(0, '', '');

    els.ovTasks.innerHTML = '';
    for (const task of cfg.tasks || []) {
      const row = document.createElement('div');
      row.className = 'dm-task';
      row.dataset.task = task.id;
      const mark = document.createElement('span');
      mark.className = 'dm-task-mark';
      mark.textContent = '✓';
      const label = document.createElement('span');
      label.textContent = task.label;
      const detail = document.createElement('span');
      detail.className = 'dm-task-detail';
      row.append(mark, label, detail);
      els.ovTasks.appendChild(row);
    }

    els.ovKv.hidden = true;
    els.ovKv.innerHTML = '';
    els.ovActions.hidden = !cfg.actions;
    els.ovFoot.hidden = !cfg.foot;
    els.ovFoot.textContent = cfg.foot || '';
  }

  function setTask(id, state, detail) {
    const row = els.ovTasks.querySelector(`[data-task="${id}"]`);
    if (!row) return;
    row.classList.remove('active', 'done', 'err');
    if (state) row.classList.add(state);
    if (detail !== undefined) row.querySelector('.dm-task-detail').textContent = detail || '';
  }

  function setBar(pct, left, right) {
    els.ovBarFill.style.width = clamp01(pct / 100) * 100 + '%';
    if (left !== undefined) els.ovBarLeft.textContent = left;
    if (right !== undefined) els.ovBarRight.textContent = right;
  }

  function setKv(rows) {
    els.ovKv.innerHTML = '';
    for (const [k, v] of rows) {
      const row = document.createElement('div');
      row.className = 'dm-kv-row';
      const key = document.createElement('span');
      key.textContent = k;
      const val = document.createElement('b');
      val.textContent = v;
      val.title = v;
      row.append(key, val);
      els.ovKv.appendChild(row);
    }
    els.ovKv.hidden = rows.length === 0;
  }

  // ---------------------------------------------------------------------------
  // the scanner's camera preview — a speckled grayscale feed, as an IR intra-oral
  // camera looks when it is pointed at enamel.
  // ---------------------------------------------------------------------------
  const cam = { ctx: null, off: null, offCtx: null, img: null, noise: null, live: false, t: 0, acc: 0 };

  function initCam() {
    const canvas = els.camCanvas;
    cam.ctx = canvas.getContext('2d');
    cam.off = document.createElement('canvas');
    cam.off.width = 96;
    cam.off.height = 72;
    cam.offCtx = cam.off.getContext('2d');
    cam.img = cam.offCtx.createImageData(96, 72);
    // A fixed noise field, sampled with a drifting offset: cheaper than per-pixel random and it
    // gives the feed a texture that moves with the wand instead of flickering as pure static.
    cam.noise = new Uint8Array(256 * 256);
    let s = 1337;
    for (let i = 0; i < cam.noise.length; i++) {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      cam.noise[i] = (s >> 16) & 0xff;
    }
    cam.ctx.imageSmoothingEnabled = true;
  }

  function setCamLive(on) {
    cam.live = on;
    els.camOff.hidden = on;
  }

  function drawCam(dt) {
    if (!cam.live) return;
    cam.t += dt;
    cam.acc += dt;
    if (cam.acc < 1 / 22) return; // the feed runs slower than the 3D view
    cam.acc = 0;

    const W = 96, H = 72;
    const data = cam.img.data;
    const ox = Math.floor(cam.t * 26) & 255;
    const oy = Math.floor(Math.sin(cam.t * 0.7) * 30 + 60) & 255;
    // A soft bright patch stands in for the tooth surface in focus.
    const bx = W * (0.5 + 0.18 * Math.sin(cam.t * 0.55));
    const by = H * (0.5 + 0.14 * Math.cos(cam.t * 0.43));
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const nf = cam.noise[(((y * 3 + oy) & 255) << 8) | ((x * 3 + ox) & 255)];
        const nc = cam.noise[(((y + oy) & 255) << 8) | ((x + ox) & 255)];
        const dx = (x - bx) / (W * 0.42);
        const dy = (y - by) / (H * 0.46);
        const focus = Math.max(0, 1 - (dx * dx + dy * dy));
        let v = 26 + 118 * focus + nf * 0.30 * (0.35 + 0.75 * focus) + nc * 0.14;
        v = v < 0 ? 0 : v > 255 ? 255 : v;
        const i = (y * W + x) * 4;
        data[i] = v * 0.97;
        data[i + 1] = v;
        data[i + 2] = v * 1.03 > 255 ? 255 : v * 1.03;
        data[i + 3] = 255;
      }
    }
    cam.offCtx.putImageData(cam.img, 0, 0);
    cam.ctx.clearRect(0, 0, els.camCanvas.width, els.camCanvas.height);
    cam.ctx.drawImage(cam.off, 0, 0, els.camCanvas.width, els.camCanvas.height);
  }

  // ---------------------------------------------------------------------------
  // case details — from the launch payload when there is one, otherwise a
  // clearly-labelled placeholder case so the demo still reads as a real one.
  // ---------------------------------------------------------------------------
  function caseInfo() {
    const d = launch?.decoded || {};
    const f = launch?.fields || {};
    const caseObj = d.case || d.Case || {};
    return {
      patient: caseObj.name || caseObj.Name || 'Demo Patient',
      caseId: f.scanJobId || 'DEMO-0042',
      treatmentId: f.treatmentId || null,
      teeth: (d.treatment?.teeth || []).map((t) => t.teeth ?? t.Teeth).filter((t) => t != null),
      toothSystem: (d.toothSystem || 'fdi').toUpperCase(),
      fileType: f.fileType ?? null,
    };
  }

  function renderCase(info) {
    els.case.hidden = false;
    els.caseName.textContent = info.patient;
    els.caseId.textContent = info.caseId;
    els.caseScan.textContent =
      info.fileType === 1 ? 'Upper arch' : info.fileType === 2 ? 'Lower arch' : 'Full mouth';
    els.teeth.innerHTML = '';
    for (const t of info.teeth.slice(0, 8)) {
      const chip = document.createElement('span');
      chip.className = 'dm-tooth';
      chip.textContent = String(t);
      chip.title = `tooth ${t} (${info.toothSystem})`;
      els.teeth.appendChild(chip);
    }
  }

  /** Which arches this case asks for: a payload naming a fileType wants that one only. */
  function archesFor(info) {
    if (info.fileType === 1) return ['upper'];
    if (info.fileType === 2) return ['lower'];
    return ['upper', 'lower'];
  }

  // ---------------------------------------------------------------------------
  // arch geometry — the STL bytes come from the main process (a file:// page
  // cannot fetch them itself).
  // ---------------------------------------------------------------------------
  const loaded = {};
  async function ensureArch(name) {
    if (loaded[name]) return true;
    const res = await window.scanpro.readFixture(name);
    if (!res.ok) {
      console.error('[demo] fixture', name, res.error);
      return false;
    }
    view.loadArch(name, res.bytes instanceof Uint8Array ? res.bytes : new Uint8Array(res.bytes));
    loaded[name] = true;
    return true;
  }

  // ---------------------------------------------------------------------------
  // sequence — the storyboard, one function per phase
  // ---------------------------------------------------------------------------

  /** Back to a cold scanner: nothing captured, no chrome, no case on screen. */
  function resetStage() {
    setStep('scan');
    showHud(false);
    hud({ arch: '\u2014', coverage: 0, frames: 0, fps: 0, elapsed: 0 });
    prompt(null);
    els.case.hidden = true;
    setCamLive(false);
    for (const name of ['upper', 'lower']) {
      view.show(name, false);
      view.setReveal(name, 0);
    }
    for (const btn of document.querySelectorAll('#demo-root .dm-arch-btn')) btn.classList.remove('filled');
    view.setQuality(1);
    view.setSmooth(0);
    view.setLive(false);
    view.setBite(false);
  }

  /** Warm-up: what a scanner does between being woken and being usable. */
  async function warmUp(token, info, arches) {
    overlay({
      eyebrow: 'SprintRay scanner',
      title: 'Preparing to scan',
      sub: 'Warming the optics and loading the case from SprintRay.',
      tasks: [
        { id: 'connect', label: 'Connecting to scanner' },
        { id: 'calibrate', label: 'Calibrating optics' },
        { id: 'case', label: 'Loading case' },
      ],
    });

    setTask('connect', 'active');
    await hold(token, 0.8);
    setTask('connect', 'done', els.camSerial.textContent);

    setTask('calibrate', 'active');
    // Parsing + welding the arches is real work; do it behind the calibration step so the
    // sequence never stutters mid-sweep.
    let ready = 0;
    for (const name of arches) if (await ensureArch(name)) ready += 1;
    if (ready === 0) {
      // Without geometry there is no scan to show, and silently sweeping an empty viewport for
      // twenty seconds would read as a hung app.
      setTask('calibrate', 'err', 'no scan data');
      throw new Error('the bundled scan files could not be read');
    }
    await hold(token, 0.7);
    setTask('calibrate', 'done');

    setTask('case', 'active');
    await hold(token, 0.6);
    setTask('case', 'done', 'from launch payload');
    renderCase(info);
    await hold(token, 0.35);
    overlay(null);
    await hold(token, 0.4);
  }

  /**
   * Sweep one arch. `clock` carries the session's elapsed time and captured-frame count across
   * the phases, the way a scanner's readout keeps counting from arch to arch.
   */
  async function captureArch(token, name, index, arches, clock) {
    const label = name === 'upper' ? 'Upper arch' : 'Lower arch';
    setArchChip(name);
    // One jaw at a time: an arch already captured would otherwise sit in front of the one being
    // swept, since the camera frames the arch, not the pair.
    for (const other of arches) view.show(other, other === name);
    view.setReveal(name, 0);
    view.focus(name, 0);
    view.setSpin(0.02);
    view.setLive(true);
    setCamLive(true);
    showHud(true);
    hud({ arch: label, coverage: 0, frames: clock.frames, fps: 0, elapsed: clock.elapsed });
    prompt(
      `Scan the ${label.toLowerCase()}`,
      index === 0 ? 'Start at the last molar and sweep forward' : 'Same sweep, lingual on the way back'
    );
    await hold(token, 1.2);
    prompt(null);

    let reveal = 0;
    let stall = 0;
    let lostAt = 0.42 + 0.16 * (index % 2); // one tracking drop per arch, as in a real sweep
    let t = 0;
    await loop(token, (dt) => {
      t += dt;
      clock.elapsed += dt;

      // Wand speed: mostly steady, with the hesitation of a hand moving over a curve.
      const w = 0.55 + 0.85 * wobble(t * 0.8 + index * 3.1);
      let speed = w / SCAN_SECONDS;

      if (lostAt && reveal > lostAt) {
        lostAt = 0;
        stall = 1.7;
        toast('Tracking lost — return to a scanned area');
      }
      if (stall > 0) {
        stall -= dt;
        speed *= 0.05;
      }

      reveal = clamp01(reveal + speed * dt);
      clock.frames += dt * (stall > 0 ? 3 : 14 + 6 * w);

      view.setReveal(name, reveal);
      view.focus(name, reveal);
      hud({
        coverage: reveal,
        frames: clock.frames,
        fps: stall > 0 ? 4 + 3 * w : 26 + 8 * w,
        elapsed: clock.elapsed,
      });
      return reveal < 1;
    });

    view.setLive(false);
    prompt(`${label} captured`, 'Coverage 100% — 0 open margins');
    markArchCaptured(name);
    view.setSpin(0.16); // let the finished arch turn so the doctor can look it over
    await hold(token, 1.6);
    prompt(null);
    view.setSpin(0.03);
    setCamLive(false);
    showHud(false);
    await hold(token, 0.5);
  }

  /** Bite registration: both arches held apart, then closed into their real occlusion. */
  async function registerBite(token, clock) {
    setArchChip('bite');
    view.show('upper', true);
    view.show('lower', true);
    view.focus('bite');
    view.setBite(true);
    view.setSpin(0.05);
    showHud(true);
    hud({ arch: 'Bite registration', coverage: 1, frames: clock.frames, fps: 24, elapsed: clock.elapsed });
    prompt('Register the bite', 'Have the patient close, then scan the buccal surfaces');
    setCamLive(true);
    await hold(token, BITE_SECONDS * 0.45);

    view.setBite(false); // the arches settle into occlusion
    prompt('Aligning arches', 'Matching the buccal scan to both models');
    await ramp(token, BITE_SECONDS * 0.55, () => {
      clock.elapsed += 1 / 60;
      hud({ elapsed: clock.elapsed });
    });

    prompt('Bite registered', 'Alignment deviation 0.04 mm');
    setCamLive(false);
    showHud(false);
    await hold(token, 1.4);
    prompt(null);
  }

  /** Refinement: the raw capture becomes the model that gets sent. */
  async function refine(token) {
    setStep('refine');
    view.setSpin(0.1);
    const tasks = [
      { id: 'merge', label: 'Merging frames' },
      { id: 'holes', label: 'Filling holes' },
      { id: 'smooth', label: 'Smoothing surface' },
      { id: 'trim', label: 'Trimming soft tissue' },
    ];
    overlay({
      eyebrow: 'Refine',
      title: 'Processing the scan',
      sub: 'Merging the captured frames into the final models.',
      bar: true,
      tasks,
    });

    let done = -1;
    await ramp(token, REFINE_SECONDS, (eased, linear) => {
      const at = Math.min(tasks.length - 1, Math.floor(linear * tasks.length));
      while (done < at) {
        done += 1;
        setTask(tasks[done].id, 'active');
        if (done > 0) setTask(tasks[done - 1].id, 'done');
      }
      setBar(linear * 100, tasks[at].label, Math.round(linear * 100) + '%');
      // Holes close and the raw, bumpy capture resolves into a clean model.
      view.setQuality(clamp01(1 - linear * 2.1));
      view.setSmooth(eased);
      view.setBite(linear > 0.55 && linear < 0.9);
    });

    for (const t of tasks) setTask(t.id, 'done');
    setBar(100, '', '100%');
    view.setQuality(0);
    view.setSmooth(1);
    view.setBite(false);
    await hold(token, 0.7);
    overlay(null);
    view.focus('bite');
    view.setSpin(0.14);
    await hold(token, 1.2);
  }

  async function sequence(token) {
    const info = caseInfo();
    const arches = archesFor(info);
    // Shared readout: seconds of capture and frames captured, counted across the whole session.
    const clock = { elapsed: 0, frames: 0 };

    resetStage();
    await warmUp(token, info, arches);
    for (const [i, name] of arches.entries()) await captureArch(token, name, i, arches, clock);
    // A bite only means something when both arches were captured.
    if (arches.length === 2) await registerBite(token, clock);
    await refine(token);

    setStep('finish');
    await send(token, info, arches);
  }

  // ---------------------------------------------------------------------------
  // send — the only step that leaves the machine
  // ---------------------------------------------------------------------------

  // Maps the flow's pipeline stages onto the send card's task list. The developer skin shows
  // these as HTTP transactions; here they are the four things a doctor cares about.
  const SEND_TASKS = [
    { id: 'case', label: 'Reading the case' },
    { id: 'auth', label: 'Authorizing the scanner' },
    { id: 'upload', label: 'Uploading scan data' },
    { id: 'finish', label: 'Closing the scan session' },
  ];

  // `files` is the live per-file byte count: uploads overlap, so the bar is driven by their sum
  // rather than by whichever file reported last.
  const sendUi = { active: false, uploadTotal: 0, uploadIndex: 0, files: new Map() };

  function openSendCard(info, arches, note) {
    overlay({
      eyebrow: 'Finish',
      title: 'Sending to SprintRay',
      sub: `${info.patient} — ${arches.length === 2 ? 'upper and lower arch' : arches[0] + ' arch'}`,
      bar: true,
      tasks: SEND_TASKS,
      foot: note,
    });
    sendUi.uploadTotal = arches.length;
    sendUi.uploadIndex = 0;
    sendUi.files.clear();
  }

  /** Every flow event during a demo send, rendered as the doctor-facing card. */
  function onFlowEvent({ type, payload }) {
    if (!sendUi.active) return;
    if (type === 'phase') {
      const map = { decode: 'case', exchange: 'auth', refresh: 'auth', link: 'upload', put: 'upload', complete: 'finish', meshes: 'finish' };
      const id = map[payload.stage];
      if (!id) return;
      if (payload.status === 'error') setTask(id, 'err', payload.detail || 'failed');
      else if (payload.status === 'done' && id !== 'upload') setTask(id, 'done');
      else if (payload.status === 'active') setTask(id, 'active');
      if (payload.stage === 'put' && payload.status === 'done') {
        sendUi.uploadIndex += 1;
        if (sendUi.uploadIndex >= sendUi.uploadTotal) setTask('upload', 'done', `${sendUi.uploadTotal} files`);
      }
      return;
    }
    if (type === 'progress') {
      // One bar across the whole upload, so arches sent at the same time read as one transfer.
      sendUi.files.set(payload.label, { sent: payload.sent, total: payload.total });
      let sent = 0;
      let total = 0;
      for (const f of sendUi.files.values()) {
        sent += f.sent;
        total += f.total;
      }
      const pct = total > 0 ? Math.min(100, (sent / total) * 100) : 0;
      const label = sendUi.files.size === 1 ? payload.label : `${sendUi.files.size} files`;
      setBar(pct, label, `${fmtBytes(sent)} / ${fmtBytes(total)}`);
      setTask('upload', 'active', `${Math.min(sendUi.uploadIndex + 1, sendUi.uploadTotal)}/${sendUi.uploadTotal}`);
    }
  }

  function sendableConfig() {
    return {
      baseUrl: $('cfg-base').value.trim() || defaults?.baseUrl || '',
      apiKey: $('cfg-api-key').value.trim(),
      clientId: $('cfg-client-id').value.trim(),
      clientSecret: $('cfg-client-secret').value.trim(),
    };
  }

  async function send(token, info, arches) {
    const cfg = sendableConfig();
    const canSend = Boolean(launch?.url && cfg.apiKey && cfg.clientId && cfg.clientSecret);

    if (!canSend) {
      // Nothing real to send. Say so on the card rather than dressing a fake transfer up as a
      // real one.
      const why = !launch?.url
        ? 'No launch payload to send.'
        : 'Backend credentials are not configured — fill them in on the .env file or in developer mode.';
      openSendCard(info, arches, `Simulated transfer. ${why}`);
      for (const [i, id] of ['case', 'auth', 'upload', 'finish'].entries()) {
        setTask(id, 'active');
        if (id === 'upload') {
          await ramp(token, 3.2, (_e, p) => setBar(p * 100, 'upper.stl', Math.round(p * 100) + '%'));
        } else {
          await hold(token, 0.7 + i * 0.15);
        }
        setTask(id, 'done');
      }
      setBar(100, '', '100%');
      await hold(token, 0.5);
      await showDone(token, info, arches, { simulated: why });
      return;
    }

    openSendCard(info, arches, null);
    sendUi.active = true;
    sending = true;
    let result;
    try {
      result = await window.scanpro.runFlow({
        config: cfg,
        input: { launchUrl: launch.url, demoRefresh: false, upperFileOverride: null, lowerFileOverride: null },
      });
    } finally {
      sendUi.active = false;
      sending = false;
    }

    if (token !== runToken) throw CANCELLED;

    if (result?.ok && result.summary?.ok) {
      await showDone(token, info, arches, { summary: result.summary });
    } else {
      const err = result?.error || result?.summary?.failures?.map((f) => f.error).join('; ');
      overlay({
        eyebrow: 'Finish',
        title: 'The case was not sent',
        sub: briefError(err),
        actions: true,
        foot: 'Switch to developer mode (press d five times) for the full request and response.',
      });
      // No countdown here: an error stays up until someone dismisses it.
    }
  }

  async function showDone(token, info, arches, { summary, simulated } = {}) {
    const files = summary?.results || [];
    overlay({
      mark: true,
      eyebrow: simulated ? 'Finish — simulated' : 'Finish',
      title: simulated ? 'Scan complete' : 'Case sent to SprintRay',
      sub: simulated
        ? 'The scan is finished. Nothing was uploaded.'
        : 'The scans are attached to the treatment.',
      actions: true,
      foot: ' ', // filled by the countdown below
    });
    const rows = [
      ['Patient', info.patient],
      ['Case', String(info.caseId)],
    ];
    if (info.treatmentId) rows.push(['Treatment', info.treatmentId]);
    if (files.length) {
      for (const f of files) rows.push([f.treatmentFileType === 2 ? 'Lower' : 'Upper', `${f.fileName} · ${fmtBytes(f.fileSize)}`]);
    } else {
      rows.push(['Arches', arches.join(' + ')]);
    }
    setKv(rows);

    // The case is with SprintRay now, so the scanner's job is over: count down and hand the
    // screen back to the browser the doctor started from. The button skips the wait.
    const note = typeof simulated === 'string' ? simulated + ' ' : '';
    let left = RETURN_SECONDS;
    await loop(token, (dt) => {
      left -= dt;
      els.ovFoot.textContent = `${note}Returning to the SprintRay web app in ${Math.max(1, Math.ceil(left))}s…`;
      return left > 0;
    });
    returnToBrowser();
  }

  // ---------------------------------------------------------------------------
  // lifecycle: idle -> launch -> case -> back to the browser
  // ---------------------------------------------------------------------------

  // What the local service is doing, for the idle card's footer. The web app probes that port
  // to find this app, so "is it listening" is the one thing worth showing while nothing is on.
  let serverState = null;
  let schemeState = null;

  function idleFoot() {
    const parts = [];
    if (schemeState) {
      parts.push(
        schemeState.isDefault
          ? `${schemeState.scheme}:// handled by this app`
          : `${schemeState.scheme}:// not registered to this app`
      );
    }
    if (serverState?.status === 'listening') parts.push(`local service on 127.0.0.1:${serverState.port}`);
    else if (serverState?.status === 'disabled') parts.push('local service off');
    else if (serverState?.status === 'failed') parts.push('local service could not bind a port');
    return parts.join(' · ');
  }

  /** The window between cases: no model, no capture, waiting to be launched. */
  function showIdle() {
    resetStage();
    overlay({
      eyebrow: 'SprintRay scanner',
      title: 'Ready to scan',
      sub: 'Waiting for a case. Start a scan from the SprintRay web app and this window comes forward with the patient loaded.',
      foot: idleFoot() || ' ',
    });
    idleCard = true;
  }

  function start() {
    if (!launch?.url) {
      // Nothing to scan: the app is only ever driven by a launch, same as the developer skin.
      showIdle();
      return;
    }
    played = launch;
    const token = ++runToken;
    sequence(token).catch((err) => {
      if (err === CANCELLED) return;
      console.error('[demo]', err);
      overlay({
        eyebrow: 'Demo',
        title: 'The demo stopped',
        sub: String(err?.message || err),
        actions: true,
      });
    });
  }

  /**
   * Hand the screen back to the browser and go idle. The main process hides the app (macOS) or
   * minimizes the window, which is what actually brings the previous app forward; the next
   * launch reveals this window again.
   */
  function returnToBrowser() {
    runToken += 1; // cancel anything the sequence still had queued
    window.scanpro.hideWindow();
    showIdle();
  }

  // ---------------------------------------------------------------------------
  // mode switch — d, five times
  // ---------------------------------------------------------------------------
  let uiMode = 'demo';

  function applyMode(next) {
    uiMode = next;
    const demo = next === 'demo';
    $('demo-root').hidden = !demo;
    $('dev-root').hidden = demo;
    paused = !demo;
    if (!demo) {
      view?.stop();
      return;
    }
    view?.start();
    // A launch that arrived while the developer skin was up has not been played yet; entering
    // the demo skin is the first chance to show it. Anything already played is left alone.
    if (launch && launch !== played) start();
    else if (runToken === 0) showIdle();
  }

  const GESTURE_KEY = 'd';
  const GESTURE_COUNT = 5;
  const GESTURE_WINDOW_MS = 1200;

  function wireModeGesture() {
    let hits = 0;
    let timer = 0;

    function paint() {
      const dots = els.gesture.children;
      for (let i = 0; i < dots.length; i++) dots[i].classList.toggle('lit', i < hits);
      els.gesture.classList.toggle('show', hits >= 2);
    }

    function reset() {
      hits = 0;
      paint();
    }

    window.addEventListener('keydown', (e) => {
      // In developer mode the user is typing into fields; only a keypress outside an input counts.
      const t = e.target;
      const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;

      if (e.key.toLowerCase() !== GESTURE_KEY) {
        if (hits) reset();
        return;
      }
      hits += 1;
      paint();
      clearTimeout(timer);
      if (hits >= GESTURE_COUNT) {
        reset();
        applyMode(uiMode === 'demo' ? 'dev' : 'demo');
        return;
      }
      timer = setTimeout(reset, GESTURE_WINDOW_MS);
    });
  }

  // ---------------------------------------------------------------------------
  // init
  // ---------------------------------------------------------------------------
  function collectEls() {
    const ids = {
      hud: 'dm-hud', hudArch: 'dm-hud-arch', hudCov: 'dm-hud-cov', hudFrames: 'dm-hud-frames',
      hudFps: 'dm-hud-fps', hudTime: 'dm-hud-time',
      prompt: 'dm-prompt', promptMain: 'dm-prompt-main', promptSub: 'dm-prompt-sub',
      toast: 'dm-toast', toastText: 'dm-toast-text',
      case: 'dm-case', caseName: 'dm-case-name', caseId: 'dm-case-id', caseScan: 'dm-case-scan', teeth: 'dm-teeth',
      overlay: 'dm-overlay', ovMark: 'dm-ov-mark', ovEyebrow: 'dm-ov-eyebrow', ovTitle: 'dm-ov-title',
      ovSub: 'dm-ov-sub', ovBar: 'dm-ov-bar', ovBarFill: 'dm-ov-bar-fill', ovBarNote: 'dm-ov-bar-note',
      ovBarLeft: 'dm-ov-bar-left', ovBarRight: 'dm-ov-bar-right', ovTasks: 'dm-ov-tasks', ovKv: 'dm-ov-kv',
      ovActions: 'dm-ov-actions', ovReturn: 'dm-ov-return', ovFoot: 'dm-ov-foot',
      camCanvas: 'dm-cam-canvas', camOff: 'dm-cam-off', camSerial: 'dm-cam-serial',
      canvas: 'dm-canvas', gesture: 'dm-gesture',
      expertToggle: 'dm-expert-toggle', softToggle: 'dm-soft-toggle',
    };
    for (const [k, id] of Object.entries(ids)) els[k] = $(id);
  }

  async function init() {
    collectEls();
    initCam();
    wireModeGesture();

    els.ovReturn.addEventListener('click', () => {
      if (sending) return; // an upload is in flight; let it finish
      returnToBrowser();
    });
    // Two switches that are decoration in the developer skin but part of the scanner's chrome here.
    els.expertToggle.addEventListener('click', () => els.expertToggle.classList.toggle('on'));
    els.softToggle.addEventListener('click', () => els.softToggle.classList.toggle('on-red'));

    try {
      view = window.ScanView.createScanView(els.canvas);
    } catch (err) {
      console.error('[demo] no WebGL:', err);
      // Without a 3D view there is no demo worth showing — fall back to the developer skin.
      applyMode('dev');
      return;
    }

    // The camera feed rides the same clock as everything else in the demo.
    let camLast = 0;
    (function camTick(now) {
      requestAnimationFrame(camTick);
      const dt = camLast ? Math.min(0.1, (now - camLast) / 1000) : 0.016;
      camLast = now;
      if (uiMode === 'demo') drawCam(dt);
    })(0);

    // Keep the idle card's footer honest about the two ways a launch can reach this app.
    const refreshIdleFoot = () => {
      if (idleCard) els.ovFoot.textContent = idleFoot() || ' ';
    };
    window.scanpro.onLocalServerState((state) => {
      serverState = state;
      refreshIdleFoot();
    });
    window.scanpro.getSchemeStatus().then((s) => {
      schemeState = s;
      refreshIdleFoot();
    });
    serverState = await window.scanpro.getLocalServerState();

    defaults = await window.scanpro.getDefaults();
    setStep('scan');
    setArchChip('upper');
    applyMode(defaults.uiMode === 'dev' ? 'dev' : 'demo');
  }

  // A launch is the only thing that starts a case — the app is idle until the web app sends one,
  // and a launch arriving mid-case restarts on the new one. The main process has already brought
  // the window forward by the time this runs.
  window.scanpro.onLaunch(async ({ url }) => {
    const res = await window.scanpro.decodePayload(url);
    launch = res.ok ? { url, decoded: res.decoded, fields: res.fields } : { url, decoded: null, fields: {} };
    if (uiMode === 'demo') start();
  });

  window.scanpro.onFlowEvent(onFlowEvent);

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
