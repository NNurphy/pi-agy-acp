import type { Model, ThinkingLevel } from "@earendil-works/pi-ai";

export const PROVIDER_ID = "agy-acp";
export const API_ID = "agy-acp";
export const BASE_URL = "process://agy-acp";

export type AgyModel = Model<typeof API_ID>;

export interface AgyModelRow {
  /** agy model slug, for example `gemini-3.8-flash-high`. */
  id: string;
  /** agy display label, for example `Gemini 3.8 Flash (High)`. */
  label: string;
}

const EFFORTS = ["low", "medium", "high", "xhigh"] as const;
type Effort = (typeof EFFORTS)[number];
const EFFORT_SUFFIX = /^(.*)-(low|medium|high|xhigh)$/u;
const LABEL_SUFFIX = /\s*\((Low|Medium|High|XHigh)\)\s*$/u;

/** Pi thinking level -> preferred agy effort, then fallbacks in order. */
const LEVEL_PREFERENCE: Record<"off" | ThinkingLevel, Effort[]> = {
  off: ["low", "medium", "high", "xhigh"],
  minimal: ["low", "medium", "high", "xhigh"],
  low: ["low", "medium", "high", "xhigh"],
  medium: ["medium", "low", "high", "xhigh"],
  high: ["high", "medium", "xhigh", "low"],
  xhigh: ["xhigh"],
  max: [],
};

// Rows observed from `agy models` (1.5.12). Used until live discovery finishes.
export const FALLBACK_ROWS: AgyModelRow[] = [
  ["gemini-4-neon-low", "Gemini 4 Neon (Low)"],
  ["gemini-4-neon-medium", "Gemini 4 Neon (Medium)"],
  ["gemini-4-neon-high", "Gemini 4 Neon (High)"],
  ["gemini-4-neon-xhigh", "Gemini 4 Neon (XHigh)"],
  ["gemini-4-carbon-low", "Gemini 4 Carbon (Low)"],
  ["gemini-4-carbon-medium", "Gemini 4 Carbon (Medium)"],
  ["gemini-4-carbon-high", "Gemini 4 Carbon (High)"],
  ["gemini-3.8-flash-low", "Gemini 3.8 Flash (Low)"],
  ["gemini-3.8-flash-medium", "Gemini 3.8 Flash (Medium)"],
  ["gemini-3.8-flash-high", "Gemini 3.8 Flash (High)"],
  ["claude-opus-5-5-low", "Claude Opus 5.5 (Low)"],
  ["claude-opus-5-5-medium", "Claude Opus 5.5 (Medium)"],
  ["claude-opus-5-5-high", "Claude Opus 5.5 (High)"],
  ["claude-sonnet-5-5-low", "Claude Sonnet 5.5 (Low)"],
  ["claude-sonnet-5-5-medium", "Claude Sonnet 5.5 (Medium)"],
  ["claude-sonnet-5-5-high", "Claude Sonnet 5.5 (High)"],
].map(([id, label]) => ({ id, label }));

/** Parse `agy models` output: one `slug<TAB>label` row per line. */
export function parseModelRows(stdout: string): AgyModelRow[] {
  const rows: AgyModelRow[] = [];
  for (const line of stdout.split(/\r?\n/u)) {
    const match = /^([A-Za-z0-9][\w.-]*)\t(.+)$/u.exec(line.trim());
    if (match) rows.push({ id: match[1], label: match[2].trim() });
  }
  return rows;
}

function contextWindow(base: string): number {
  if (base.startsWith("gemini")) return 1_048_576;
  if (base.startsWith("claude")) return 200_000;
  return 128_000;
}

/** Group effort variants (`-low`, `-high`, ...) into one Pi model per base slug. */
export function buildModels(rows: AgyModelRow[]): AgyModel[] {
  type Group = { label: string; variants: Map<Effort, string>; plain?: string };
  const groups = new Map<string, Group>();
  for (const row of rows) {
    const match = EFFORT_SUFFIX.exec(row.id);
    const base = match ? match[1]! : row.id;
    const group: Group = groups.get(base) ?? { label: row.label.replace(LABEL_SUFFIX, ""), variants: new Map() };
    if (match) group.variants.set(match[2] as Effort, row.id);
    else group.plain = row.id;
    groups.set(base, group);
  }

  const models: AgyModel[] = [];
  for (const [base, group] of groups) {
    const efforts = EFFORTS.filter((effort) => group.variants.has(effort));
    const reasoning = efforts.length > 1;
    const fallback = group.plain ?? group.variants.get(efforts[0]!) ?? base;
    let thinkingLevelMap: AgyModel["thinkingLevelMap"];
    if (reasoning) {
      thinkingLevelMap = {};
      for (const level of Object.keys(LEVEL_PREFERENCE) as Array<keyof typeof LEVEL_PREFERENCE>) {
        const effort = LEVEL_PREFERENCE[level].find((candidate) => group.variants.has(candidate));
        thinkingLevelMap[level] = effort ? group.variants.get(effort)! : null;
      }
    } else {
      // Single variant: Pi shows no thinking levels; `off` still names the slug to run.
      thinkingLevelMap = { off: fallback };
    }
    models.push({
      id: base,
      name: `${group.label} (agy ACP)`,
      api: API_ID,
      provider: PROVIDER_ID,
      baseUrl: BASE_URL,
      reasoning,
      thinkingLevelMap,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: contextWindow(base),
      maxTokens: 65_536,
    });
  }
  return models;
}

/** The agy slug to run for a Pi model and thinking level. */
export function nativeModel(model: Model<any>, reasoning: ThinkingLevel | undefined): string {
  const map = model.thinkingLevelMap as Record<string, string | null | undefined> | undefined;
  const direct = map?.[reasoning ?? "off"];
  if (typeof direct === "string") return direct;
  const fallback = map?.off ?? map?.low ?? map?.medium;
  return typeof fallback === "string" ? fallback : model.id;
}

export const AGY_MODELS: AgyModel[] = buildModels(FALLBACK_ROWS);
