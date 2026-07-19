// wks.js — a zero-dependency hub-bus client for a sidecar (Node >=22, built-in WebSocket).
// Vendor this file next to server.js and require it: const { connect } = require('./wks.js');
const fs = require('fs');
const path = require('path');

function readToken() {
  if (process.env.HUB_TOKEN) return process.env.HUB_TOKEN;
  if (process.env.WKS_BUS_TOKEN) return process.env.WKS_BUS_TOKEN;
  try {
    return fs.readFileSync(path.join(__dirname, '.bus-token'), 'utf8').trim();
  } catch {
    return '';
  }
}

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '.settings.json'), 'utf8'));
  } catch {
    return {};
  }
}

// connect() -> { ready, connected, call, publish, on, onStatus, settings } — mirrors window.workspacer.
function connect(opts = {}) {
  const url = opts.url || 'ws://127.0.0.1:7895/bus';
  const source = opts.source || 'sidecar';
  const listeners = new Map(); // type -> Set(cb)
  const pending = new Map(); // id -> { resolve, reject }
  const statusListeners = new Set(); // cb(connected)
  let ws = null;
  let seq = 1;
  let connected = false;
  let settings = readSettings();
  let markReady;
  const ready = new Promise((r) => {
    markReady = r;
  });

  const deliver = (type, data, event) => {
    for (const key of [type, '*']) {
      const set = listeners.get(key);
      if (set) for (const cb of set) try { cb(data, event); } catch {}
    }
  };

  const fireStatus = (c) => {
    for (const cb of statusListeners) try { cb(c); } catch {}
  };

  const open = () => {
    ws = new WebSocket(`${url}?token=${encodeURIComponent(readToken())}`);
    ws.addEventListener('open', () => {
      connected = true;
      ws.send(JSON.stringify({ op: 'subscribe', topics: ['*'] }));
      markReady();
      fireStatus(true);
    });
    ws.addEventListener('message', (ev) => {
      let f;
      try {
        f = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
      } catch {
        return;
      }
      if (f.op === 'event' && f.event) {
        if (f.event.type === 'plugin.settings.changed' && f.event.data) settings = f.event.data;
        deliver(f.event.type, f.event.data, f.event);
      } else if (f.op === 'result' && pending.has(f.id)) {
        pending.get(f.id).resolve(f.result);
        pending.delete(f.id);
      } else if (f.op === 'error' && pending.has(f.id)) {
        pending.get(f.id).reject(new Error(f.error || 'call failed'));
        pending.delete(f.id);
      }
    });
    ws.addEventListener('close', () => {
      connected = false;
      fireStatus(false);
      setTimeout(open, 1000); // reconnect loop
    });
    ws.addEventListener('error', () => {
      try {
        ws.close();
      } catch {}
    });
  };
  open();

  return {
    ready,
    get connected() {
      return connected;
    },
    get settings() {
      return settings;
    },
    call(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = 'c' + seq++;
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ op: 'call', id, method, params }));
      });
    },
    publish(type, data = {}) {
      ws.send(JSON.stringify({ op: 'publish', event: { type, source, data } }));
    },
    on(type, cb) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(cb);
      return () => listeners.get(type)?.delete(cb);
    },
    onStatus(cb) {
      statusListeners.add(cb);
      return () => statusListeners.delete(cb);
    },
  };
}

module.exports = { connect };
