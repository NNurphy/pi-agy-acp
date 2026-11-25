import {
  calculateCost,
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Message,
  type Model,
  type SimpleStreamOptions,
  type TextContent,
  type ThinkingContent,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import type { AcpToolCall, SessionUpdate } from "./acp-client.ts";
import { type AgySession, getSession, openSession, rememberSession } from "./session.ts";
import { historyHash, historyPreamble, userBlocks } from "./transcript.ts";
import { getMode } from "./mode.ts";
import { classifyAgyLog, describeAgyFailure, type AgyFailure } from "./upstream-errors.ts";
import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { agyLogDir, safetyTimeoutMs as safetyTimeoutMsFromConfig, watchAgyLog } from "./config.ts";

const MODE_ENV = "PI_AGY_MODE";

/**
 * agy swallows upstream failures: it writes them to its own log and never answers the
 * ACP prompt request. Tail *newly appended* log bytes for this child pid and classify
 * agy's own error text, so the turn fails with the real cause instead of a guess.
 * Disable with PI_AGY_WATCH_LOG=0.
 */
function watchAgyFailures(
  pid: number | undefined,
  onFailure: (failure: AgyFailure) => void,
  onDead?: () => void,
): () => void {
  if (!pid || !watchAgyLog()) return () => {};
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let offset = -1; // -1 = not initialized yet; start from current EOF
  let misses = 0;
  const tick = () => {
    if (stopped) return;
    try {
      const logDir = agyLogDir();
      const file = readdirSync(logDir)
        .filter((name) => name.includes(`-${pid}.log`))
        .sort()
        .pop();
      if (!file) {
        if (++misses > 20) {
          stopped = true;
          onDead?.();
          return;
        }
      } else {
        misses = 0;
        const full = join(logDir, file);
        const size = statSync(full).size;
        if (offset < 0) {
          offset = size; // ignore everything logged before this turn
        } else if (size > offset) {
          const buf = Buffer.alloc(size - offset);
          const fd = openSync(full, "r");
          try {
            readSync(fd, buf, 0, buf.length, offset);
          } finally {
            closeSync(fd);
          }
          offset = size;
          const chunk = buf.toString("utf8");
          const failure = classifyAgyLog(chunk);
          if (failure) {
            stopped = true;
            onFailure(failure);
            return;
          }
        }
      }
    } catch {
      // log file unreadable this tick — keep polling
    }
    timer = setTimeout(tick, 1000);
    timer.unref?.();
  };
  timer = setTimeout(tick, 1000);
  timer.unref?.();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

/** Last-resort guard against a turn that never settles. Not a failure detector. */
function safetyTimeoutMs(): number {
  return safetyTimeoutMsFromConfig();
}

function emptyUsage(): AssistantMessage["usage"] {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

/** agy ACP model ids are effort-free (e.g. `gemini-3.8-flash`); effort is a separate option. */
function effortFor(model: Model<any>, reasoning: SimpleStreamOptions["reasoning"]): string | undefined {
  if (!model.reasoning) return undefined;
  const map = model.thinkingLevelMap as Record<string, string | null | undefined> | undefined;
  const slug = map?.[reasoning ?? "off"] ?? map?.low;
  const match = typeof slug === "string" ? /-(low|medium|high|xhigh)$/u.exec(slug) : null;
  return match?.[1];
}

function shortPath(path: string): string {
  return path.replace(/^\/(?=[A-Za-z]:)/u, "").replace(/\\/gu, "/");
}

/** One readable line for a tool call agy ran. */
export function describeTool(call: AcpToolCall): string {
  const args = (call.args ?? call.rawInput ?? {}) as Record<string, unknown>;
  const name = call.name ?? call.kind ?? "tool";
  if (typeof args.CommandLine === "string") return `${name}: \`${args.CommandLine}\``;
  const path = (args.Path ?? args.TargetFile ?? args.AbsolutePath ?? call.locations?.[0]?.path) as string | undefined;
  if (path) return `${name}: ${shortPath(path)}`;
  if (typeof args.Query === "string") return `${name}: ${args.Query}`;
  if (typeof args.Url === "string") return `${name}: ${args.Url}`;
  return call.title ? `${name}: ${call.title}` : name;
}

function toolOutcome(call: AcpToolCall): string {
  const content = call.content ?? [];
  for (const item of content) {
    if (item.type === "diff") {
      const before = String(item.oldText ?? "").split("\n").length;
      const after = String(item.newText ?? "").split("\n").length;
      return item.oldText ? `edited (${before} -> ${after} lines)` : `created (${after} lines)`;
    }
  }
  for (const item of content) {
    const text = item.type === "content" ? item.content?.text : item.text;
    if (typeof text === "string") {
      const match = /Command exited with code (\d+)/u.exec(text);
      if (match) return `exit ${match[1]}`;
    }
  }
  return "done";
}

export function normalizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  // Upstream capacity: agy retries this forever and the turn looks frozen.
  if (/No capacity available|code 503|\(Unavailable, HTTP 503\)|UNAVAILABLE \(code 503\)/iu.test(message)) {
    const model = /for model ([\w.-]+)/u.exec(message)?.[1];
    return (
      `agy 上游容量不足（503）${model ? `：模型 ${model} 暂无可用容量` : ""}。` +
      `这不是你的配额用完。建议：顶栏换 gemini-3.8-flash 或 claude-sonnet-5-5 后重试；` +
      `高峰时段 gemini-4 系列（Neon/Argon/Hydrogen）更容易撞满。`
    );
  }
  if (/context(?:_| )length|context window|too many (input )?tokens|prompt is too long/iu.test(message)) {
    return `context_length_exceeded: ${message}`;
  }
  return message;
}

/**
 * A Pi turn is one agy ACP prompt. agy runs its own loop and tools; Pi receives the
 * streamed reply, thinking, and a log of agy's tool calls as text. Pi never runs a tool.
 */
export function streamAgyAcp(
  model: Model<any>,
  context: TranscriptContext,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const output: AssistantMessage = {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: emptyUsage(),
    stopReason: "pending",
    timestamp: Date.now(),
  };

  let activeSession: AgySession | undefined;
  let timedOut = false;
  let lastFailure: AgyFailure | undefined;

  void (async () => {
    try {
      const env = { ...(options?.env ?? {}) } as Record<string, string | undefined>;
      const messages: Message[] = context.messages.filter((message) => message.role !== "system");
      const last = messages[messages.length - 1];
      if (last?.role !== "user") throw new Error("agy ACP turns must end with a user message");
      const history = messages.slice(0, -1);
      const key = options?.sessionId ?? `ephemeral-${Date.now()}-${Math.random()}`;
      const cwd = process.cwd();
      const historyKey = historyHash(history);

      // Continue the agy session only if Pi's history is exactly what agy already has.
      let session = getSession(key);
      let replay = false;
      if (!session || session.syncedLength !== history.length || session.syncedHash !== historyKey || session.cwd !== cwd) {
        const opened = await openSession(key, env, cwd, { tryResume: true });
        session = opened.session;
        const resumedInSync =
          opened.resumed && session.syncedLength === history.length && session.syncedHash === historyKey;
        replay = !resumedInSync && history.length > 0;
      }

      activeSession = session;
      const mode = getMode(cwd, env);
      await session.configure({ model: model.id, effort: effortFor(model, options?.reasoning), mode });

      const blocks = userBlocks(last);
      if (replay) {
        const preamble = historyPreamble(history);
        if (preamble) blocks.unshift({ type: "text", text: preamble });
      }

      options?.signal?.throwIfAborted();
      stream.push({ type: "start", partial: output });

      let text: TextContent | undefined;
      let thinking: ThinkingContent | undefined;
      const tools = new Map<string, AcpToolCall>();

      const closeText = () => {
        if (!text) return;
        stream.push({ type: "text_end", contentIndex: output.content.indexOf(text), content: text.text, partial: output });
        text = undefined;
      };
      const closeThinking = () => {
        if (!thinking) return;
        stream.push({ type: "thinking_end", contentIndex: output.content.indexOf(thinking), content: thinking.thinking, partial: output });
        thinking = undefined;
      };
      const appendText = (delta: string) => {
        if (!delta) return;
        closeThinking();
        if (!text) {
          text = { type: "text", text: "" };
          output.content.push(text);
          stream.push({ type: "text_start", contentIndex: output.content.length - 1, partial: output });
        }
        text.text += delta;
        stream.push({ type: "text_delta", contentIndex: output.content.indexOf(text), delta, partial: output });
      };
      const appendThinking = (delta: string) => {
        if (!delta) return;
        closeText();
        if (!thinking) {
          thinking = { type: "thinking", thinking: "" };
          output.content.push(thinking);
          stream.push({ type: "thinking_start", contentIndex: output.content.length - 1, partial: output });
        }
        thinking.thinking += delta;
        stream.push({ type: "thinking_delta", contentIndex: output.content.indexOf(thinking), delta, partial: output });
      };
      /** agy's tool activity is shown as its own text line so it stays in Pi's transcript. */
      const logLine = (line: string) => {
        const needsBreak = text && !text.text.endsWith("\n") && text.text.length > 0;
        appendText(`${needsBreak ? "\n" : ""}> ${line}\n`);
      };

      // Failures are detected from agy's own error text (watchAgyFailures). The timer
      // below is only a last-resort guard so a turn can never hang forever.
      let safetyTimer: NodeJS.Timeout | undefined;
      let safetyReject: ((error: Error) => void) | undefined;
      const safety = new Promise<never>((_, reject) => {
        safetyReject = reject;
      });
      timedOut = false;

      const sink = {
        update(update: SessionUpdate) {
          switch (update.sessionUpdate) {
            case "agent_message_chunk":
              if (update.content?.type === "text") {
                if (text && text.text.endsWith("\n") && text.text.trimEnd().split("\n").pop()?.startsWith("> ")) appendText("\n");
                appendText(update.content.text ?? "");
              }
              break;
            case "agent_thought_chunk":
              if (update.content?.type === "text") appendThinking(update.content.text ?? "");
              break;
            case "tool_call": {
              const call = update as unknown as AcpToolCall;
              tools.set(call.toolCallId, call);
              logLine(`agy ${describeTool(call)}`);
              break;
            }
            case "tool_call_update": {
              const call = { ...tools.get(update.toolCallId), ...(update as unknown as AcpToolCall) };
              tools.set(call.toolCallId, call);
              if (call.status === "completed") logLine(`  ✓ ${toolOutcome(call)}`);
              if (call.status === "failed") logLine(`  ✗ failed`);
              break;
            }
            case "_permission_answer": {
              const allowed = update.outcome?.outcome === "selected" && /^allow/u.test(
                update.request.options.find((option: any) => option.optionId === update.outcome.optionId)?.kind ?? "",
              );
              logLine(`  ${allowed ? "approved" : "denied"} in Pi`);
              break;
            }
            case "usage_update":
              break;
          }
        },
      };

      let failureReject: ((error: Error) => void) | undefined;
      const agyFailure = new Promise<never>((_, reject) => {
        failureReject = reject;
      });
      const stopWatch = watchAgyFailures(session.agyPid, (failure) => {
        lastFailure = failure;
        failureReject?.(new Error(describeAgyFailure(failure)));
      });

      const limitMs = safetyTimeoutMs();
      safetyTimer = setTimeout(() => {
        timedOut = true;
        try {
          session.cancel();
        } catch {
          // best effort
        }
        safetyReject?.(
          new Error(`agy 已 ${Math.round(limitMs / 60000)} 分钟没有结果，主动中止以免永久挂起（已保留已收到的内容）`),
        );
      }, limitMs);
      safetyTimer.unref?.();
      const result = await Promise.race([
        safety,
        session.prompt(blocks, sink, options?.signal),
        agyFailure,
      ]).finally(() => {
        if (safetyTimer) clearTimeout(safetyTimer);
        stopWatch();
      });
      closeThinking();
      // agy sometimes ends a turn after a denied tool without any reply text.
      const replied = output.content.some(
        (block) => block.type === "text" && block.text.split("\n").some((line) => line.trim() && !line.startsWith("> ")),
      );
      if (!replied && result.stopReason === "end_turn") {
        appendText("\n(agy ended the turn without a reply.)");
      }
      closeText();

      const usage = result.usage ?? {};
      output.usage.input = usage.inputTokens ?? 0;
      output.usage.output = usage.outputTokens ?? 0;
      output.usage.cacheRead = usage.cachedReadTokens ?? 0;
      output.usage.cacheWrite = usage.cachedWriteTokens ?? 0;
      output.usage.reasoning = usage.thoughtTokens ?? 0;
      output.usage.totalTokens = output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
      calculateCost(model, output.usage);
      output.responseId = session.agySessionId;
      output.rawStopReason = result.stopReason;
      output.diagnostics = [
        { type: "agy-acp.turn", timestamp: Date.now(), details: { agySession: session.agySessionId, replay, tools: tools.size } as never },
      ];

      if (result.stopReason === "cancelled") {
        output.stopReason = "aborted";
        output.errorMessage = "Cancelled";
        stream.push({ type: "error", reason: "aborted", error: output });
        stream.end();
        session.close();
        return;
      }
      output.stopReason = result.stopReason === "max_tokens" ? "length" : "stop";
      if (result.stopReason === "refusal") {
        output.stopReason = "error";
        output.errorMessage = "The model refused to complete the request";
        throw new Error(output.errorMessage);
      }

      // agy now holds history + this reply; remember where Pi's transcript stands.
      const synced = [...messages, output];
      session.syncedLength = synced.length;
      session.syncedHash = historyHash(synced);
      rememberSession(session);
      stream.push({ type: "done", reason: output.stopReason, message: output });
      stream.end();
    } catch (error) {
      const partial = output.content.some((block) =>
        block.type === "text" ? block.text.trim() !== "" : block.type === "thinking" ? block.thinking.trim() !== "" : false,
      );

      // Cause comes from agy's own error text when available; otherwise the exception.
      const reason = lastFailure ? describeAgyFailure(lastFailure) : normalizeError(error);

      // The turn failed, but agy already produced text: keep it and say why, instead of
      // discarding the work and letting Pi re-run the whole turn.
      if (partial && (lastFailure || timedOut)) {
        try {
          activeSession?.cancel();
        } catch {
          // best effort
        }
        // closeText/appendText live inside the try scope; append the note to the payload instead.
        const note = `\n\n---\n⚠️ ${reason}\n以上为本轮已收到的内容；回复「继续」可从断点往下做。`;
        const tailBlock = [...output.content].reverse().find((block) => block.type === "text");
        if (tailBlock && tailBlock.type === "text") tailBlock.text += note;
        else output.content.push({ type: "text", text: note });
        output.stopReason = "stop";
        output.errorMessage = undefined;
        const synced = [...context.messages.filter((m) => m.role !== "system"), output];
        if (activeSession) {
          activeSession.syncedLength = synced.length;
          activeSession.syncedHash = historyHash(synced);
          rememberSession(activeSession);
        }
        stream.push({ type: "done", reason: "stop", message: output });
        stream.end();
        return;
      }

      // Never leave the agy child running: it keeps the event loop alive and Pi never exits.
      try {
        activeSession?.cancel();
        activeSession?.close();
      } catch {
        // best effort
      }
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = reason;
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  })();

  return stream;
}
