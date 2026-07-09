# Fleet Guardian

Autonomy with brakes: pause on rate limits, downgrade on budget.

A [workspacer](https://github.com/DJTouchette/workspacer) hub plugin (sidecar). **Runnable scaffold** — it loads, connects to the hub bus, and shows live activity; the real logic is stubbed with clear TODOs.

## What it does

Watches account usage (`agent.statusline`). When you approach a rate-limit threshold it can `claude.signal` to pause spendy agents; when a session blows its budget it can `claude.setModel` it down to a cheaper model instead of stopping. NOTE: continuous per-session cost is not yet a bus event — until then this polls `agents.list`.

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

Edit `server.js` → `onEvent(event)`. Subscribed topics arrive there; use `call('method', params)` for capabilities and `publish('command.x', data)` for commands. `settings` holds the host-injected config above.

## Layout

```
fleet-guardian/
  plugin.json      # manifest (events + capabilities)
  server.js        # zero-dep Node sidecar; implement onEvent()
  README.md
```

## License

MIT
