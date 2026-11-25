/**
 * Per-working-directory agy execution mode override.
 *
 * agy's mode (`default` | `accept-edits` | `auto` | `plan`) decides which tool calls need
 * permission. Environment variables cannot be used per session inside pi-shell (the bridge
 * inherits a frozen environment), so the mode is stored per cwd in a small JSON file and can
 * be changed at runtime with the `/agy-mode` command.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { stateDir } from "./config.ts";

export const MODES = ["default", "accept-edits", "auto", "plan"] as const;
export type AgyMode = (typeof MODES)[number];

const STATE_FILE = join(stateDir(), "pi-agy-acp-modes.json");

let cache: Record<string, string> | undefined;

function load(): Record<string, string> {
  if (cache) return cache;
  try {
    const raw = JSON.parse(readFileSync(STATE_FILE, "utf8")) as Record<string, string>;
    cache = raw && typeof raw === "object" ? raw : {};
  } catch {
    cache = {};
  }
  return cache;
}

function persist(data: Record<string, string>): boolean {
  try {
    mkdirSync(dirname(STATE_FILE), { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(data, null, 2) + "\n", "utf8");
    cache = data;
    return true;
  } catch {
    cache = data;
    return false;
  }
}

/** Effective mode: per-cwd override, else PI_AGY_MODE, else undefined (agy default). */
export function getMode(cwd: string, env: Record<string, string | undefined>): string | undefined {
  const saved = load()[cwd];
  if (saved && (MODES as readonly string[]).includes(saved)) return saved;
  const key = Object.keys(env).find((k) => k.toLowerCase() === "pi_agy_mode");
  return (key ? env[key] : undefined) ?? process.env.PI_AGY_MODE;
}

/** Set/clear the override for a cwd. Returns the file path and whether it was persisted. */
export function setMode(cwd: string, mode: string | null): { persisted: boolean; mode: string | null } {
  const data = { ...load() };
  if (mode) data[cwd] = mode;
  else delete data[cwd];
  return { persisted: persist(data), mode };
}