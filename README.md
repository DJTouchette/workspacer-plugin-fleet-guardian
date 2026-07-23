# Fleet Guardian

Autonomy with brakes: pause on rate limits, downgrade on budget.

A [workspacer](https://github.com/DJTouchette/workspacer) hub plugin (sidecar). It runs unattended on the hub bus and applies two automatic brakes to your agent fleet so a runaway spend or an imminent rate-limit doesn't need you at the keyboard.

## What it does

Fleet Guardian keeps a live picture of every agent by **reacting to `agent.statusline` / `agent.snapshot` events** (for fast response) **and polling `agents.list` every ~20s** (the authoritative per-session cost source — cost is not yet a standalone bus event). Against that picture it runs two guards, each firing at most once per condition:

1. **Rate-limit brake.** Every session's status line carries the account-wide usage windows (5h / 7d / monthly). When the fleet's **peak window utilization crosses `rateLimitPct`**, the guard `claude.signal`s `SIGINT` to the **highest-cost active agent** — interrupting its current turn rather than killing it — and posts one `notifications.post` warning. It fires only **once per episode** and **re-arms** automatically once utilization drops back under the threshold. If the threshold is crossed while the roster is empty/unknown (e.g. a status line arrives before the first successful `agents.list`), the guard refreshes the roster inline and — if there is still nothing to pause — warns once but stays armed, so the brake still fires the moment an active agent appears.
2. **Budget brake.** If `budgetUSD > 0` and a session's `costUSD` reaches it, the guard `claude.setModel`s that session down to `downgradeModel` (a cheaper model) instead of stopping work, and warns. This is tracked **once per session** (by sessionId) so it never thrashes; a session is forgotten when it leaves the roster.

Both guards are serialized, so a burst of status-line ticks can't double-fire an action. Capability calls are wrapped in try/catch; on the app side being down (`no provider`) it logs and moves on. The status pane (open the **Fleet Guardian** pane) shows every agent's state, cost, usage windows, and which brakes are engaged.

## Notifications

Every enforcement action lands in the in-app notification center (bell + toast) and, unless disabled, an OS notification — via `notifications.post`:

- **Pause** → `level: "warn"`, body with the window and utilization (e.g. "5h window at 92% (≥90%)"), the paused agent's `sessionId` as the click target (click = jump to that agent), keyed per session.
- **Model downgrade** → `level: "warn"`, body with the spend vs. budget and the new model, the downgraded agent's `sessionId`, keyed per session.
- **Recovery** → when utilization drops back under the threshold, each pause warning is *replaced* (same key) by a `level: "info"` "Rate limit recovered — agent can be resumed" entry, so the center shows the current truth instead of a stale alarm.
- The "over threshold but nothing to pause" case posts one keyed `level: "warn"` entry per episode, also replaced by the recovery info.

Each condition fires at most once per episode/session, so there is no noise to configure away.

**On cost as a poll, not an event:** continuous per-session cost isn't published on the bus, so budget detection relies on the `agents.list` poll (status-line `cost_usd` is also used when present, for faster reaction). Rate-limit windows *do* arrive on the status-line events, so the rate-limit brake reacts within a tick.

## Bus wiring

- **Subscribes to:** `agent.snapshot`, `agent.statusline`
- **Calls capabilities:** `agents.list`, `claude.signal`, `claude.setModel`, `notifications.post`
- **Emits:** —
- **Settings:**
- `rateLimitPct` (number) — Pause spendy agents when a window crosses this utilization.
- `budgetUSD` (number) — 0 = off. Downgrade a session's model past this spend.
- `downgradeModel` (string) — Model to switch to on budget overrun.

## Run it

1. Copy this folder to `~/.config/workspacer/plugins/fleet-guardian/` (or install from GitHub via the workspacer command palette → *Install from GitHub…* → `DJTouchette/workspacer-plugin-fleet-guardian`).
2. Reload plugins in workspacer.
   The hub supervises `node server.js` and injects the bus token.
3. Open the **Fleet Guardian** pane from the command palette.

## Implement

The logic lives in `server.js`:

- `onEvent(event)` normalizes `agent.statusline` (snake_case `five_hour_pct`/`cost_usd`) and `agent.snapshot` (camelCase `statusLine.fiveHourPct`/`usage.costUSD`) into a per-session state map, then schedules an evaluation.
- `poll()` calls `agents.list` every ~20s to refresh authoritative cost + roster and prune gone sessions.
- `evalRateLimit()` / `evalBudget()` are the two brakes, run through a serialized `evaluate()` (a debounced, non-reentrant runner) so a status-line flood can't double-fire.

**Capabilities called:** `agents.list`, `claude.signal` (`{sessionId, signal:'SIGINT'}`), `claude.setModel` (`{sessionId, model}`), `notifications.post` (`{title, body, level, sessionId, key, source}` — see Notifications above).

**Settings** (host-injected via `WKS_SETTINGS`): `rateLimitPct` (default 90), `budgetUSD` (default 0 = off), `downgradeModel` (default `claude-haiku-4-5`).

## Layout

```
fleet-guardian/
  plugin.json      # manifest (events + capabilities)
  server.js        # zero-dep Node sidecar; implement onEvent()
  README.md
```

## License

MIT
