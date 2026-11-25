/**
 * Central configuration. Everything environment-dependent lives here so the rest of the
 * plugin carries no machine-specific paths, ports, or personal defaults.
 *
 * All settings are optional environment variables; the plugin works with none of them.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Windows environment keys are case-insensitive; compare that way. */
export function envValue(env: Record<string, string | undefined>, name: string): string | undefined {
  if (env[name] !== undefined) return env[name];
  if (process.platform !== "win32") return undefined;
  const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key ? env[key] : undefined;
}

function truthy(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  const value = raw.trim().toLowerCase();
  return !(value === "0" || value === "false" || value === "no" || value === "off");
}

/**
 * Path to the Antigravity CLI executable.
 *
 * Order: `PI_AGY_COMMAND` → common install locations per platform → `agy` on PATH.
 * On Windows an absolute `.exe` path matters: `CreateProcess` cannot run `.cmd` shims,
 * and applications launched from a desktop shortcut inherit a stale PATH.
 */
export function agyCommand(env: Record<string, string | undefined>): string {
  const configured = envValue(env, "PI_AGY_COMMAND");
  if (configured) return configured;
  const candidates =
    process.platform === "win32"
      ? [
          join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "agy", "bin", "agy.exe"),
          join(homedir(), "AppData", "Local", "agy", "bin", "agy.exe"),
        ]
      : [join(homedir(), ".local", "bin", "agy"), "/usr/local/bin/agy", "/opt/homebrew/bin/agy"];
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return candidate;
    } catch {
      // ignore and try the next candidate
    }
  }
  return "agy";
}

/**
 * Optional isolated HOME for agy (`PI_AGY_HOME`). Unset means agy uses the real home, so
 * the user's own agy rules, skills and settings apply exactly as in the agy CLI.
 */
export function agyHome(env: Record<string, string | undefined>): string | undefined {
  return envValue(env, "PI_AGY_HOME") || undefined;
}

/**
 * Proxy for the agy child process (`PI_AGY_PROXY`, e.g. `http://127.0.0.1:7890`).
 *
 * Unset by default. When set, it is only injected if the environment has no
 * `HTTPS_PROXY`/`HTTP_PROXY` already, so existing system settings always win.
 */
export function agyProxy(env: Record<string, string | undefined>): string | undefined {
  return envValue(env, "PI_AGY_PROXY") || undefined;
}

/**
 * Auto-approve agy's tool permission requests (`PI_AGY_SKIP_PERMISSIONS`).
 *
 * Default **false**: the plugin asks through Pi's UI, exactly like the agy CLI would.
 * Set to `1` only in trusted workspaces — it lets agy run commands and write files
 * without asking.
 */
export function skipPermissions(env: Record<string, string | undefined>): boolean {
  return truthy(envValue(env, "PI_AGY_SKIP_PERMISSIONS"), false);
}

/** Last-resort guard so a turn can never hang forever (`PI_AGY_SAFETY_TIMEOUT`, seconds). */
export function safetyTimeoutMs(): number {
  const raw = process.env.PI_AGY_SAFETY_TIMEOUT;
  const seconds = raw === undefined ? 3600 : Number(raw);
  return (Number.isFinite(seconds) && seconds > 0 ? seconds : 3600) * 1000;
}

/** Tail agy's own log for upstream errors (`PI_AGY_WATCH_LOG`, default on). */
export function watchAgyLog(): boolean {
  return truthy(process.env.PI_AGY_WATCH_LOG, true);
}

/** Directory holding agy's own `acp-server-*.log` files (`PI_AGY_LOG_DIR`). */
export function agyLogDir(): string {
  return process.env.PI_AGY_LOG_DIR || join(homedir(), ".gemini", "antigravity-cli", "log");
}

/**
 * Where the plugin stores its per-directory state (`PI_AGY_STATE_DIR`).
 * Defaults to `<pi agent dir>/state`, using the same resolution Pi uses.
 */
export function stateDir(): string {
  const explicit = process.env.PI_AGY_STATE_DIR;
  if (explicit) return explicit;
  const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  return join(agentDir, "state");
}