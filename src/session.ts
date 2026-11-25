import { AcpConnection, type PermissionOutcome, type PermissionRequest, type PromptResult, type SessionInfo, type SessionUpdate } from "./acp-client.ts";
import type { PromptBlock } from "./transcript.ts";

/** UI hooks the Pi extension installs; the provider has no direct UI access. */
export interface PermissionUi {
  ask(request: PermissionRequest, signal: AbortSignal): Promise<PermissionOutcome>;
}

let permissionUi: PermissionUi | undefined;
export function setPermissionUi(ui: PermissionUi | undefined): void {
  permissionUi = ui;
}

/** Where updates of the turn currently streaming go. */
export interface UpdateSink {
  update(update: SessionUpdate): void;
}

const IDLE_MS = 10 * 60_000;

/**
 * One Pi session <-> one agy ACP session. agy keeps the conversation; Pi only sends the
 * newest user message each turn and renders what agy does.
 */
export class AgySession {
  private connection?: AcpConnection;
  private info?: SessionInfo;
  private sink?: UpdateSink;
  private idleTimer?: NodeJS.Timeout;
  private permissionAbort?: AbortController;
  /** Number of Pi conversation messages already reflected in the agy session. */
  syncedLength = 0;
  /** Digest of that prefix, to detect branches and edits. */
  syncedHash = "";
  agySessionId?: string;
  current = { model: "", effort: "", mode: "" };

  constructor(
    readonly key: string,
    private readonly env: Record<string, string | undefined>,
    readonly cwd: string,
  ) {}

  get alive(): boolean {
    return !!this.connection?.alive;
  }

  get agyPid(): number | undefined {
    return this.connection?.pid;
  }

  async open(resumeId?: string): Promise<{ resumed: boolean }> {
    this.connection = new AcpConnection(this.env, this.cwd, {
      onUpdate: (_sessionId, update) => this.sink?.update(update),
      onPermission: (request) => this.askPermission(request),
      onExit: () => {
        this.sink?.update({ sessionUpdate: "_exit" });
        sessions.delete(this.key);
      },
    });
    await this.connection.start();
    if (resumeId) {
      try {
        this.info = await this.connection.loadSession(resumeId, this.cwd);
        this.info.sessionId ??= resumeId;
        this.agySessionId = resumeId;
        this.readCurrent();
        return { resumed: true };
      } catch {
        // Fall back to a new session below.
      }
    }
    this.info = await this.connection.newSession(this.cwd);
    this.agySessionId = this.info.sessionId;
    this.readCurrent();
    return { resumed: false };
  }

  /** Apply model / effort / mode through ACP config options (only when they changed). */
  async configure(target: { model: string; effort?: string; mode?: string }): Promise<void> {
    const connection = this.requireConnection();
    const id = this.agySessionId!;
    if (target.model && target.model !== this.current.model) {
      await connection.setConfigOption(id, "model", target.model);
      this.current.model = target.model;
    }
    if (target.effort && target.effort !== this.current.effort && this.hasOption("thought_level", target.effort)) {
      await connection.setConfigOption(id, "thought_level", target.effort);
      this.current.effort = target.effort;
    }
    if (target.mode && target.mode !== this.current.mode) {
      await connection.setConfigOption(id, "mode", target.mode);
      this.current.mode = target.mode;
    }
  }

  async prompt(blocks: PromptBlock[], sink: UpdateSink, signal?: AbortSignal): Promise<PromptResult> {
    const connection = this.requireConnection();
    clearTimeout(this.idleTimer);
    this.sink = sink;
    const onAbort = () => {
      this.permissionAbort?.abort();
      connection.cancel(this.agySessionId!);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      return await connection.prompt(this.agySessionId!, blocks);
    } finally {
      signal?.removeEventListener("abort", onAbort);
      this.sink = undefined;
      this.scheduleIdle();
    }
  }

  close(): void {
    clearTimeout(this.idleTimer);
    this.permissionAbort?.abort();
    this.connection?.close();
    sessions.delete(this.key);
  }

  modelOptions(): string[] {
    return this.info?.configOptions?.find((option) => option.id === "model")?.options.map((option) => option.value) ?? [];
  }

  private hasOption(id: string, value: string): boolean {
    return !!this.info?.configOptions?.find((option) => option.id === id)?.options.some((option) => option.value === value);
  }

  private readCurrent(): void {
    for (const option of this.info?.configOptions ?? []) {
      if (option.id === "model") this.current.model = option.currentValue;
      if (option.id === "thought_level") this.current.effort = option.currentValue;
      if (option.id === "mode") this.current.mode = option.currentValue;
    }
  }

  private requireConnection(): AcpConnection {
    if (!this.connection?.alive || !this.agySessionId) throw new Error("agy ACP session is not running");
    return this.connection;
  }

  private async askPermission(request: PermissionRequest): Promise<PermissionOutcome> {
    this.sink?.update({ sessionUpdate: "_permission_request", request });
    if (!permissionUi) {
      // No interactive UI (print/json mode): deny rather than auto-approve.
      const reject = request.options.find((option) => option.kind.startsWith("reject"));
      return reject ? { outcome: "selected", optionId: reject.optionId } : { outcome: "cancelled" };
    }
    this.permissionAbort = new AbortController();
    try {
      const outcome = await permissionUi.ask(request, this.permissionAbort.signal);
      this.sink?.update({ sessionUpdate: "_permission_answer", request, outcome });
      return outcome;
    } finally {
      this.permissionAbort = undefined;
    }
  }

  private scheduleIdle(): void {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.close(), IDLE_MS);
    this.idleTimer.unref();
  }
}

const sessions = new Map<string, AgySession>();
/** agy session ids by Pi session key, kept after a process closes so the conversation can be reloaded. */
const remembered = new Map<string, { agySessionId: string; syncedLength: number; syncedHash: string; cwd: string }>();

export function getSession(key: string): AgySession | undefined {
  const session = sessions.get(key);
  return session?.alive ? session : undefined;
}

export async function openSession(
  key: string,
  env: Record<string, string | undefined>,
  cwd: string,
  options: { tryResume: boolean },
): Promise<{ session: AgySession; resumed: boolean }> {
  sessions.get(key)?.close();
  const session = new AgySession(key, env, cwd);
  const memory = remembered.get(key);
  const resumeId = options.tryResume && memory?.cwd === cwd ? memory.agySessionId : undefined;
  const { resumed } = await session.open(resumeId);
  if (resumed && memory) {
    session.syncedLength = memory.syncedLength;
    session.syncedHash = memory.syncedHash;
  }
  sessions.set(key, session);
  return { session, resumed };
}

export function rememberSession(session: AgySession): void {
  if (!session.agySessionId) return;
  remembered.set(session.key, {
    agySessionId: session.agySessionId,
    syncedLength: session.syncedLength,
    syncedHash: session.syncedHash,
    cwd: session.cwd,
  });
}

export function forget(key?: string): void {
  if (key === undefined) {
    for (const session of [...sessions.values()]) session.close();
    remembered.clear();
    return;
  }
  sessions.get(key)?.close();
  remembered.delete(key);
}

export function liveSessions(): AgySession[] {
  return [...sessions.values()].filter((session) => session.alive);
}
