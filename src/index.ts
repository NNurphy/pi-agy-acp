import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createProvider, registerSessionResourceCleanup } from "@earendil-works/pi-ai";
import { captureAgyModels } from "./models.ts";
import { AGY_MODELS, API_ID, BASE_URL, buildModels, PROVIDER_ID } from "./model-catalog.ts";
import { forget, liveSessions, setPermissionUi } from "./session.ts";
import { describeTool, streamAgyAcp } from "./stream.ts";
import type { PermissionOutcome, PermissionRequest } from "./acp-client.ts";
import { skipPermissions } from "./config.ts";
import { getMode, MODES, setMode } from "./mode.ts";

registerSessionResourceCleanup((sessionId) => forget(sessionId));

function permissionPrompt(request: PermissionRequest): string {
  const call = request.toolCall;
  const lines = [`agy wants to run: ${describeTool(call)}`];
  const args = (call.args ?? call.rawInput ?? {}) as Record<string, unknown>;
  if (typeof args.Content === "string") lines.push("", args.Content.slice(0, 600) + (args.Content.length > 600 ? "\n…" : ""));
  if (typeof args.CommandLine === "string") lines.push("", `$ ${args.CommandLine}`);
  for (const item of call.content ?? []) {
    if (item.type === "diff" && typeof item.newText === "string") {
      lines.push("", `--- ${String(item.oldText ?? "").slice(0, 300)}`, `+++ ${item.newText.slice(0, 300)}`);
    }
  }
  return lines.join("\n");
}

export default function agyAcpExtension(pi: ExtensionAPI): void {
  let discovered: Set<string> | undefined;
  let uiContext: ExtensionContext | undefined;

  pi.registerProvider(
    createProvider({
      id: PROVIDER_ID,
      name: "Antigravity agent (agy ACP, experimental)",
      baseUrl: BASE_URL,
      auth: {
        apiKey: {
          name: "agy sign-in",
          async check({ signal }) {
            const rows = await captureAgyModels(process.env, signal);
            return rows.length ? { type: "oauth", source: "Antigravity CLI sign-in" } : undefined;
          },
          async resolve() {
            return { auth: { apiKey: "external-process" }, source: "Antigravity CLI" };
          },
        },
      },
      models: AGY_MODELS,
      async fetchModels({ signal }) {
        const models = buildModels(await captureAgyModels(process.env, signal));
        discovered = new Set(models.map((model) => model.id));
        return models;
      },
      filterModels(models) {
        return discovered ? models.filter((model) => discovered!.has(model.id)) : models;
      },
      api: { stream: streamAgyAcp, streamSimple: streamAgyAcp },
    }),
  );

  // Route agy's permission requests to Pi's UI.
  const ask = async (request: PermissionRequest, signal: AbortSignal): Promise<PermissionOutcome> => {
    const ctx = uiContext;
    // Opt-in auto-approve (PI_AGY_SKIP_PERMISSIONS=1): pick allow_always so agy stops asking.
    if (skipPermissions(process.env)) {
      const allow =
        request.options.find((o) => o.kind === "allow_always") ??
        request.options.find((o) => o.kind.startsWith("allow"));
      if (allow) return { outcome: "selected", optionId: allow.optionId };
    }
    const reject = request.options.find((option) => option.kind.startsWith("reject"));
    if (!ctx?.hasUI) return reject ? { outcome: "selected", optionId: reject.optionId } : { outcome: "cancelled" };
    const labels = request.options.map((option) => option.name);
    const choice = await ctx.ui.select(permissionPrompt(request), labels, { signal });
    const picked = request.options.find((option) => option.name === choice);
    if (picked) return { outcome: "selected", optionId: picked.optionId };
    return reject ? { outcome: "selected", optionId: reject.optionId } : { outcome: "cancelled" };
  };

  pi.on("session_start", (_event, ctx) => {
    uiContext = ctx;
    setPermissionUi({ ask });
  });
  pi.on("agent_start", (_event, ctx) => {
    uiContext = ctx;
  });
  pi.on("session_shutdown", () => {
    forget();
    setPermissionUi(undefined);
  });


  pi.registerCommand("agy-mode", {
    description: "Show/set agy execution mode for this folder (default|accept-edits|auto|plan)",
    handler: async (args, ctx) => {
      const cwd = process.cwd();
      const arg = (args ?? "").trim().toLowerCase();
      const current = getMode(cwd, process.env) ?? "(agy default)";
      if (!arg) {
        ctx.ui.notify(
          `agy mode @ ${cwd}
当前: ${current}
可设: ${MODES.join(" / ")}
用法: /agy-mode plan   清除: /agy-mode reset`,
          "info",
        );
        return;
      }
      if (arg === "reset" || arg === "clear") {
        const r = setMode(cwd, null);
        ctx.ui.notify(`已清除该目录的模式覆盖，回到 env/默认值${r.persisted ? "" : "（写入失败，仅本进程生效）"}`, "info");
        return;
      }
      if (!(MODES as readonly string[]).includes(arg)) {
        ctx.ui.notify(`未知模式: ${arg}。可选: ${MODES.join(" / ")}`, "error");
        return;
      }
      const r = setMode(cwd, arg);
      ctx.ui.notify(
        `agy mode 设为 ${arg}（目录 ${cwd}）${r.persisted ? "，已持久化，下次会话仍生效" : "（写入失败，仅本进程生效）"}
下一轮对话生效。`,
        "info",
      );
    },
  });

  pi.registerCommand("agy-acp-status", {
    description: "Show agy ACP sessions",
    handler: async (_args, ctx) => {
      const rows = await captureAgyModels(process.env, ctx.signal);
      const sessions = liveSessions()
        .map((session) => `${session.agySessionId} model=${session.current.model} effort=${session.current.effort} mode=${session.current.mode}`)
        .join("\n");
      ctx.ui.notify(rows.length ? `agy ready, ${rows.length} models\n${sessions || "no live sessions"}` : "agy not ready (run `agy` to sign in)", rows.length ? "info" : "error");
    },
  });
}

export { API_ID, PROVIDER_ID };
