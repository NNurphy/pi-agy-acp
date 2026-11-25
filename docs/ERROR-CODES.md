# Error codes

`agy` reports upstream problems **only in its own log file**. It writes something like

```
E1123 22:45:19.320716  352 errorreport.go:282] agent executor error: generating and executing:
  transport error (Unavailable, HTTP 503): No capacity available for model gemini-4-neon-high …
```

and never answers the ACP `session/prompt` request. A client that only speaks ACP therefore
waits forever. This extension tails the log file that belongs to the `agy` child process
(`~/.gemini/antigravity-cli/log/acp-server-*-<pid>.log`), reads **only the bytes appended
during the current turn**, and classifies the text.

The classification table is derived from

- [Gemini API error codes](https://ai.google.dev/gemini-api/docs/api-errors) — the authoritative list
  of `code` values and HTTP statuses.
- [Gemini API troubleshooting](https://ai.google.dev/gemini-api/docs/troubleshooting) — retry advice.
- [Antigravity CLI troubleshooting](https://antigravity.google/docs/cli/troubleshooting) — local
  environment failures (`keyring`, updater lock, PATH).
- The actual error lines found in `agy` logs, so the patterns match real output rather than
  documentation wording.

---

## Kinds

| Kind | Retryable | Matched text (abridged) | Meaning | Suggested action |
|---|---|---|---|---|
| `capacity` | yes | `No capacity available`, `UNAVAILABLE (code 503)`, `503` | Model is out of capacity | Switch model, retry later. Not a quota problem. |
| `rate_limit` | yes | `RESOURCE_EXHAUSTED`, `rate_limit_exceeded`, `too_many_requests`, `429` | Request rate too high | Wait 1–2 min, retry with backoff |
| `quota` | no | `quota_exceeded`, `reached the quota limit`, `resets at` | Subscription window exhausted | Wait for reset, switch model, or use another account |
| `payment` | no | `payment_required`, `prepay`, `credit balance` | Billing / credits | Add credits |
| `auth` | no | `Authentication required`, `invalid_grant`, `401` | Sign-in expired | Sign in again (`agy`) |
| `permission` | no | `permission_denied`, `project has been denied`, `403` | Account/project restriction | Check account eligibility and subscription tier |
| `model_not_found` | no | `model_not_found`, `unknown model`, `404` | Model not available | Choose another model |
| `context` | no | `prompt is too long`, `context length`, `too many tokens` | Context limit | Compact or start a new session |
| `deadline` | yes | `deadline_exceeded`, `504`, `408` | Upstream timeout | Retry |
| `blocked` | no | `safety`, `recitation`, `prohibited_content`, `spii`, `blocklist`, `unsupported language` | Policy block | Rephrase; do not resend unchanged |
| `malformed_output` | yes | `malformed_function_call`, `malformed_tool_call`, `unexpected_tool_call`, `missing_thought_signature` | Model emitted an unusable tool call | Retry once |
| `internal` | yes | `api_error`, `internal`, `500`, `501` | Server-side failure | Retry after a pause |
| `aborted` | no | `cancelled`, `499`, `aborted` | Request cancelled | Nothing to do |
| `invalid_request` | no | `invalid_request`, `failed_precondition`, `400` | Bad parameters | Simplify the request or switch model |
| `network` | yes | `transport error`, `connection reset`, `TLS handshake`, `EOF`, `proxyconnect` | Connectivity | Check network/proxy (`PI_AGY_PROXY`) |
| `local` | no | `keyring`, `advisory lock`, `update.lock`, `must be an absolute path` | Local environment | Re-authenticate; clear the updater lock |

Order matters: the list is evaluated top to bottom, so `transport error (Unavailable, HTTP 503):
No capacity available` classifies as `capacity` rather than `network`.

---

## Noise filtering

A working `agy` writes thousands of lines that *look* like errors. They are ignored, or every
turn would be treated as a failure:

| Pattern | Why it is noise |
|---|---|
| `play.googleapis.com … EOF` | Telemetry; fails whenever telemetry egress is blocked |
| `Singleflight refresh failed` | Background cache refresh |
| `Failed to poll ListExperiments` | Background experiment polling |
| `error getting token source` / `Not reloading plugin MCP servers` | Startup sequencing, resolves on its own |
| `loadCodeAssist` / `listExperiments` / `v2/userinfo` / `retrieveUserQuotaSummary` | Background metadata calls, unrelated to the current turn |
| `cli settings not available`, `Failed to read conversations directory`, `failed to get cs path` | Cosmetic warnings on first run |

Only lines outside that list are classified, and only bytes appended during the current turn
are read — an error from a previous turn cannot leak into this one.

---

## Partial results

When a turn fails after the model already produced text, the text is kept and the cause is
appended:

```
… produced so far …
---
⚠️ agy 上游容量不足 503（模型 gemini-4-neon-high）: …
以上为本轮已收到的内容；回复「继续」可从断点往下做。
```

The message is finalised as a normal reply (`stop`), not an error, so Pi does not retry the
whole turn.

---

## Adding a kind

1. Add a rule to `RULES` in `src/upstream-errors.ts` (order = priority).
2. Add a message to `describeAgyFailure`.
3. Add a case to `test/upstream-errors.test.mjs`.

No other file needs to change.