import { spawn, type ChildProcess } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { createInterface } from "node:readline";
import { agyCommand, agyHome, agyProxy, envValue, skipPermissions } from "./config.ts";

export const INSTALL_HINT =
  "The Antigravity CLI (agy) was not found. Install it from https://antigravity.google/docs/cli " +
  "or set PI_AGY_COMMAND to the executable.";

export function agyEnvironment(env: Record<string, string | undefined>): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const [key, value] of Object.entries({ ...process.env, ...env })) if (value !== undefined) merged[key] = value;
  const home = agyHome(env);
  if (home) {
    for (const key of Object.keys(merged)) if (/^(USERPROFILE|HOME)$/iu.test(key)) delete merged[key];
    merged.USERPROFILE = home;
    merged.HOME = home;
  }
  merged.AGY_CLI_DISABLE_AUTO_UPDATE = "1";
  // A host process may not forward its proxy settings to child processes. When the user
  // provides PI_AGY_PROXY we apply it, but never override an existing proxy setting.
  if (!envValue(merged, "HTTPS_PROXY") && !envValue(merged, "HTTP_PROXY")) {
    const proxy = agyProxy(env);
    if (proxy) {
      merged.HTTPS_PROXY = proxy;
      merged.HTTP_PROXY = proxy;
    }
  }
  return merged;
}

export function killProcessTree(child: ChildProcess): void {
  if (child.exitCode !== null || child.pid === undefined) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/F", "/T", "/PID", String(child.pid)], { stdio: "ignore", windowsHide: true }).unref();
    return;
  }
  try {
    child.kill("SIGKILL");
  } catch {
    // Already gone.
  }
}

// ---------------------------------------------------------------------------
// ACP types (the subset agy 1.5.x uses)

export interface PermissionOption {
  optionId: string;
  name: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always" | string;
}

export interface AcpToolCall {
  toolCallId: string;
  name?: string;
  title?: string;
  kind?: string;
  status?: string;
  args?: Record<string, unknown>;
  rawInput?: Record<string, unknown>;
  locations?: Array<{ path: string }>;
  content?: Array<Record<string, any>>;
}

export interface PermissionRequest {
  sessionId: string;
  toolCall: AcpToolCall;
  options: PermissionOption[];
}

export type PermissionOutcome = { outcome: "selected"; optionId: string } | { outcome: "cancelled" };

export interface ConfigOption {
  id: string;
  name: string;
  category?: string;
  type: string;
  currentValue: string;
  options: Array<{ value: string; name: string }>;
}

export interface SessionInfo {
  sessionId: string;
  configOptions: ConfigOption[];
  models?: { currentModelId?: string; availableModels?: Array<{ modelId: string; name: string }> };
  modes?: { currentModeId?: string; availableModes?: Array<{ id: string; name: string; description?: string }> };
}

export interface PromptResult {
  stopReason: "end_turn" | "cancelled" | "max_tokens" | "refusal" | string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cachedReadTokens?: number;
    cachedWriteTokens?: number;
    thoughtTokens?: number;
    totalTokens?: number;
  };
}

export interface SessionUpdate {
  sessionUpdate: string;
  [key: string]: any;
}

export interface AcpHandlers {
  onUpdate(sessionId: string, update: SessionUpdate): void;
  onPermission(request: PermissionRequest): Promise<PermissionOutcome>;
  onExit(code: number | null, stderrTail: string): void;
}

interface Pending {
  resolve(value: any): void;
  reject(error: Error): void;
}

/**
 * One `agy acp` process speaking JSON-RPC over stdio. agy is the agent: it runs the loop
 * and its own tools. The client streams updates and answers permission requests.
 */
export class AcpConnection {
  private child?: ChildProcess;
  private nextId = 0;
  private readonly pending = new Map<number, Pending>();
  private stderrTail = "";
  private closed = false;

  constructor(
    private readonly env: Record<string, string | undefined>,
    private readonly cwd: string,
    private readonly handlers: AcpHandlers,
  ) {}

  get alive(): boolean {
    return !this.closed;
  }

  /** OS pid of the agy child (used to locate its log for upstream-error fast-fail). */
  get pid(): number | undefined {
    return this.child?.pid;
  }

  async start(): Promise<void> {
    const home = agyHome(this.env);
    if (home) await mkdir(home, { recursive: true });
    const acpArgs = ["acp"];
    if (skipPermissions(this.env)) acpArgs.push("--dangerously-skip-permissions");
    const child = spawn(agyCommand(this.env), acpArgs, {
      cwd: this.cwd,
      env: agyEnvironment(this.env),
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    child.stderr?.on("data", (chunk) => {
      this.stderrTail = `${this.stderrTail}${chunk}`.slice(-2000);
    });
    child.stdin?.on("error", () => undefined);
    createInterface({ input: child.stdout!, crlfDelay: Infinity }).on("line", (line) => this.onLine(line));
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", (error) =>
        reject((error as NodeJS.ErrnoException).code === "ENOENT" ? new Error(INSTALL_HINT) : error),
      );
    });
    child.once("exit", (code) => this.onExit(code));
    await this.request("initialize", {
      protocolVersion: 1,
      // Pi does not offer client-side file or terminal access; agy uses its own tools.
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "pi-agy-acp", version: "0.1.0" },
    });
  }

  newSession(cwd: string): Promise<SessionInfo> {
    return this.request("session/new", { cwd, mcpServers: [] });
  }

  /** Reattach to an earlier agy conversation (agy advertises `loadSession`). */
  loadSession(sessionId: string, cwd: string): Promise<SessionInfo> {
    return this.request("session/load", { sessionId, cwd, mcpServers: [] });
  }

  setConfigOption(sessionId: string, configId: string, value: string): Promise<unknown> {
    return this.request("session/set_config_option", { sessionId, configId, value });
  }

  setMode(sessionId: string, modeId: string): Promise<unknown> {
    return this.request("session/set_mode", { sessionId, modeId });
  }

  prompt(
    sessionId: string,
    blocks: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>,
  ): Promise<PromptResult> {
    return this.request("session/prompt", { sessionId, prompt: blocks });
  }

  cancel(sessionId: string): void {
    this.notify("session/cancel", { sessionId });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) pending.reject(new Error("agy ACP connection closed"));
    this.pending.clear();
    if (this.child) {
      this.child.stdin?.end();
      killProcessTree(this.child);
    }
  }

  private write(message: unknown): void {
    if (this.closed) return;
    this.child?.stdin?.write(`${JSON.stringify(message)}\n`);
  }

  private request<T = any>(method: string, params: unknown): Promise<T> {
    if (this.closed) return Promise.reject(new Error("agy ACP connection closed"));
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  private notify(method: string, params: unknown): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  private onLine(line: string): void {
    if (!line.trim()) return;
    let message: any;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    // Response to one of our requests.
    if (message.id !== undefined && message.method === undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message ?? JSON.stringify(message.error)));
      else pending.resolve(message.result);
      return;
    }
    if (message.method === "session/update") {
      this.handlers.onUpdate(message.params?.sessionId, message.params?.update ?? {});
      return;
    }
    // Requests from agy to the client.
    if (message.id !== undefined) {
      if (message.method === "session/request_permission") {
        this.handlers.onPermission(message.params).then(
          (outcome) => this.write({ jsonrpc: "2.0", id: message.id, result: { outcome } }),
          () => this.write({ jsonrpc: "2.0", id: message.id, result: { outcome: { outcome: "cancelled" } } }),
        );
        return;
      }
      this.write({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `Method not supported: ${message.method}` } });
    }
  }

  private onExit(code: number | null): void {
    const wasClosed = this.closed;
    this.closed = true;
    for (const pending of this.pending.values()) {
      pending.reject(new Error(`agy acp exited with code ${code ?? "unknown"}${this.stderrTail ? `: ${this.stderrTail.trim().slice(-500)}` : ""}`));
    }
    this.pending.clear();
    if (!wasClosed) this.handlers.onExit(code, this.stderrTail);
  }
}
