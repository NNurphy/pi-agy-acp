# Architecture

```
┌────────────┐   prompt/stream   ┌───────────────┐   JSON-RPC over stdio   ┌──────────┐
│  Pi engine │ ────────────────▶ │  pi-agy-acp   │ ──────────────────────▶ │ agy acp  │
│            │ ◀──────────────── │  (extension)  │ ◀────────────────────── │ (child)  │
└────────────┘   assistant msg   └───────────────┘  session/update, perm.  └────┬─────┘
                                        │                                      │ HTTPS
                                        │ tail ~/.gemini/…/acp-server-*.log    ▼
                                        │                                 Google
```

`agy` is the agent: it owns the conversation, the tools, and the model calls. Pi owns the UI,
the session, and the model picker. The extension translates between the two.

---

## Files

| File | Responsibility |
|---|---|
| `src/config.ts` | Every environment input: executable path, proxy, timeouts, state dir. No machine-specific constant anywhere else. |
| `src/index.ts` | Registers the provider, routes agy's permission requests to Pi's UI, defines `/agy-acp-status` and `/agy-mode`. |
| `src/acp-client.ts` | ACP transport: spawn `agy acp`, JSON-RPC framing, permission round-trips, child-process cleanup. |
| `src/session.ts` | One `AgySession` per Pi session: open/resume, model/effort/mode configuration, idle close, resume memory. |
| `src/stream.ts` | One Pi turn = one ACP prompt. Converts `session/update` events into Pi stream events; classifies failures; decides whether a partial reply is kept. |
| `src/upstream-errors.ts` | Ordered pattern table mapping agy log text → failure kind + message. |
| `src/transcript.ts` | History digest (for resume detection) and the textual transcript used when replaying history into a new agy session. |
| `src/model-catalog.ts` | `agy models` parsing, effort-variant grouping, Pi model metadata. |
| `src/models.ts` | Runs `agy models` (with cache) — also the sign-in probe. |
| `src/mode.ts` | Per-directory execution-mode overrides for `/agy-mode`. |

---

## Turn lifecycle

1. Pi selects a model whose provider is `agy-acp`; the extension has already registered one
   Pi model per agy model slug (`gemini-3.8-flash`, `claude-sonnet-5-5`, …) with the effort
   variants collapsed into Pi thinking levels.
2. On the first turn of a Pi session, `session.ts` spawns `agy acp`, performs `initialize`
   and `session/new` (or `session/load` to resume a remembered agy conversation), then sends
   `session/set_config_option` for model, effort and mode.
3. `stream.ts` sends the newest user message via `session/prompt` and translates
   `session/update` frames: text chunks, thinking chunks, tool calls, usage.
4. agy runs its own tools; permission requests come back as `session/request_permission`
   and are answered by Pi's UI (or auto-approved when `PI_AGY_SKIP_PERMISSIONS=1`).
5. When `session/prompt` returns, Pi gets a final assistant message with usage and stop reason.

### Resume and replay

`agy` keeps conversations on disk and exposes `session/load`. The extension remembers the agy
session id together with a digest of the Pi transcript prefix. If the digest still matches on
the next turn, the conversation simply continues.

If it does not match — a branch, an edit, a different working directory, or a lost agy
session — earlier Pi history is replayed as one text block (`transcript.ts`). This is a
deliberate limitation: ACP has no way to import structured history.

---

## Failure detection

`agy` does not surface upstream errors over ACP. The extension therefore:

1. Locates the log file belonging to the agy child process (`…-<pid>.log`).
2. Records the file size at the start of the turn, so earlier turns cannot bleed in.
3. Polls once per second, reads only appended bytes, and runs `classifyAgyLog`.
4. On a match: cancel the agy turn, then either keep the partial reply (with the cause
   appended) or fail the turn with a specific message.

`PI_AGY_SAFETY_TIMEOUT` (default one hour) exists solely so a turn can never hang forever.
It is not used to infer *why* something failed — that always comes from agy's own text.

---

## Process and state

| Thing | Lifetime |
|---|---|
| `agy acp` child | One per Pi session; closed after ten minutes idle, on shutdown, or on failure |
| Permission requests | Forwarded to Pi's UI while a turn streams |
| `/agy-mode` overrides | Persisted per directory in `<pi agent dir>/state/pi-agy-acp-modes.json` |
| Model list | Cached for 60 s; `agy models` also serves as the sign-in probe |

---

## Why an extension rather than a proxy

`agy` already speaks a documented protocol and already talks to Google with the official
client identity. Wrapping that process adds a front end without intercepting credentials or
re-signing traffic. Writing a proxy that impersonates the client would add surface area,
drift with every agy release, and — depending on the provider's terms — carry account risk.
The extension only translates; it never authenticates on your behalf.