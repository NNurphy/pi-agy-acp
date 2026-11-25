import { spawn } from "node:child_process";
import { agyEnvironment, killProcessTree } from "./acp-client.ts";
import { agyCommand } from "./config.ts";
import { parseModelRows, type AgyModelRow } from "./model-catalog.ts";

let cache: { expires: number; value: Promise<AgyModelRow[]> } | undefined;

/** `agy models`: proves agy is installed and signed in, and lists the catalog. */
export function captureAgyModels(env: Record<string, string | undefined>, signal?: AbortSignal): Promise<AgyModelRow[]> {
  if (cache && cache.expires > Date.now()) return cache.value;
  const value = new Promise<AgyModelRow[]>((resolve) => {
    let stdout = "";
    let child;
    try {
      child = spawn(agyCommand(env), ["models"], { env: agyEnvironment(env), windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      resolve([]);
      return;
    }
    const timer = setTimeout(() => killProcessTree(child), 60_000);
    const onAbort = () => killProcessTree(child);
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout?.on("data", (chunk) => (stdout += chunk));
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(parseModelRows(stdout));
    };
    child.once("error", done);
    child.once("close", done);
  });
  cache = { expires: Date.now() + 60_000, value };
  value.then((rows) => {
    if (!rows.length && cache?.value === value) cache = undefined;
  });
  return value;
}
