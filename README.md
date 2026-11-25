# pi-agy-acp

An experimental [Pi](https://pi.dev) extension that uses the **Google Antigravity CLI** (`agy acp`) as a model provider.

Antigravity is Google's agent-first development platform; its CLI exposes an
[Agent Client Protocol](https://antigravity.google/docs/cli/acp) (`ACP`) server.
This extension registers that server as a Pi provider, so the models your Antigravity
account can use (Gemini, Claude, …) show up in Pi's model list like any other provider.

```
Pi  ──▶  pi-agy-acp  ──ACP (JSON-RPC over stdio)──▶  agy acp  ──▶  Google
```

**This is not a proxy.** No traffic is intercepted or re-signed: the official `agy`
binary talks to Google, Pi only acts as the front end.

---

## Requirements

| Item | Version |
|---|---|
| Pi | ≥ 1.5 |
| Node.js | ≥ 22.19 |
| Antigravity CLI (`agy`) | installed and signed in |

Install and sign in to the CLI first:

```bash
# macOS / Linux
curl -fsSL https://antigravity.google/cli/install.sh | bash

# Windows (PowerShell)
irm https://antigravity.google/cli/install.ps1 | iex

agy --version     # verify
agy models        # verify sign-in; prints the models your account can use
```

`agy models` must print rows. If it asks you to sign in, run `agy` once and finish the
browser flow.

---

## Install

**Option A — drop it into Pi's extension directory**

```bash
git clone https://github.com/NNurphy/pi-agy-acp.git ~/.pi/agent/extensions/pi-agy-acp
```

**Option B — keep it anywhere and reference it from settings**

```jsonc
// ~/.pi/agent/settings.json
{
  "extensions": ["/absolute/path/to/pi-agy-acp"]
}
```

Restart Pi (or `/reload`), then `pi --list-models | grep agy-acp`.

> A new engine process is required for code changes: in web front ends such as
> [pi-shell](https://github.com/NNurphy/pi-shell), open a new column or restart the app.

---

## Configuration

Every setting is optional; the plugin works with none of them.

| Variable | Default | Purpose |
|---|---|---|
| `PI_AGY_COMMAND` | auto-detected | Path to the `agy` executable. Auto-detection checks the platform's usual install location, then `agy` on `PATH`. |
| `PI_AGY_PROXY` | unset | Proxy for the agy child process (`http://127.0.0.1:7890`). Only applied when `HTTPS_PROXY`/`HTTP_PROXY` are not already set. |
| `PI_AGY_SKIP_PERMISSIONS` | `0` | `1` = auto-approve every tool call (`--dangerously-skip-permissions`). Only use in trusted workspaces. |
| `PI_AGY_MODE` | agy default | Execution mode: `default` / `accept-edits` / `auto` / `plan`. |
| `PI_AGY_HOME` | unset | Isolated home for agy, so your global agy rules/skills do not apply. |
| `PI_AGY_SAFETY_TIMEOUT` | `3600` | Seconds before a turn with no result is abandoned. A guard against hanging, **not** a failure detector. |
| `PI_AGY_WATCH_LOG` | `1` | Tail agy's own log to surface upstream errors. `0` disables. |
| `PI_AGY_LOG_DIR` | `~/.gemini/antigravity-cli/log` | Where agy writes `acp-server-*.log`. |
| `PI_AGY_STATE_DIR` | `<pi agent dir>/state` | Where `/agy-mode` remembers per-directory choices. |

### Commands

| Command | Description |
|---|---|
| `/agy-acp-status` | Show whether agy is reachable, how many models it reports, and live sessions |
| `/agy-mode` | Show the current execution mode for this folder |
| `/agy-mode plan` | Read-only planning: produce a plan, change no files, run no commands |
| `/agy-mode accept-edits` | Apply file edits automatically, still ask for commands |
| `/agy-mode auto` | Edits and sandboxed commands run automatically |
| `/agy-mode reset` | Clear the folder override |

Modes are remembered per working directory and survive restarts.

---

## How failures are reported

`agy` writes upstream failures to its own log and does **not** answer the ACP request, so a
naive client waits forever. This extension tails that log for the current turn and maps
agy's own error text onto Google's documented error codes
([reference](https://ai.google.dev/gemini-api/docs/api-errors)):

| Kind | Typical text | Meaning |
|---|---|---|
| `capacity` | `No capacity available for model X` | Model out of capacity (503) — not your quota |
| `rate_limit` | `RESOURCE_EXHAUSTED`, `429` | Too many requests |
| `quota` | `reached the quota limit … resume at …` | Subscription window exhausted |
| `payment` | `payment_required` | Credits/billing |
| `auth` | `Authentication required`, `invalid_grant` | Sign-in expired |
| `permission` | `permission_denied`, project denied | Account/project restriction |
| `model_not_found` | `model_not_found` | Model unavailable |
| `context` | `prompt is too long` | Context limit |
| `deadline` | `deadline_exceeded`, `504` | Upstream timeout |
| `blocked` | `safety`, `recitation` | Content policy |
| `malformed_output` | `malformed_tool_call` | Bad tool-call output |
| `internal` | `api_error`, `500` | Server-side error |
| `aborted` | `cancelled`, `499` | Cancelled |
| `invalid_request` | `invalid_request`, `400` | Bad parameters |
| `network` | `transport error`, `TLS handshake`, `EOF` | Connectivity |
| `local` | `keyring`, `advisory lock` | Local environment |

Each kind carries a retryable flag and a suggested next step. If a turn fails **after**
producing text, the text is kept and the cause is appended, so you can continue instead of
re-running the whole turn. Full details: [`docs/ERROR-CODES.md`](docs/ERROR-CODES.md).

---

## Limitations

- Pi's own tools do not participate in an agy turn: agy runs its own agent loop with its own
  tools, Pi only renders the result. To run Gemini with Pi's native tooling, use the Gemini API.
- History hand-off is textual: agy cannot import structured Pi history over ACP. When a
  session starts or branches, earlier turns are replayed as a transcript block.
- `agy acp` is documented but young; this extension is experimental and pins no agy version.
- Not affiliated with Google. Your use of Antigravity is governed by Google's terms.

## Development

```bash
npm test          # classifier unit tests (node:test, no dependencies)
pi -e ./src/index.ts --list-models | grep agy-acp
```

Layout: `src/config.ts` (all environment inputs), `src/acp-client.ts` (ACP transport),
`src/session.ts` (Pi session ↔ agy session), `src/stream.ts` (turn → Pi stream events),
`src/upstream-errors.ts` (error table). See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## License

MIT — see [LICENSE](LICENSE). Not affiliated with or endorsed by Google.