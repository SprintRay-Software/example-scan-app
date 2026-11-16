// Renderer logic. Talks to the main process only through window.scanpro (see preload.cjs).
// It renders the streamed flow events into a pipeline stepper, the decoded payload, a full
// request/response viewer, and a live log — so a tester can watch the whole data flow.

'use strict';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

// Minimal TreatmentFiles names for the two intra-oral scan slots (matches the backend enum).
const FILE_TYPE_NAMES = { 1: 'UpperJaw', 2: 'LowerJaw' };
const fileTypeLabel = (v) => (v === null || v === undefined ? 'null (full scan)' : `${v} (${FILE_TYPE_NAMES[v] || 'type ' + v})`);

// Pretty-print a body: parse JSON strings so nested payloads read cleanly; otherwise raw.
function prettyBody(body) {
  if (body === undefined || body === null || body === '') return '(empty)';
  if (typeof body !== 'string') {
    try { return JSON.stringify(body, null, 2); } catch { return String(body); }
  }
  const t = body.trim();
  if (t.startsWith('{') || t.startsWith('[') || t.startsWith('"')) {
    try { return JSON.stringify(JSON.parse(t), null, 2); } catch { /* not JSON */ }
  }
  return body;
}

function headerTable(headers) {
  const wrap = el('div');
  const keys = Object.keys(headers || {});
  if (keys.length === 0) { wrap.appendChild(el('div', 'hint', '(none)')); return wrap; }
  const table = el('table', 'kv');
  const tb = el('tbody');
  for (const k of keys) {
    const tr = el('tr');
    tr.appendChild(el('td', null, k));
    tr.appendChild(el('td', null, String(headers[k])));
    tb.appendChild(tr);
  }
  table.appendChild(tb);
  wrap.appendChild(table);
  return wrap;
}

function codeBlockWithCopy(text) {
  const wrap = el('div');
  const pre = el('pre', 'code', text);
  wrap.appendChild(pre);
  return wrap;
}

// ---------------- log ----------------
const logEl = $('log');
function logLine(kind, msg) {
  const now = new Date().toISOString().slice(11, 23);
  const line = el('div');
  line.appendChild(el('span', 'l-time', now + '  '));
  const marks = { step: '> ', ok: 'OK ', fail: 'XX ', info: '   ' };
  const body = el('span', 'l-' + kind, (marks[kind] || '   ') + msg);
  line.appendChild(body);
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
}

// ---------------- pipeline ----------------
function setPhase(stage, status, detail) {
  const node = document.querySelector(`.pl-node[data-stage="${stage}"]`);
  if (!node) return;
  node.dataset.state = status;
  node.querySelector('.pl-status').textContent = status;
  if (detail !== undefined) node.querySelector('.pl-detail').textContent = detail || '';
  // A step the run actually reached stops being dimmed as optional.
  if (status !== 'skipped') node.classList.remove('pl-optional');
}
function resetPipeline() {
  document.querySelectorAll('.pl-node').forEach((n) => {
    // data-optional marks the steps a run may legitimately not reach (token refresh, and the
    // scan-finish call on the Form B dev path), so they read "skipped" rather than "pending".
    const optional = n.dataset.optional === '1';
    n.dataset.state = '';
    n.querySelector('.pl-status').textContent = optional ? 'skipped' : 'pending';
    n.querySelector('.pl-detail').textContent = '';
    n.classList.toggle('pl-optional', optional);
  });
}

// ---------------- progress ----------------
// Uploads run concurrently, so the one bar is the batch: it moves on total bytes across every
// file in flight, and names the file only while there is a single one. Flipping the label
// between racing files would make the bar look like it kept restarting.
const progressFiles = new Map(); // label -> { sent, total }

function setProgress({ label, sent, total, pct }) {
  progressFiles.set(label, { sent: sent ?? 0, total: total ?? 0 });

  let sentAll = 0;
  let totalAll = 0;
  for (const f of progressFiles.values()) {
    sentAll += f.sent;
    totalAll += f.total;
  }
  const batchPct = totalAll > 0 ? Math.min(100, Math.floor((sentAll / totalAll) * 100)) : (pct ?? 0);

  $('progress-wrap').hidden = false;
  $('progress-name').textContent =
    progressFiles.size === 1 ? label : `${progressFiles.size} files`;
  $('progress-pct').textContent = batchPct + '%';
  $('progress-bar').style.width = batchPct + '%';
}

// ---------------- tooth conditions ----------------
// What each segmented tooth IS — the closed vocabulary src/scan-report.js validates against, and
// what the CLI takes as `--tooth-condition 8=prepared,9=restored`. This chart is the UI for that
// flag. Numbers are ALWAYS universal here, whatever the payload's toothSystem asks the doctor to
// be shown; the report never sends the other system.
const TOOTH_CONDITIONS = ['prepared', 'missing', 'restored'];

// Universal numbering: 1-16 is the upper arch, 17-32 the lower. The lower row runs 32 -> 17 so
// each tooth sits under the one it occludes with, the way a chart is drawn.
const UPPER_ROW = Array.from({ length: 16 }, (_, i) => i + 1);
const LOWER_ROW = Array.from({ length: 16 }, (_, i) => 32 - i);

const toothConditions = new Map(); // universal tooth number -> condition
let conditionBrush = TOOTH_CONDITIONS[0];
// Which arches the next run captures, taken from the decoded payload: 1 = upper only, 2 = lower
// only, null = full-mouth scan (both). buildScanReport() drops a condition on a tooth the session
// never captured, so the chart dims those instead of letting them look reported.
let capturedFileType = null;

const isUpperTooth = (tooth) => tooth <= 16;

function toothIsCaptured(tooth) {
  if (capturedFileType === 1) return isUpperTooth(tooth);
  if (capturedFileType === 2) return !isUpperTooth(tooth);
  return true;
}

function buildConditionBrushes() {
  const seg = $('cond-seg');
  seg.innerHTML = '';
  for (const condition of TOOTH_CONDITIONS) {
    const btn = el('button', 'seg-btn');
    btn.type = 'button';
    btn.setAttribute('role', 'radio');
    btn.dataset.cond = condition;
    btn.appendChild(el('i', 'cond-dot'));
    btn.appendChild(el('span', null, condition[0].toUpperCase() + condition.slice(1)));
    seg.appendChild(btn);
  }
  setConditionBrush(conditionBrush);
}

function buildTeethChart() {
  const chart = $('teeth-chart');
  chart.innerHTML = '';
  for (const row of [UPPER_ROW, LOWER_ROW]) {
    const rowEl = el('div', 'teeth-row');
    for (const tooth of row) {
      const btn = el('button', 'tooth', String(tooth));
      btn.type = 'button';
      btn.dataset.tooth = String(tooth);
      btn.addEventListener('click', () => paintTooth(tooth));
      rowEl.appendChild(btn);
    }
    chart.appendChild(rowEl);
  }
  renderTeeth();
}

// Clicking a tooth that already carries the selected condition clears it, so the one control both
// sets and unsets and there is no separate eraser to find.
function paintTooth(tooth) {
  if (toothConditions.get(tooth) === conditionBrush) toothConditions.delete(tooth);
  else toothConditions.set(tooth, conditionBrush);
  renderTeeth();
}

function setConditionBrush(condition) {
  conditionBrush = condition;
  for (const btn of $('cond-seg').querySelectorAll('.seg-btn[data-cond]')) {
    const on = btn.dataset.cond === condition;
    btn.classList.toggle('seg-active', on);
    btn.setAttribute('aria-checked', String(on));
  }
}

function renderTeeth() {
  for (const btn of $('teeth-chart').querySelectorAll('.tooth')) {
    const tooth = Number(btn.dataset.tooth);
    const condition = toothConditions.get(tooth);
    if (condition) btn.dataset.cond = condition;
    else delete btn.dataset.cond;

    const captured = toothIsCaptured(tooth);
    btn.classList.toggle('out-of-scope', !captured);
    btn.title =
      `tooth ${tooth} (${isUpperTooth(tooth) ? 'upper' : 'lower'} arch, universal)` +
      (condition ? ` - ${condition}` : '') +
      (captured ? '' : ' - not in the arch this run captures, so the report drops it');
  }
  renderTeethSummary();
}

function renderTeethSummary() {
  const out = $('teeth-summary');
  out.innerHTML = '';
  const pairs = [...toothConditions.entries()].sort((a, b) => a[0] - b[0]);

  if (pairs.length === 0) {
    out.className = 'teeth-summary hint';
    out.textContent = 'no condition set — every segmented tooth is reported with condition null';
    return;
  }

  // Show the value that reproduces this run on the CLI: the chart is a nicer way to type the flag,
  // not a different feature.
  out.className = 'teeth-summary';
  out.appendChild(el('code', null, '--tooth-condition ' + toothConditionList()));

  const dropped = pairs.filter(([tooth]) => !toothIsCaptured(tooth)).map(([tooth]) => tooth);
  if (dropped.length > 0) {
    out.appendChild(
      el('div', 'teeth-warn', `${dropped.join(', ')}: not in the captured arch — dropped from the report`)
    );
  }
}

/** The picker's value in the `<tooth>=<condition>` form the flow's parser takes. */
function toothConditionList() {
  return [...toothConditions.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([tooth, condition]) => `${tooth}=${condition}`)
    .join(',');
}

// ---------------- payload panel ----------------
function renderPayload({ decoded, fields }) {
  $('payload-empty').hidden = true;
  $('payload-body').hidden = false;
  const tb = $('fields-table').querySelector('tbody');
  tb.innerHTML = '';
  const rows = [
    ['auth.code', fields.code],
    ['auth.tokenEndpoint', fields.tokenEndpoint],
    ['treatmentId', fields.treatmentId],
    ['scanJobId (case.ID)', fields.scanJobId],
    ['fileType', fileTypeLabel(fields.fileType)],
  ];
  for (const [k, v] of rows) {
    const tr = el('tr');
    tr.appendChild(el('td', null, k));
    tr.appendChild(el('td', null, v === null || v === undefined ? '(none)' : String(v)));
    tb.appendChild(tr);
  }
  $('payload-json').textContent = JSON.stringify(decoded, null, 2);

  // A payload naming a fileType is a single-arch rescan, so only that arch's teeth can carry a
  // reported condition — the chart follows the payload rather than letting the other row lie.
  capturedFileType = fields.fileType ?? null;
  renderTeeth();
}

// ---------------- transactions ----------------
const txEls = new Map(); // id -> { statusEl, durEl, respWrap }
function txReset() { $('tx-list').innerHTML = ''; txEls.clear(); $('tx-empty').hidden = false; }

function paneWithCopy(title, contentNode, copyText) {
  const pane = el('div', 'tx-pane');
  const h = el('h3');
  h.appendChild(el('span', null, title));
  if (copyText) {
    const btn = el('button', 'copy-btn', 'Copy');
    btn.addEventListener('click', () => {
      navigator.clipboard.writeText(copyText).then(() => {
        btn.textContent = 'Copied';
        setTimeout(() => (btn.textContent = 'Copy'), 1200);
      });
    });
    h.appendChild(btn);
  }
  pane.appendChild(h);
  pane.appendChild(contentNode);
  return pane;
}

function txStart({ id, label, method, url, headers, body, bodyNote }) {
  $('tx-empty').hidden = true;
  const card = el('div', 'tx');
  card.dataset.id = id;

  const head = el('div', 'tx-head');
  const toggle = el('span', 'tx-toggle', '-');
  const methodEl = el('span', 'tx-method' + (method === 'PUT' ? ' m-put' : ''), method);
  const labelEl = el('span', 'tx-label', label);
  const urlEl = el('span', 'tx-url', url);
  urlEl.title = url;
  const statusEl = el('span', 'tx-status s-flight', 'in-flight');
  const durEl = el('span', 'tx-dur', '');
  head.append(toggle, methodEl, labelEl, urlEl, durEl, statusEl);

  const bodyWrap = el('div', 'tx-body');

  // request pane
  const reqContent = el('div');
  reqContent.appendChild(el('div', 'tx-sub', 'Headers'));
  reqContent.appendChild(headerTable(headers));
  reqContent.appendChild(el('div', 'tx-sub', 'Body'));
  const reqBodyText = bodyNote !== undefined ? bodyNote : prettyBody(body);
  reqContent.appendChild(codeBlockWithCopy(reqBodyText));
  bodyWrap.appendChild(paneWithCopy('Request', reqContent, bodyNote !== undefined ? undefined : (body || '')));

  // response pane (placeholder until httpEnd)
  const respContent = el('div');
  respContent.appendChild(el('div', 'hint', 'awaiting response...'));
  const respPane = paneWithCopy('Response', respContent);
  bodyWrap.appendChild(respPane);

  head.addEventListener('click', () => bodyWrap.classList.toggle('collapsed'));

  card.append(head, bodyWrap);
  $('tx-list').appendChild(card);
  txEls.set(id, { statusEl, durEl, respPane });
}

function txEnd({ id, ok, status, statusText, headers, body, durationMs }) {
  const rec = txEls.get(id);
  if (!rec) return;
  rec.statusEl.textContent = `${status} ${statusText || ''}`.trim();
  rec.statusEl.className = 'tx-status ' + (ok ? 's-ok' : 's-err');
  rec.durEl.textContent = durationMs + ' ms';

  const content = el('div');
  content.appendChild(el('div', 'tx-sub', 'Status'));
  content.appendChild(el('div', 'code', `${status} ${statusText || ''}`.trim()));
  content.appendChild(el('div', 'tx-sub', 'Headers'));
  content.appendChild(headerTable(headers));
  content.appendChild(el('div', 'tx-sub', 'Body'));
  content.appendChild(codeBlockWithCopy(prettyBody(body)));

  // rebuild the response pane with a copy button for the raw body
  const newPane = paneWithCopy('Response', content, body || '');
  rec.respPane.replaceWith(newPane);
  rec.respPane = newPane;
}

function txError({ id, message, durationMs }) {
  const rec = txEls.get(id);
  if (!rec) return;
  rec.statusEl.textContent = 'network error';
  rec.statusEl.className = 'tx-status s-err';
  rec.durEl.textContent = durationMs + ' ms';
  const content = el('div');
  content.appendChild(el('div', 'code', message));
  const newPane = paneWithCopy('Response', content);
  rec.respPane.replaceWith(newPane);
  rec.respPane = newPane;
}

// ---------------- banner ----------------
function showBanner(ok, text) {
  const b = $('banner');
  b.hidden = false;
  b.className = 'banner ' + (ok ? 'banner-ok' : 'banner-err');
  b.textContent = text;
}

// ---------------- flow event dispatch ----------------
window.scanpro.onFlowEvent(({ type, payload }) => {
  switch (type) {
    case 'phase': setPhase(payload.stage, payload.status, payload.detail); break;
    case 'step': logLine('step', payload.msg); break;
    case 'ok': logLine('ok', payload.msg); break;
    case 'fail': logLine('fail', payload.msg); break;
    case 'info': logLine('info', payload.msg); break;
    case 'payload': renderPayload(payload); break;
    case 'httpStart': txStart(payload); break;
    case 'httpEnd': txEnd(payload); break;
    case 'httpError': txError(payload); break;
    case 'progress': setProgress(payload); break;
    case 'result': {
      const { ok, results, failures, meshes } = payload;
      // A full-mouth scan uploads both arches, and the finish call may add a mesh per segmented
      // tooth and per arch's gingiva — so both counts come from the run, not from a fixed total.
      const meshCount = meshes?.length ?? 0;
      if (ok) {
        showBanner(
          true,
          `Success — uploaded ${results.length} scan(s)` + (meshCount > 0 ? ` + ${meshCount} mesh(es).` : '.')
        );
      } else {
        // A failure may be a file (a scan or a mesh) or a step with no file behind it.
        showBanner(false, `Failed — ${failures.map((f) => (f.fileName ?? f.step) + ': ' + f.error).join('; ')}`);
      }
      break;
    }
    default: break;
  }
});

// ---------------- launches (URL scheme or the local HTTP service) ----------------
function handleLaunch({ url, source }) {
  setMode('url');
  $('in-launch-url').value = url;
  logLine(
    'info',
    source === 'local-server'
      ? 'Received a launch payload from the local HTTP service (POST /scanpro/v1/start).'
      : 'Received deep link from the OS.'
  );
  decodeOnly();
}

// Subscribe at top level, NOT from init(). The main process pushes a queued launch and the
// local-server state the moment the page finishes loading; init() is async and only reaches
// its first line after several IPC round-trips, so a listener registered there is too late
// and the launch is delivered to nobody.
window.scanpro.onLaunch(handleLaunch);
window.scanpro.onLocalServerState(updateServerChip);

// ---------------- run / decode ----------------
function currentConfig() {
  return {
    baseUrl: $('cfg-base').value.trim(),
    apiKey: $('cfg-api-key').value.trim(),
    clientId: $('cfg-client-id').value.trim(),
    clientSecret: $('cfg-client-secret').value.trim(),
  };
}

let mode = 'url';
function currentInput() {
  const common = {
    demoRefresh: $('in-refresh').checked,
    upperFileOverride: $('in-file-upper').value.trim() || null,
    lowerFileOverride: $('in-file-lower').value.trim() || null,
    // This app's own name for each file (externalScanFileType). Null = not overridden, so the
    // main process falls back to the .env's names and then the built-in ones.
    upperScanFileType: $('in-scan-type-upper').value.trim() || null,
    lowerScanFileType: $('in-scan-type-lower').value.trim() || null,
    // Sent as the CLI's own `<tooth>=<condition>` string, not as a Map: the main process parses it
    // with the same parseToothConditions() the CLI uses, so both paths validate in one place.
    toothConditionList: toothConditionList() || null,
  };
  if (mode === 'url') return { ...common, launchUrl: $('in-launch-url').value.trim() };
  return { ...common, code: $('in-code').value.trim(), treatmentId: $('in-treatment').value.trim() || null };
}

function resetRunState() {
  $('banner').hidden = true;
  resetPipeline();
  txReset();
  progressFiles.clear();
  $('progress-wrap').hidden = true;
  $('progress-bar').style.width = '0';
}

async function runFlow() {
  const cfg = currentConfig();
  const input = currentInput();
  if (mode === 'url' && !input.launchUrl) { logLine('fail', 'Paste a launch URL first.'); return; }
  if (mode === 'manual' && !input.code) { logLine('fail', 'Enter a device-login code first.'); return; }
  if (!cfg.clientId || !cfg.clientSecret) { logLine('fail', 'Client ID and secret are required.'); return; }
  if (!cfg.apiKey) { logLine('fail', 'API key is required — the gateway rejects a call without x-api-key.'); return; }

  resetRunState();
  $('env-chip').textContent = 'origin: ' + cfg.baseUrl.replace(/^https?:\/\//, '');
  const btn = $('btn-run');
  btn.disabled = true;
  btn.textContent = 'Running...';
  try {
    const res = await window.scanpro.runFlow({ config: cfg, input });
    if (!res.ok) showBanner(false, 'Failed — ' + res.error);
  } catch (err) {
    showBanner(false, 'Failed — ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Run flow';
  }
}

async function decodeOnly() {
  const url = $('in-launch-url').value.trim();
  if (!url) { logLine('fail', 'Paste a launch URL to decode.'); return; }
  const res = await window.scanpro.decodePayload(url);
  if (res.ok) { renderPayload(res); logLine('ok', 'Decoded launch payload.'); }
  else { logLine('fail', 'Decode failed: ' + res.error); }
}

// ---------------- wiring ----------------
function setMode(next) {
  mode = next;
  $('mode-url').classList.toggle('seg-active', next === 'url');
  $('mode-manual').classList.toggle('seg-active', next === 'manual');
  $('pane-url').hidden = next !== 'url';
  $('pane-manual').hidden = next !== 'manual';
}

$('mode-url').addEventListener('click', () => setMode('url'));
$('mode-manual').addEventListener('click', () => setMode('manual'));
$('btn-run').addEventListener('click', runFlow);
$('btn-decode').addEventListener('click', decodeOnly);
$('btn-clear').addEventListener('click', () => {
  resetRunState();
  logEl.innerHTML = '';
  $('payload-body').hidden = true;
  $('payload-empty').hidden = false;
  // The decoded payload is gone from the screen, so nothing says which arches a run would capture
  // any more. The picked conditions stay: like the config fields, they are input, not run state.
  capturedFileType = null;
  renderTeeth();
});
$('cond-seg').addEventListener('click', (event) => {
  const btn = event.target.closest('.seg-btn[data-cond]');
  if (btn) setConditionBrush(btn.dataset.cond);
});
$('btn-teeth-clear').addEventListener('click', () => {
  toothConditions.clear();
  renderTeeth();
});
$('btn-log-clear').addEventListener('click', () => (logEl.innerHTML = ''));

buildConditionBrushes();
buildTeethChart();

function wireSecretToggle(buttonId, inputId) {
  $(buttonId).addEventListener('click', () => {
    const inp = $(inputId);
    const show = inp.type === 'password';
    inp.type = show ? 'text' : 'password';
    $(buttonId).textContent = show ? 'Hide' : 'Show';
  });
}

wireSecretToggle('btn-toggle-secret', 'cfg-client-secret');
wireSecretToggle('btn-toggle-api-key', 'cfg-api-key');

function wireFilePicker(buttonId, inputId) {
  $(buttonId).addEventListener('click', async () => {
    const res = await window.scanpro.pickFile();
    if (!res.canceled) $(inputId).value = res.path;
  });
}

wireFilePicker('btn-pick-upper', 'in-file-upper');
wireFilePicker('btn-pick-lower', 'in-file-lower');

$('btn-claim-scheme').addEventListener('click', async () => {
  const s = await window.scanpro.setDefaultScheme();
  updateSchemeChip(s);
});

function updateSchemeChip(s) {
  const chip = $('scheme-chip');
  chip.textContent = `scheme: ${s.scheme}:// ${s.isDefault ? '(this app)' : '(not default)'}`;
  chip.className = 'chip ' + (s.isDefault ? 'chip-ok' : 'chip-warn');
}

// The local HTTP service the web app probes on 127.0.0.1 — the other launch transport.
function updateServerChip(state) {
  const chip = $('server-chip');
  if (!state || state.status === 'starting') {
    chip.textContent = 'server: starting...';
    chip.className = 'chip chip-muted';
    chip.title = 'Local HTTP service on 127.0.0.1';
    return;
  }
  if (state.status === 'disabled') {
    chip.textContent = 'server: off';
    chip.className = 'chip chip-muted';
    chip.title = 'Local HTTP service disabled (SCANPRO_LOCAL_SERVER=0)';
    return;
  }
  if (state.status === 'restarting') {
    // The simulated OTA install replaced the service: it is down until it comes back, maybe
    // on another port.
    chip.textContent = `server: restarting (was :${state.previousPort})`;
    chip.className = 'chip chip-warn';
    chip.title = 'Simulated OTA install: the local service is being replaced';
    return;
  }
  if (state.status === 'listening') {
    chip.textContent = `server: 127.0.0.1:${state.port}`;
    chip.className = 'chip chip-ok';
    chip.title = (state.endpoints || []).join('\n');
    return;
  }
  chip.textContent = 'server: failed';
  chip.className = 'chip chip-warn';
  chip.title =
    `No free port in ${state.portRangeStart}-${state.portRangeEnd}. ` +
    (state.telemetrySent
      ? 'local_server.port_unavailable was reported.'
      : 'Telemetry not sent (endpoint/key not configured).');
}

// ---------------- OTA simulator panel ----------------
// Mirrors the local service's /update/status and edits the simulator switches through IPC. The
// switches are simulator-only; the status is exactly what a caller of /update/status sees.
const OTA_FAILURE_CODES = {
  downloading: ['E_DOWNLOAD_FAILED', 'E_INSUFFICIENT_DISK_SPACE', 'E_TIMEOUT', 'E_UNKNOWN'],
  'download.verifying': ['E_VERIFY_FAILED', 'E_UNKNOWN'],
  'install.verifying': ['E_VERIFY_FAILED', 'E_UNKNOWN'],
  installing: ['E_INSTALL_FAILED', 'E_USER_CANCELLED', 'E_TIMEOUT', 'E_UNKNOWN'],
  restarting: ['E_INSTALL_FAILED', 'E_TIMEOUT', 'E_UNKNOWN'],
};

const otaRefs = (s) => (s ? `${s.action ? `${s.action}.` : ''}${s.phase}` : '');

function fillFailCodes(phase, selected) {
  const sel = $('ota-fail-code');
  sel.innerHTML = '';
  for (const code of OTA_FAILURE_CODES[phase] || []) {
    const opt = document.createElement('option');
    opt.value = code;
    opt.textContent = code;
    sel.appendChild(opt);
  }
  sel.disabled = !phase;
  if (selected) sel.value = selected;
}

// Inputs the tester is typing in are left alone by the 1 s refresh.
const otaEditing = (id) => document.activeElement === $(id);

function renderOta(snap) {
  if (!snap) return;
  const st = snap.status || { phase: 'idle' };
  const box = $('ota-status');
  box.classList.toggle('is-failed', st.phase === 'failed');
  box.classList.toggle('is-done', st.phase === 'completed' || st.phase === 'downloaded');
  $('ota-phase').textContent = st.action ? `${st.action} · ${st.phase}` : st.phase;
  $('ota-versions').textContent = st.toVersion ? `${st.fromVersion ?? 'null'} → ${st.toVersion}` : '';
  $('ota-bar').style.width = `${st.percent ?? (st.phase === 'idle' ? 0 : 100)}%`;
  $('ota-bar').classList.toggle('progress-indeterminate', st.percent === null && st.phase !== 'idle');
  const err = $('ota-error');
  err.hidden = !st.error;
  err.textContent = st.error ? `${st.error.code}: ${st.error.message}` : '';
  const installed = snap.scanPro?.version ?? '—';
  const pkg = snap.packages?.app;
  $('ota-meta').textContent =
    `installed ${installed}` +
    (st.percent !== null && st.percent !== undefined ? ` · ${st.percent}%` : '') +
    (pkg ? ` · package ${pkg.package.version} on disk` : '') +
    (st.updatedAt ? ` · updated ${st.updatedAt.slice(11, 19)}` : '');

  const sim = snap.sim;
  if (!sim) return;
  if (!otaEditing('ota-download-mode')) $('ota-download-mode').value = sim.downloadMode;
  if (!otaEditing('ota-speed')) $('ota-speed').value = String(+(sim.downloadBytesPerSec / 1048576).toFixed(2));
  if (!otaEditing('ota-restart-delay')) $('ota-restart-delay').value = String(sim.restartDelayMs / 1000);
  if (!otaEditing('ota-running')) $('ota-running').value = sim.scanPro.running === null ? '' : String(sim.scanPro.running);
  const failRef = otaRefs(sim.fail);
  if (!otaEditing('ota-fail-phase') && !otaEditing('ota-fail-code')) {
    $('ota-fail-phase').value = failRef;
    fillFailCodes(failRef, sim.fail?.code);
  }
  if (!otaEditing('ota-stall')) $('ota-stall').value = otaRefs(sim.stall);
  $('ota-port-switch').checked = sim.portSwitch;
  $('ota-bad-signature').checked = sim.signatureInvalid;
  $('ota-version-mismatch').checked = sim.versionMismatch;
  $('ota-unsupported').checked = sim.unsupported;
  $('ota-no-route').checked = sim.noUpdateRoute;
  $('ota-inactive').checked = sim.inactiveSession;
}

async function patchOta(patch) {
  const res = await window.scanpro.patchOta(patch);
  $('ota-note').textContent = res.ok ? '' : res.error;
  renderOta(res.snapshot);
}

function wireOtaPanel() {
  $('ota-download-mode').addEventListener('change', (e) => patchOta({ downloadMode: e.target.value }));
  $('ota-speed').addEventListener('change', (e) => patchOta({ downloadBytesPerSec: Number(e.target.value) * 1048576 }));
  $('ota-restart-delay').addEventListener('change', (e) => patchOta({ restartDelayMs: Number(e.target.value) * 1000 }));
  $('ota-running').addEventListener('change', (e) =>
    patchOta({ scanPro: { running: e.target.value === '' ? null : e.target.value === 'true' } })
  );

  const applyFail = () => {
    const phase = $('ota-fail-phase').value;
    if (!phase) return patchOta({ fail: null });
    const spec = `${phase}:${$('ota-fail-code').value}`;
    return patchOta($('ota-fail-once').checked ? { failOnce: spec } : { fail: spec });
  };
  $('ota-fail-phase').addEventListener('change', (e) => {
    fillFailCodes(e.target.value);
    applyFail();
  });
  $('ota-fail-code').addEventListener('change', applyFail);
  $('ota-fail-once').addEventListener('change', applyFail);
  $('ota-stall').addEventListener('change', (e) => patchOta({ stall: e.target.value || null }));

  const toggles = {
    'ota-port-switch': 'portSwitch',
    'ota-bad-signature': 'signatureInvalid',
    'ota-version-mismatch': 'versionMismatch',
    'ota-unsupported': 'unsupported',
    'ota-no-route': 'noUpdateRoute',
    'ota-inactive': 'inactiveSession',
  };
  for (const [id, key] of Object.entries(toggles)) {
    $(id).addEventListener('change', (e) => patchOta({ [key]: e.target.checked }));
  }

  $('btn-ota-reset').addEventListener('click', async () => renderOta(await window.scanpro.resetOta()));

  // The status moves on its own (the step runs in the service), so the panel just re-reads it.
  const refresh = async () => {
    try {
      renderOta(await window.scanpro.getOta());
    } catch {
      // main process busy restarting the service — next tick
    }
  };
  refresh();
  setInterval(refresh, 1000);
}

wireOtaPanel();

// ---------------- init ----------------
(async function init() {
  const d = await window.scanpro.getDefaults();
  $('cfg-base').value = d.baseUrl;
  $('cfg-api-key').value = d.apiKey;
  $('cfg-client-id').value = d.clientId;
  $('cfg-client-secret').value = d.clientSecret;
  $('env-chip').textContent = 'origin: ' + (d.baseUrl || '').replace(/^https?:\/\//, '');
  // Name the file that was actually read: with --env-file it is not necessarily `.env`, and a
  // run pointed at the wrong environment has to be visible here.
  const envName = (d.envFilePath || '').split(/[\\/]/).pop() || '.env';
  $('env-note').textContent = d.envFileFound
    ? `prefilled from ${envName}`
    : `no ${envName} found — enter values`;

  // Per-file scan type: prefilled with what an untouched run sends, so the name on screen is the
  // name on the wire; the datalist offers ScanPro's own names, typing anything else is fine.
  for (const arch of ['upper', 'lower']) {
    const field = $(`in-scan-type-${arch}`);
    field.value = d.scanFileTypes[arch];
    field.placeholder = d.scanFileTypes[arch];
  }
  const options = $('scan-file-type-options');
  options.innerHTML = '';
  for (const name of d.scanFileTypeOptions || []) {
    const opt = document.createElement('option');
    opt.value = name;
    options.appendChild(opt);
  }

  const s = await window.scanpro.getSchemeStatus();
  updateSchemeChip(s);

  // The push subscription is set up at top level; this is the initial pull for the case where
  // the service bound its port before this window existed.
  updateServerChip(await window.scanpro.getLocalServerState());
})();
