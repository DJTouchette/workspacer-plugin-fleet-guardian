#!/usr/bin/env node
// Fleet Guardian — autonomy with brakes. Zero-dependency workspacer plugin
// sidecar (Node >= 22: global WebSocket, fetch). It watches the fleet's live
// usage and, without a human in the loop, applies two brakes:
//
//   1. Rate limit — if ANY account usage window (5h / 7d / monthly) crosses
//      `rateLimitPct`, it SIGINTs the highest-cost active agent (pausing its
//      current turn) and posts one warning. It re-arms once the fleet drops
//      back under the threshold.
//   2. Budget — if `budgetUSD > 0` and a session's costUSD reaches it, it
//      switches that session to `downgradeModel` (once per session) and warns.
//
// It reacts to `agent.statusline` / `agent.snapshot` events for fast response
// AND polls `agents.list` every ~20s (per-session cost is not a bus event, so
// the poll is the authoritative cost source — see README).
const http = require('http');
const fs = require('fs');
const path = require('path');
const { connect } = require('./wks.js');

const DIR = __dirname;
const manifest = JSON.parse(fs.readFileSync(path.join(DIR, 'plugin.json'), 'utf8'));
const PORT = Number(process.env.PORT || (manifest.server && manifest.server.port) || 9202);

// Connect to the hub bus via the vendored plugin SDK (wks.js). It reads the
// scoped token (HUB_TOKEN / WKS_BUS_TOKEN / .bus-token), subscribes, delivers
// events, and reconnects if the hub goes away. Settings come from the SDK too.
const wks = connect({ source: manifest.id });
const settings = wks.settings;

function numOr(v, dflt) { const n = Number(v); return Number.isFinite(n) ? n : dflt; }
const RATE_PCT = numOr(settings.rateLimitPct, 90);
const BUDGET_USD = numOr(settings.budgetUSD, 0);
const DOWNGRADE_MODEL =
  (typeof settings.downgradeModel === 'string' && settings.downgradeModel.trim()) || 'claude-haiku-4-5';
const POLL_MS = 20000;
// Signal used to "pause" an agent: interrupt the current turn (not kill it).
const PAUSE_SIGNAL = 'SIGINT';
// States in which an agent is actively spending tokens (worth pausing).
const ACTIVE_STATES = new Set(['thinking', 'streaming', 'responding', 'working']);

const TOPICS = manifest.consumes || [];
const recent = [];

// ── Guard state ───────────────────────────────────────────────────────────────
// sessionId -> { cwd, model, state, costUSD, windows:{fiveHour,sevenDay,monthly} }
const sessions = new Map();
const downgraded = new Set();        // budget guard: sessions already downgraded
const pausedForRateLimit = new Set(); // sessions SIGINT'd during the current trip
let rateLimitTripped = false;        // brake fired this episode (only after a successful pause)
let noActiveNotified = false;        // "over threshold but nothing to pause" notified this episode

function log(msg) {
  console.log('[' + manifest.id + '] ' + msg);
  recent.unshift(new Date().toISOString() + '  ' + msg);
  if (recent.length > 100) recent.pop();
}

// Route each consumed topic to onEvent (the SDK subscribes to '*' internally).
for (const t of TOPICS) wks.on(t, (data, event) => onEvent(event).catch((e) => log('onEvent error: ' + e.message)));
// On each (re)connect, log config and snapshot the roster right away.
wks.onStatus((c) => {
  if (!c) return;
  log('connected; subscribed to ' + (TOPICS.join(', ') || '(nothing)') +
    `; rateLimitPct=${RATE_PCT} budgetUSD=${BUDGET_USD} downgradeModel=${DOWNGRADE_MODEL}`);
  poll().catch((e) => log('poll error: ' + e.message)); // snapshot the roster right away
});

// Post to the in-app notification center (+ OS toast unless the user disabled
// it). Callers pass level/sessionId/key so enforcement actions are clickable
// (jump to the affected agent) and a repeated condition replaces its own slot
// instead of stacking.
async function notify(fields) {
  try { await wks.call('notifications.post', { source: 'plugin:' + manifest.id, ...fields }); }
  catch (e) { log('notify failed: ' + e.message); }
}

// ── Normalization (tolerate camelCase snapshot + snake_case statusline) ─────────
function num(v) { return typeof v === 'number' && Number.isFinite(v) ? v : undefined; }
function short(id) { return String(id || '').slice(0, 8); }

function sessionFor(id) {
  let s = sessions.get(id);
  if (!s) { s = { cwd: undefined, model: undefined, state: undefined, costUSD: undefined, windows: {} }; sessions.set(id, s); }
  if (!s.windows) s.windows = {};
  return s;
}

// Merge a status-line object (either camelCase SessionStatusLine or the raw
// snake_case claudemon StatusLine) into a session.
function applyStatusLine(s, sl) {
  if (!sl || typeof sl !== 'object') return;
  const w = s.windows;
  const five = num(sl.fiveHourPct != null ? sl.fiveHourPct : sl.five_hour_pct);
  const seven = num(sl.sevenDayPct != null ? sl.sevenDayPct : sl.seven_day_pct);
  const monthly = num(sl.monthlyPct != null ? sl.monthlyPct : sl.monthly_pct);
  if (five !== undefined) w.fiveHour = five;
  if (seven !== undefined) w.sevenDay = seven;
  if (monthly !== undefined) w.monthly = monthly;
  const cost = num(sl.costUSD != null ? sl.costUSD : sl.cost_usd);
  if (cost !== undefined) s.costUSD = cost;
  if (sl.model_display && !s.model) s.model = sl.model_display;
  if (sl.modelDisplay && !s.model) s.model = sl.modelDisplay;
}

function isActive(s) {
  return !!s && ACTIVE_STATES.has(String(s.state || '').toLowerCase());
}

// Highest utilization across every known session's usage windows. Windows are
// account-wide, so any session's window reflects the shared limit.
function fleetPeakUtilization() {
  let max = -1, which = null;
  for (const [id, s] of sessions) {
    const w = s.windows || {};
    for (const key of [['fiveHour', '5h'], ['sevenDay', '7d'], ['monthly', 'monthly']]) {
      const v = w[key[0]];
      if (typeof v === 'number' && v > max) { max = v; which = { sessionId: id, window: key[1], pct: v }; }
    }
  }
  return { max, which };
}

// ── The two guards (serialized so a statusline flood can't double-fire) ─────────
let evaluating = false, evalQueued = false, evalTimer = null;

function scheduleEvaluate() {
  if (evalTimer) return;
  evalTimer = setTimeout(() => {
    evalTimer = null;
    evaluate().catch((e) => log('evaluate error: ' + e.message));
  }, 300);
}

async function evaluate() {
  if (evaluating) { evalQueued = true; return; }
  evaluating = true;
  try {
    do {
      evalQueued = false;
      await evalRateLimit();
      await evalBudget();
    } while (evalQueued);
  } finally { evaluating = false; }
}

async function evalRateLimit() {
  const { max, which } = fleetPeakUtilization();
  if (max < 0) return; // no window data yet
  if (max >= RATE_PCT) {
    if (rateLimitTripped) return; // already braked this episode
    let active = [...sessions.entries()]
      .filter(([, s]) => isActive(s))
      .sort((a, b) => (b[1].costUSD || 0) - (a[1].costUSD || 0));
    if (active.length === 0) {
      // The roster may simply not be loaded yet (e.g. a statusline arrived
      // before the first successful agents.list — provider briefly absent).
      // Refresh it inline and re-check before concluding there's nothing to
      // pause; otherwise stay UN-tripped so the brake still fires as soon as
      // the roster shows an active agent, and notify only once per episode.
      try {
        const list = await wks.call('agents.list', {});
        if (Array.isArray(list)) {
          for (const a of list) {
            if (!a || !a.sessionId) continue;
            const s = sessionFor(a.sessionId);
            if (a.cwd != null) s.cwd = a.cwd;
            if (a.model != null) s.model = a.model;
            if (a.state != null) s.state = a.state;
            const cost = num(a.costUSD);
            if (cost !== undefined) s.costUSD = cost;
          }
        }
      } catch (e) {
        log('agents.list refresh failed: ' + e.message);
      }
      active = [...sessions.entries()]
        .filter(([, s]) => isActive(s))
        .sort((a, b) => (b[1].costUSD || 0) - (a[1].costUSD || 0));
    }
    if (active.length === 0) {
      if (noActiveNotified) return; // stay re-armable; already warned this episode
      noActiveNotified = true;
      log(`rate limit ${which.window} at ${max.toFixed(0)}% (>=${RATE_PCT}%) — no active agents to pause`);
      await notify({
        title: 'Rate limit approaching',
        body: `Account ${which.window} window at ${max.toFixed(0)}% (≥${RATE_PCT}%). No active agents to pause.`,
        level: 'warn',
        key: 'fleet-guardian:rate-limit',
      });
      return;
    }
    const [topId, top] = active[0];
    try {
      await wks.call('claude.signal', { sessionId: topId, signal: PAUSE_SIGNAL });
      rateLimitTripped = true;
      pausedForRateLimit.add(topId);
      log(`rate limit ${which.window} at ${max.toFixed(0)}% — paused highest-cost agent ${short(topId)} ($${(top.costUSD || 0).toFixed(2)})`);
    } catch (e) {
      // Leave the flag unset so the next cycle retries the pause.
      log('claude.signal failed: ' + e.message);
      return;
    }
    await notify({
      title: 'Rate limit — agent paused',
      body:
        `Account ${which.window} window at ${max.toFixed(0)}% (≥${RATE_PCT}%). Interrupted highest-cost active agent ` +
        `${short(topId)} (${top.cwd || '?'}, $${(top.costUSD || 0).toFixed(2)})` +
        (active.length > 1 ? ` — ${active.length - 1} other active agent(s) left running.` : '.'),
      level: 'warn',
      sessionId: topId,
      key: 'fleet-guardian:pause:' + topId,
    });
  } else if (rateLimitTripped || noActiveNotified) {
    // Dropped back under threshold — re-arm so the brake can fire again later.
    // Replace each pause warning (same key) with an all-clear so the center
    // shows the current truth, not a stale alarm.
    const recovered = `Peak window utilization back to ${max.toFixed(0)}% (<${RATE_PCT}%).`;
    for (const id of pausedForRateLimit) {
      await notify({
        title: 'Rate limit recovered',
        body: recovered + ` Paused agent ${short(id)} can be resumed.`,
        level: 'info',
        sessionId: id,
        key: 'fleet-guardian:pause:' + id,
      });
    }
    if (noActiveNotified && pausedForRateLimit.size === 0) {
      await notify({
        title: 'Rate limit recovered',
        body: recovered,
        level: 'info',
        key: 'fleet-guardian:rate-limit',
      });
    }
    rateLimitTripped = false;
    noActiveNotified = false;
    pausedForRateLimit.clear();
    log(`rate limit recovered (peak ${max.toFixed(0)}% < ${RATE_PCT}%) — guard re-armed`);
  }
}

async function evalBudget() {
  if (BUDGET_USD <= 0) return;
  for (const [id, s] of sessions) {
    if (downgraded.has(id)) continue;
    const cost = s.costUSD;
    if (typeof cost !== 'number' || cost < BUDGET_USD) continue;
    if (s.model && s.model === DOWNGRADE_MODEL) { downgraded.add(id); continue; } // already cheap
    downgraded.add(id); // reserve first so a statusline flood can't double-fire
    try {
      await wks.call('claude.setModel', { sessionId: id, model: DOWNGRADE_MODEL });
      log(`budget: ${short(id)} hit $${cost.toFixed(2)} (>=$${BUDGET_USD}) — downgraded to ${DOWNGRADE_MODEL}`);
    } catch (e) {
      downgraded.delete(id); // failed — allow a retry next cycle
      log(`claude.setModel failed for ${short(id)}: ${e.message}`);
      continue;
    }
    await notify({
      title: 'Budget reached — model downgraded',
      body: `${short(id)} (${s.cwd || '?'}) reached $${cost.toFixed(2)} (≥$${BUDGET_USD}). Switched to ${DOWNGRADE_MODEL}.`,
      level: 'warn',
      sessionId: id,
      key: 'fleet-guardian:budget:' + id,
    });
  }
}

// ── Poll loop: authoritative per-session cost + roster ──────────────────────────
async function poll() {
  if (!wks.connected) return;
  let list;
  try { list = await wks.call('agents.list', {}); }
  catch (e) { log('agents.list failed: ' + e.message); return; }
  if (!Array.isArray(list)) return;
  const seen = new Set();
  for (const a of list) {
    if (!a || !a.sessionId) continue;
    seen.add(a.sessionId);
    const s = sessionFor(a.sessionId);
    if (a.cwd != null) s.cwd = a.cwd;
    if (a.model != null) s.model = a.model;
    if (a.state != null) s.state = a.state;
    const cost = num(a.costUSD);
    if (cost !== undefined) s.costUSD = cost;
  }
  // Prune sessions no longer in the roster — they can't spend and shouldn't
  // hold the account-window peak open (a gone session's stale window would
  // block re-arm forever).
  for (const id of [...sessions.keys()]) {
    if (!seen.has(id)) { sessions.delete(id); downgraded.delete(id); pausedForRateLimit.delete(id); }
  }
  scheduleEvaluate();
}

// ── Bus wiring ─────────────────────────────────────────────────────────────────
async function onEvent(event) {
  const type = event && event.type;
  const data = event && event.data;
  if (!data || typeof data !== 'object') return;

  if (type === 'agent.statusline') {
    const id = data.sessionId || data.session_id;
    if (!id) return;
    const sl = data.statusLine || data.status_line || data;
    applyStatusLine(sessionFor(id), sl);
    scheduleEvaluate();
    return;
  }

  if (type === 'agent.snapshot') {
    const id = data.sessionId || data.session_id;
    if (!id) return;
    const s = sessionFor(id);
    if (data.cwd != null) s.cwd = data.cwd;
    if (data.ambientState != null) s.state = data.ambientState;
    const sl = data.statusLine || data.status_line;
    if (sl) applyStatusLine(s, sl);
    // usage.costUSD is the transcript-derived cost; use it if the status line
    // didn't carry one.
    if (s.costUSD === undefined && data.usage) {
      const uc = num(data.usage.costUSD != null ? data.usage.costUSD : data.usage.cost_usd);
      if (uc !== undefined) s.costUSD = uc;
    }
    scheduleEvaluate();
  }
}

// Poll on a timer regardless of event traffic (cost isn't event-driven).
setInterval(() => { poll().catch((e) => log('poll error: ' + e.message)); }, POLL_MS);

const server = http.createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200); return res.end('ok'); }
  const peak = fleetPeakUtilization();
  const rows = [...sessions.entries()].map(([id, s]) => {
    const w = s.windows || {};
    const win = ['fiveHour', 'sevenDay', 'monthly']
      .map((k) => (typeof w[k] === 'number' ? `${k === 'fiveHour' ? '5h' : k === 'sevenDay' ? '7d' : 'mo'} ${w[k].toFixed(0)}%` : null))
      .filter(Boolean).join(' ') || '—';
    const flags = [downgraded.has(id) ? 'downgraded' : null, pausedForRateLimit.has(id) ? 'paused' : null]
      .filter(Boolean).join(',');
    return `${short(id)}  ${s.state || '?'}  $${(s.costUSD || 0).toFixed(2)}  ${win}  ${flags}`;
  });
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end('<!doctype html><meta charset=utf-8><meta http-equiv=refresh content=2>'
    + '<title>' + manifest.name + '</title><body style="font-family:system-ui;'
    + 'background:var(--wks-bg-base,#161616);color:var(--wks-text-primary,#e8e8e8);margin:0;padding:14px">'
    + '<h2 style="font-size:1rem">🛡 ' + manifest.name + '</h2>'
    + '<p style="color:var(--wks-text-muted,#888);font-size:.8rem">'
    + (wks.connected ? '\u{1F7E2} connected' : '\u{1F534} disconnected')
    + ` · pause ≥${RATE_PCT}% · budget ` + (BUDGET_USD > 0 ? `$${BUDGET_USD}→${DOWNGRADE_MODEL}` : 'off')
    + ` · peak usage ${peak.max >= 0 ? peak.max.toFixed(0) + '%' : '—'}`
    + (rateLimitTripped ? ' · ⚠ rate-limit brake engaged' : '') + '</p>'
    + '<pre style="font-size:.72rem;color:var(--wks-text-faint,#aaa);white-space:pre-wrap">'
    + (escapeHtml(rows.join('\n')) || 'no agents yet…') + '</pre>'
    + '<h3 style="font-size:.8rem;color:var(--wks-text-muted,#888)">recent</h3>'
    + '<pre style="font-size:.68rem;color:var(--wks-text-faint,#777);white-space:pre-wrap">'
    + (recent.map(escapeHtml).join('\n') || 'waiting for events…') + '</pre>');
});
function escapeHtml(s) { return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }
server.listen(PORT, '127.0.0.1', () => log('pane on http://127.0.0.1:' + PORT));
