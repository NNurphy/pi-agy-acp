/**
 * agy 的错误分类表。
 *
 * 依据两处事实（不是猜）：
 *   1. Google 官方错误码表 — https://ai.google.dev/gemini-api/docs/api-errors
 *      （invalid_request 400 / authentication 401 / payment_required 402 / permission_denied 403 /
 *        model_not_found 404 / already_exists 409 / aborted 409 / rate_limit_exceeded 429 /
 *        quota_exceeded 429 / too_many_requests 429 / cancelled 499 / api_error 500 /
 *        unimplemented 501 / service_unavailable 503 / deadline_exceeded 504；
 *        生成受阻：safety / recitation / language / prohibited_content / spii / blocklist / content_blocked；
 *        生成错误：malformed_function_call / malformed_tool_call / unexpected_tool_call /
 *        too_many_tool_calls / missing_thought_signature）
 *   2. 本机 agy 历史日志（`~/.gemini/antigravity-cli/log/*.log`）里实际出现过的错误行与噪声行。
 *
 * agy 把上游错误只写进自己的日志、不回 ACP 响应，所以这里按「错误文本 → 分类 → 处置」工作。
 */

export type AgyFailureKind =
  | "capacity" // 503 容量
  | "rate_limit" // 429 频率
  | "quota" // 订阅额度（5h/周窗口）
  | "payment" // 402 余额/额度耗尽
  | "auth" // 401 登录态
  | "permission" // 403 项目/权限
  | "model_not_found" // 404 模型不存在
  | "invalid_request" // 400 参数
  | "context" // 上下文超限
  | "deadline" // 504 超时
  | "internal" // 500 服务端错误
  | "blocked" // 安全/版权拦截
  | "malformed_output" // 生成结构错误（工具调用等）
  | "aborted" // 499 客户端取消
  | "network" // 传输层
  | "local" // agy 本机环境（keyring/路径/锁）
  | "unknown";

export interface AgyFailure {
  kind: AgyFailureKind;
  /** 官方/agy 原始错误码（能提取到时） */
  code?: string;
  model?: string;
  retryable: boolean;
  raw: string;
}

/**
 * 噪声行：这些在 agy 正常工作时也会大量出现（实测 4400+ 条），
 * 绝不能当成故障，否则每一轮都会被误判。
 */
const NOISE = [
  "play.googleapis.com", // 遥测被 REJECT，必然 EOF
  "Singleflight refresh failed",
  "Failed to poll ListExperiments",
  "Not reloading plugin MCP servers",
  "error getting token source",
  "Cache(",
  "Failed to refresh cache in background",
  "admin controls not applicable",
  "failed to get cs path",
  "cli settings not available",
  "Failed to read conversations directory",
  "Failed to shutdown telemetry client",
  "skipping empty or temp file",
  "Failed to resolve GeminiDir",
  "OAuth token lacks",
  "unknown auth method:", // 启动期探测
  "Unknown auth method:",
  // 后台元数据调用（非本轮模型请求）失败不影响本轮，避免误判
  "loadCodeAssist",
  "listExperiments",
  "v2/userinfo",
  "retrieveUserQuotaSummary",
  "availableModels",
];

interface Rule {
  kind: AgyFailureKind;
  retryable: boolean;
  re: RegExp;
}

/**
 * 顺序即优先级：越具体越靠前。
 * 例如 "transport error (Unavailable, HTTP 503): No capacity available" 同时命中 network/503，
 * 应判为 capacity（可操作性强）。
 */
const RULES: Rule[] = [
  // —— 容量 / 服务不可用（503）——
  { kind: "capacity", retryable: true, re: /No capacity available|service_unavailable|UNAVAILABLE(?::?\s*\(?(?:code\s*)?503)?|\b503\b/iu },

  // —— 频率限制（429）——
  { kind: "rate_limit", retryable: true, re: /rate_limit_exceeded|too_many_requests|RESOURCE_EXHAUSTED|rate limit exceeded|\b429\b/iu },

  // —— 订阅额度（antigravity 特有的 5 小时 / 每周窗口）——
  { kind: "quota", retryable: false, re: /quota_exceeded|quota limit|reached the quota|weekly limit|five hour|5-hour|resets? at|额度已用尽/iu },

  // —— 余额/付费（402）——
  { kind: "payment", retryable: false, re: /payment_required|credit balance|prepay|insufficient (?:credit|balance)/iu },

  // —— 登录态（401）——
  { kind: "auth", retryable: false, re: /Authentication required|invalid_grant|401 Unauthorized|token has been expired or revoked|Please sign in/iu },

  // —— 权限（403）——
  { kind: "permission", retryable: false, re: /permission_denied|403 Forbidden|project has been denied|verification required|FREE_TIER_VERIFICATION_REQUIRED/iu },

  // —— 模型不存在（404）——
  { kind: "model_not_found", retryable: false, re: /model_not_found|model .* not found|unsupported model|unknown model/iu },

  // —— 上下文超限 ——
  { kind: "context", retryable: false, re: /context length|context window|too many (?:input )?tokens|prompt is too long|input token count|exceeds? the maximum/iu },

  // —— 超时（504 / 408 / deadline）——
  { kind: "deadline", retryable: true, re: /deadline_exceeded|\b504\b|\b408\b/iu },

  // —— 安全/版权拦截 ——
  { kind: "blocked", retryable: false, re: /prohibited_content|content_blocked|\brecitation\b|\bsafety\b|\bspii\b|blocklist|unsupported language/iu },

  // —— 生成结构错误 ——
  { kind: "malformed_output", retryable: true, re: /malformed_function_call|malformed_tool_call|unexpected_tool_call|too_many_tool_calls|missing_thought_signature/iu },

  // —— 服务端错误（500/501）——
  { kind: "internal", retryable: true, re: /\bapi_error\b|\binternal\b|\b500\b|unimplemented|\b501\b/iu },

  // —— 客户端取消（499）——
  { kind: "aborted", retryable: false, re: /\bcancelled\b|\b499\b|\baborted\b/iu },

  // —— 参数错误（400）——
  { kind: "invalid_request", retryable: false, re: /invalid_request|failed_precondition|parameter_unknown|out_of_range|\b400\b/iu },

  // —— 传输层 ——
  { kind: "network", retryable: true, re: /transport error|connection reset|i\/o timeout|TLS handshake|no such host|proxyconnect|unexpected EOF|\bEOF\b|use of closed|broken pipe/iu },

  // —— agy 本机环境 ——
  { kind: "local", retryable: false, re: /keyring|advisory lock|update\.lock|must be an absolute path|cannot find the file specified/iu },
];

function meaningfulLines(text: string): string[] {
  return text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !NOISE.some((noise) => line.includes(noise)));
}

const CODE_PATTERNS = [
  /\b(invalid_request|failed_precondition|out_of_range|parameter_unknown|authentication|payment_required|permission_denied|model_not_found|already_exists|aborted|rate_limit_exceeded|quota_exceeded|too_many_requests|cancelled|api_error|unimplemented|service_unavailable|deadline_exceeded)\b/iu,
  /\b(RESOURCE_EXHAUSTED|UNAVAILABLE|DEADLINE_EXCEEDED|PERMISSION_DENIED|UNAUTHENTICATED|NOT_FOUND|INVALID_ARGUMENT|INTERNAL|FAILED_PRECONDITION|OUT_OF_RANGE|UNIMPLEMENTED|DATA_LOSS|ABORTED|ALREADY_EXISTS)\b/u,
  /\b([45]\d\d)\b/u,
];

/** 分类一段 agy 日志文本。返回首个命中的故障（已排除噪声行）。 */
export function classifyAgyLog(text: string): AgyFailure | undefined {
  const lines = meaningfulLines(text);
  if (lines.length === 0) return undefined;
  for (const rule of RULES) {
    const line = lines.find((candidate) => rule.re.test(candidate));
    if (!line) continue;
    const code = CODE_PATTERNS.map((re) => re.exec(line)?.[1]).find(Boolean);
    const model = /for model ([\w.:-]+)/iu.exec(line)?.[1] ?? /model[ =:]+([\w.:-]+)/iu.exec(line)?.[1];
    return { kind: rule.kind, code, model, retryable: rule.retryable, raw: line.slice(0, 300) };
  }
  return undefined;
}

/** 面向用户的处置建议。 */
export function describeAgyFailure(f: AgyFailure): string {
  const model = f.model ? `（模型 ${f.model}）` : "";
  const tail = f.retryable ? "可直接重试。" : "";
  switch (f.kind) {
    case "capacity":
      return `agy 上游容量不足 503${model}：Google 该模型当下没容量，不是你的配额用完。换模型（gemini-3.8-flash / claude-sonnet-5-5）或过几分钟再来。`;
    case "rate_limit":
      return `agy 被上游限流 429${model}：请求太密集。等 1–2 分钟再试，或换模型。`;
    case "quota":
      return `agy 订阅额度已用尽${model}：Antigravity 的 5 小时/每周配额到顶了。等窗口重置，或换模型（不同模型有独立额度），或换一个 Google 账号重新登录。`;
    case "payment":
      return `agy 余额/额度不足（402）${model}：需要充值或换号。${tail}`;
    case "auth":
      return `agy 登录态失效${model}：重新登录 Antigravity CLI（运行 agy 完成浏览器授权），再新开一轮。`;
    case "permission":
      return `agy 权限被拒（403）${model}：项目受限/需验证/需开账单，或该模型不在当前订阅档位。去 Google 账号侧确认订阅状态。`;
    case "model_not_found":
      return `agy 找不到模型${model}：该模型名不存在或已下线。用顶栏换一个可用模型。`;
    case "context":
      return `上下文超限${model}：本轮历史太长。用 /compact 压缩，或开新会话继续。`;
    case "deadline":
      return `agy 请求超时（504/408）${model}：上游或链路太慢。${tail}`;
    case "blocked":
      return `内容被安全/版权策略拦截${model}：调整说法或换个表述方式，不要原样重发。`;
    case "malformed_output":
      return `模型输出结构异常（工具调用格式错误）${model}：直接重试一次，通常能过去。`;
    case "internal":
      return `Google 服务端临时错误（500/501）${model}：稍等重试。`;
    case "aborted":
      return `本轮被取消（499/aborted）${model}：无需处理，重新发起即可。`;
    case "invalid_request":
      return `请求参数不合法（400）${model}：多为模型参数/工具定义不被支持。换模型或简化请求。`;
    case "network":
      return `agy 与 Google 的连接中断${model}：确认网络/代理可用（如需代理请设 PI_AGY_PROXY），再重试。`;
    case "local":
      return `agy 本机环境异常${model}：检查 agy 的登录凭据或安装/锁文件（~/.gemini/antigravity-cli/updater/update.lock）。`;
    default:
      return `agy 报错：${f.raw}`;
  }
}