import assert from "node:assert/strict";
import test from "node:test";
import { classifyAgyLog, describeAgyFailure } from "../src/upstream-errors.ts";

/** [log text, expected kind] — expected "none" means "must be ignored". */
const CASES = [
  // capacity
  ["attempt 5 failed (transport error (Unavailable, HTTP 503): No capacity available for model gemini-4-neon-high on the server", "capacity"],
  ["agent executor error: transport error (Unavailable, HTTP 503)", "capacity"],
  ["service_unavailable: backend overloaded", "capacity"],
  // rate limit
  ["RESOURCE_EXHAUSTED: quota exceeded", "rate_limit"],
  ["code 429 too_many_requests", "rate_limit"],
  // subscription quota
  ["You have reached the quota limit for Claude Sonnet 5.5. You can resume using this model at 1/23/2026", "quota"],
  // billing / auth / permission / model
  ["payment_required: prepay credit balance is empty", "payment"],
  ["Error: Authentication required", "auth"],
  ["invalid_grant: Token has been expired or revoked", "auth"],
  ["permission_denied: Your project has been denied access", "permission"],
  ["model_not_found: unknown model gemini-9", "model_not_found"],
  // context / deadline / policy
  ["prompt is too long: input token count 2000000 exceeds the maximum", "context"],
  ["deadline_exceeded (504)", "deadline"],
  ["BlockedReason.RECITATION: output may resemble existing data", "blocked"],
  // generation / server / client
  ["malformed_function_call: could not parse", "malformed_output"],
  ["api_error: internal error occurred", "internal"],
  ["request cancelled (499)", "aborted"],
  ["invalid_request: unsupported tool type", "invalid_request"],
  // transport / local
  ["transport error: connection reset by peer", "network"],
  ["URL: https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse EOF", "network"],
  ["keyring: secure lock out", "local"],
  // noise that must never classify
  ['E1123 client.go:97] Post "https://play.googleapis.com/log": EOF', "none"],
  ["W cache.go:169] Cache(loadCodeAssistResponse): Singleflight refresh failed: error getting token source: You are not logged into Antigravity.", "none"],
  ["Post https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist: EOF", "none"],
  ["W cli_setting_manager.go:452] cli settings not available, using defaults", "none"],
  ["E server.go:3376] Failed to read conversations directory", "none"],
  ["W file_watcher.go:194] skipping empty or temp file:", "none"],
  ["ordinary informational line", "none"],
];

test("classifies every documented failure kind", () => {
  for (const [text, expected] of CASES) {
    const actual = classifyAgyLog(text)?.kind ?? "none";
    assert.equal(actual, expected, `for input: ${text.slice(0, 80)}`);
  }
});

test("ignores a chunk made only of noise", () => {
  const noise = CASES.filter(([, kind]) => kind === "none")
    .map(([text]) => text)
    .join("\n");
  assert.equal(classifyAgyLog(noise), undefined);
});

test("extracts the model name when present", () => {
  const failure = classifyAgyLog(
    "Run: attempt 3 failed (transport error (Unavailable, HTTP 503): No capacity available for model gemini-4-neon-high on the server)",
  );
  assert.equal(failure?.kind, "capacity");
  assert.equal(failure?.model, "gemini-4-neon-high");
  assert.equal(failure?.retryable, true);
});

test("marks non-retryable kinds", () => {
  assert.equal(classifyAgyLog("Error: Authentication required")?.retryable, false);
  assert.equal(classifyAgyLog("permission_denied: project denied")?.retryable, false);
});

test("every kind produces a non-empty message that does not leak internals", () => {
  const kinds = [
    "capacity",
    "rate_limit",
    "quota",
    "payment",
    "auth",
    "permission",
    "model_not_found",
    "context",
    "deadline",
    "blocked",
    "malformed_output",
    "internal",
    "aborted",
    "invalid_request",
    "network",
    "local",
    "unknown",
  ];
  for (const kind of kinds) {
    const message = describeAgyFailure({ kind, retryable: true, raw: "raw line", model: "gemini-4-neon-high" });
    assert.ok(message.length > 10, `message for ${kind} is too short`);
    assert.ok(!message.includes("undefined"), `message for ${kind} leaks undefined`);
  }
});
