import { createHash } from "node:crypto";
import type { AssistantMessage, ImageContent, Message, TextContent, ToolResultMessage } from "@earendil-works/pi-ai";

const REPLAY_RESULT_LIMIT = 20_000;

export type PromptBlock = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

export function contentText(content: string | readonly (TextContent | ImageContent)[]): string {
  if (typeof content === "string") return content;
  return content
    .map((block) => (block.type === "text" ? block.text : "[image]"))
    .filter(Boolean)
    .join("\n");
}

function canonical(message: Message): unknown {
  switch (message.role) {
    case "user":
      return { r: "u", c: contentText(message.content) };
    case "assistant":
      return {
        r: "a",
        c: (message as AssistantMessage).content.flatMap((block): unknown[] => {
          if (block.type === "text") return block.text ? [{ t: block.text }] : [];
          if (block.type === "toolCall") return [{ id: block.id, n: block.name, a: block.arguments }];
          return [];
        }),
      };
    case "toolResult": {
      const result = message as ToolResultMessage;
      return { r: "t", id: result.toolCallId, c: contentText(result.content), e: result.isError };
    }
    default:
      return { r: "s" };
  }
}

/** Stable digest of a conversation prefix, ignoring timestamps, usage, and thinking. */
export function historyHash(messages: readonly Message[]): string {
  const hash = createHash("sha256");
  for (const message of messages) hash.update(`${JSON.stringify(canonical(message))}\n`);
  return hash.digest("hex");
}

/** The newest user message as ACP prompt blocks (text and images). */
export function userBlocks(message: Message): PromptBlock[] {
  if (message.role !== "user") return [];
  if (typeof message.content === "string") return [{ type: "text", text: message.content }];
  const blocks: PromptBlock[] = [];
  for (const block of message.content) {
    if (block.type === "text" && block.text) blocks.push({ type: "text", text: block.text });
    if (block.type === "image") blocks.push({ type: "image", data: block.data, mimeType: block.mimeType });
  }
  return blocks.length ? blocks : [{ type: "text", text: "" }];
}

function clip(text: string): string {
  if (text.length <= REPLAY_RESULT_LIMIT) return text;
  return `${text.slice(0, REPLAY_RESULT_LIMIT)}\n[... ${text.length - REPLAY_RESULT_LIMIT} more characters omitted]`;
}

/**
 * Earlier Pi history as text, for a new agy session (first use in a session that already has
 * history, a branch, or an edit). agy cannot import structured history over ACP.
 */
export function historyPreamble(history: readonly Message[]): string | undefined {
  const conversation = history.filter((message) => message.role !== "system");
  if (!conversation.length) return undefined;
  const parts: string[] = [
    "Earlier conversation, replayed by Pi because this is a new agy session. Treat it as real history;",
    "tool calls in it already ran and their results are shown.",
    "<transcript>",
  ];
  for (const message of conversation) {
    if (message.role === "user") {
      parts.push(`## User\n${contentText(message.content)}`);
    } else if (message.role === "assistant") {
      for (const block of (message as AssistantMessage).content) {
        if (block.type === "text" && block.text.trim()) parts.push(`## Assistant\n${block.text}`);
        if (block.type === "toolCall") parts.push(`## Assistant called \`${block.name}\`\n${JSON.stringify(block.arguments)}`);
      }
    } else if (message.role === "toolResult") {
      const result = message as ToolResultMessage;
      parts.push(`## Tool ${result.isError ? "error" : "result"} for \`${result.toolName}\`\n${clip(contentText(result.content))}`);
    }
  }
  parts.push("</transcript>", "Latest user message follows.");
  return parts.join("\n\n");
}
