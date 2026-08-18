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
  if (stage === 'refresh' && status !== 'skipped') node.classList.remove('pl-optional');
}
function resetPipeline() {
  document.querySelectorAll('.pl-node').forEach((n) => {
    const optional = n.classList.contains('pl-optional') || n.dataset.stage === 'refresh';
    n.dataset.state = '';
    n.querySelector('.pl-status').textContent = optional ? 'skipped' : 'pending';
    n.querySelector('.pl-detail').textContent = '';
    if (n.dataset.stage === 'refresh') n.classList.add('pl-optional');
  });
}

// ---------------- progress ----------------
function setProgress(name, pct) {
  $('progress-wrap').hidden = false;
  $('progress-name').textContent = name;
  $('progress-pct').textContent = pct + '%';
  $('progress-bar').style.width = pct + '%';
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
    ['externalCaseId', fields.externalCaseId],
    ['fileType', fileTypeLabel(fields.fileType)],
  ];
  for (const [k, v] of rows) {
    const tr = el('tr');
    tr.appendChild(el('td', null, k));
    tr.appendChild(el('td', null, v === null || v === undefined ? '(none)' : String(v)));
    tb.appendChild(tr);
  }
  $('payload-json').textContent = JSON.stringify(decoded, null, 2);
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
    case 'progress': setProgress(payload.label, payload.pct); break;
    case 'result': {
      const { ok, results, failures } = payload;
      if (ok) showBanner(true, `Success — uploaded ${results.length}/1 scan.`);
      else showBanner(false, `Failed — ${failures.map((f) => f.fileName + ': ' + f.error).join('; ')}`);
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
  };
  if (mode === 'url') return { ...common, launchUrl: $('in-launch-url').value.trim() };
  return { ...common, code: $('in-code').value.trim(), treatmentId: $('in-treatment').value.trim() || null };
}

function resetRunState() {
  $('banner').hidden = true;
  resetPipeline();
  txReset();
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
$('btn-clear').addEventListener('click', () => { resetRunState(); logEl.innerHTML = ''; $('payload-body').hidden = true; $('payload-empty').hidden = false; });
$('btn-log-clear').addEventListener('click', () => (logEl.innerHTML = ''));

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

// ---------------- init ----------------
(async function init() {
  const d = await window.scanpro.getDefaults();
  $('cfg-base').value = d.baseUrl;
  $('cfg-api-key').value = d.apiKey;
  $('cfg-client-id').value = d.clientId;
  $('cfg-client-secret').value = d.clientSecret;
  $('env-chip').textContent = 'origin: ' + (d.baseUrl || '').replace(/^https?:\/\//, '');
  $('env-note').textContent = d.envFileFound ? 'prefilled from .env' : 'no .env found — enter values';

  const s = await window.scanpro.getSchemeStatus();
  updateSchemeChip(s);

  // The push subscription is set up at top level; this is the initial pull for the case where
  // the service bound its port before this window existed.
  updateServerChip(await window.scanpro.getLocalServerState());
})();
