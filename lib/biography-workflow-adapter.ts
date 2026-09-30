import { lstatSync, readdirSync } from "node:fs";
import { join, posix, relative, resolve, sep } from "node:path";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { runAgentSandboxSkillCommand } from "./tenant-agent-runtime";
import { samePath } from "./paths";
import { resolveSkillExecutionTimeoutMs } from "./skill-timeouts";
import installNativeBiographyWorkflow from "./biography-workflow-native";

/**
 * Names exposed by the server-owned biography compatibility layer. The
 * uploaded package's TypeScript extension is deliberately never imported;
 * a reviewed copy of its extension is bundled by the platform and only its
 * `pi.exec` seam is redirected to the Python bridge inside AgentSandbox.
 */
export const BIOGRAPHY_WORKFLOW_TOOL_NAMES = [
  "biography_workflow",
  "biography_chapter_writer",
  "biography_chapter_polisher",
  "biography_chapter_punctuation",
  "biography_chapter_proofreader",
  "biography_chapter_reviewer",
  "biography_section_title_manager",
  "biography_chapter_reviser",
  "biography_chapter_user_approval",
  "biography_book_assembler",
  "biography_chapter_source",
  "biography_chapter_interviewer",
] as const;

type JsonObject = Record<string, unknown>;
type NativeTool = {
  execute?: (...args: unknown[]) => unknown;
  [key: string]: unknown;
};
type AdapterContext = {
  cwd?: string;
  model?: { provider?: string; id?: string };
  sessionManager?: { getSessionId(): string };
};

const WORKFLOW_ACTIONS = [
  "doctor", "active", "list", "new", "configure", "set-subject", "switch", "snapshot", "archive",
  "archive-chapter", "sync", "ready", "confirm", "complete", "length-refresh",
] as const;
const LLM_ACTIONS = new Set([
  "chapter-write", "chapter-revise", "chapter-polish", "chapter-punctuate", "chapter-proofread", "chapter-review",
  "section-title-manage", "section-title-migrate",
]);

/**
 * Resolve the host deadline for a complete bridge invocation. Long-form
 * writing is intentionally allowed the full 40-minute default because one
 * chapter contains several model calls and checkpoint/retry work. The LLM
 * request timeout is read elsewhere and never participates in this decision.
 */
export function resolveBiographyToolTimeoutMs(name: string, environment: Record<string, string | undefined> = process.env): number {
  if (!LLM_ACTIONS.has(actionForTool(name, {}))) return 300_000;
  return resolveSkillExecutionTimeoutMs(environment);
}

function isRegularFile(path: string): boolean {
  try { return lstatSync(path).isFile(); } catch { return false; }
}

function findBridgeRoot(paths: readonly string[]): { root: string; script: string } | undefined {
  for (const raw of paths) {
    const root = resolve(raw);
    const direct = join(root, "scripts", "pi_bridge.py");
    const nested = join(root, "biography-agent-longform", "scripts", "pi_bridge.py");
    for (const candidate of [direct, nested]) {
      if (isRegularFile(candidate)) return { root, script: relative(root, candidate).split(sep).join("/") };
    }
    // Published archives may put one package directory below the release
    // root. Scan one level only; do not recursively inspect tenant content.
    let entries: Array<{ name: string; isDirectory(): boolean; isSymbolicLink(): boolean }>;
    try {
      entries = readdirSync(root, { withFileTypes: true, encoding: "utf8" }) as unknown as typeof entries;
    } catch { entries = []; }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const candidate = join(root, entry.name, "scripts", "pi_bridge.py");
      if (isRegularFile(candidate)) return { root, script: relative(root, candidate).split(sep).join("/") };
    }
  }
  return undefined;
}

/** Return the container-visible bridge path without exposing a host path. */
export function resolveBiographyBridgePath(paths: readonly string[]): string | undefined {
  const bridge = findBridgeRoot(paths);
  if (!bridge) return undefined;
  const index = paths.findIndex((path) => samePath(path, bridge.root));
  if (index < 0) return undefined;
  return `/opt/pi-agent/skills/${index}/${bridge.script}`;
}

function base64(value: unknown): string | undefined {
  return typeof value === "string" ? Buffer.from(value, "utf8").toString("base64") : undefined;
}

function push(args: string[], flag: string, value: unknown): void {
  if (typeof value === "string" && value.trim()) args.push(flag, value);
}

function pushNumber(args: string[], flag: string, value: unknown): void {
  if (typeof value === "number" && Number.isInteger(value)) args.push(flag, String(value));
}

function workspacePath(value: string, root: string | undefined): string {
  const candidate = value.trim();
  if (candidate === "/workspace" || candidate.startsWith("/workspace/")) {
    const inside = candidate === "/workspace" ? "" : candidate.slice("/workspace/".length);
    const normalized = posix.resolve("/workspace", inside);
    const escaped = posix.relative("/workspace", normalized);
    if (escaped === ".." || escaped.startsWith("../") || posix.isAbsolute(escaped)) {
      throw new Error("source_path must remain inside /workspace");
    }
    return normalized;
  }
  if (!root) throw new Error("source_path must be inside /workspace");
  const child = relative(resolve(root), resolve(candidate));
  if (!child || child === ".." || child.startsWith(`..${sep}`)) throw new Error("source_path must be inside the tenant workspace");
  return `/workspace/${child.split(sep).join("/")}`;
}

function addCommonArgs(args: string[], params: JsonObject): void {
  push(args, "--title", params.title);
  push(args, "--subject-name", params.subject_name);
  push(args, "--case-id", params.case_id);
  push(args, "--label", params.label);
  push(args, "--subject-type", params.subject_type);
  push(args, "--relationship-to-user", params.relationship_to_user);
  push(args, "--narrative-person", params.narrative_person);
  push(args, "--subject-pronoun", params.subject_pronoun);
  push(args, "--target-readers", params.target_readers);
  push(args, "--writing-purpose", params.writing_purpose);
  push(args, "--narrative-tone", params.narrative_tone);
  push(args, "--title-operation", params.operation);
  pushNumber(args, "--chapter", params.chapter);
}

function actionForTool(name: string, params: JsonObject): string {
  if (name === "biography_workflow") return String(params.action ?? "");
  if (name === "biography_chapter_writer") return "chapter-write";
  if (name === "biography_chapter_polisher") return "chapter-polish";
  if (name === "biography_chapter_punctuation") return "chapter-punctuate";
  if (name === "biography_chapter_proofreader") return "chapter-proofread";
  if (name === "biography_chapter_reviewer") return "chapter-review";
  if (name === "biography_section_title_manager") return "section-title-manage";
  if (name === "biography_chapter_reviser") return "chapter-revise";
  if (name === "biography_chapter_user_approval") return "chapter-user-approve";
  if (name === "biography_book_assembler") return "assemble-book";
  if (name === "biography_chapter_source") return "chapter-source";
  if (name === "biography_chapter_interviewer") return "chapter-interview";
  return "";
}

export function buildBiographyBridgeArgs(
  name: string,
  params: JsonObject,
  sessionId: string,
  model: AdapterContext["model"],
  workspaceRoot?: string,
): string[] {
  const action = actionForTool(name, params);
  if (!action || (name === "biography_workflow" && !WORKFLOW_ACTIONS.includes(action as never))) {
    throw new Error("Unsupported biography workflow action");
  }
  const args = [action, "--workspace-root", "/workspace", "--session-id", sessionId];
  addCommonArgs(args, params);
  if (params.force_rewrite === true) args.push("--force-rewrite");
  push(args, "--feedback-source", params.feedback_source);
  if (typeof params.feedback === "string") {
    const encoded = base64(params.feedback);
    if (encoded) args.push("--feedback-base64", encoded);
  }
  if (typeof params.answer === "string") {
    const encoded = base64(params.answer);
    if (encoded) args.push("--answer-base64", encoded);
  }
  if (typeof params.source_path === "string" && params.source_path.trim()) {
    // The bridge sees only the mounted workspace. Absolute host paths are
    // intentionally rejected instead of being smuggled into the container.
    args.push("--source-path", workspacePath(params.source_path, workspaceRoot));
  }
  push(args, "--question", params.question);
  push(args, "--material-goal", params.material_goal);
  push(args, "--choice", params.choice);
  if (name === "biography_chapter_interviewer") {
    push(args, "--interview-action", params.interview_action ?? params.action);
  }
  pushNumber(args, "--target-question-number", params.target_question_number);
  if (Array.isArray(params.remaining_subquestions)) {
    const encoded = base64(JSON.stringify(params.remaining_subquestions));
    if (encoded) args.push("--remaining-subquestions-base64", encoded);
  }
  if (Array.isArray(params.unavailable_subquestions)) {
    const encoded = base64(JSON.stringify(params.unavailable_subquestions));
    if (encoded) args.push("--unavailable-subquestions-base64", encoded);
  }
  if (Array.isArray(params.resolved_subquestions)) {
    const encoded = base64(JSON.stringify(params.resolved_subquestions));
    if (encoded) args.push("--resolved-subquestions-base64", encoded);
  }
  if (LLM_ACTIONS.has(action)) {
    const provider = model?.provider?.trim();
    const modelId = model?.id?.trim();
    if (!provider || !modelId) throw new Error(`传记工具 ${action} 无法取得 Pi 当前会话模型，已停止调用`);
    args.push("--worker-provider", provider, "--worker-model", modelId);
  }
  return args;
}

function optionValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  const value = index >= 0 ? args[index + 1] : undefined;
  return value && !value.startsWith("--") ? value : undefined;
}

function replaceArgValue(args: string[], flag: string, value: string): void {
  const index = args.indexOf(flag);
  if (index >= 0 && index + 1 < args.length) args[index + 1] = value;
}

/**
 * Keep the original extension's path and case-selection semantics while
 * translating only paths that cross the Docker boundary. The native extension
 * still owns interview state, duplicate-question guards, acknowledgements,
 * pause/choice handling, and the automatic stage transitions.
 */
function containerizeNativeArgs(
  rawArgs: readonly string[],
  workspaceRoot: string | undefined,
): { args: string[]; sessionId: string; provider?: string; modelId?: string } {
  const args = [...rawArgs];
  const sessionId = optionValue(args, "--session-id");
  if (!sessionId) throw new Error("Biography workflow requires a persisted Agent session");
  const root = workspaceRoot ? resolve(workspaceRoot) : undefined;
  if (!root) throw new Error("Biography workflow requires a tenant workspace");
  replaceArgValue(args, "--workspace-root", "/workspace");
  for (const flag of ["--source-path", "--session-case-hint"]) {
    const value = optionValue(args, flag);
    if (!value) continue;
    if (flag === "--session-case-hint") continue;
    replaceArgValue(args, flag, workspacePath(value, root));
  }
  return {
    args,
    sessionId,
    provider: optionValue(args, "--worker-provider"),
    modelId: optionValue(args, "--worker-model"),
  };
}

function rewriteWorkspacePaths(value: string, workspaceRoot: string | undefined): string {
  if (!workspaceRoot) return value;
  const root = resolve(workspaceRoot);
  // Bridge results are JSON or plain text. Restrict replacement to the
  // container's virtual root so user prose containing unrelated paths is not
  // rewritten.
  return value.replace(/\/workspace(?=\/|$)/gu, root.replace(/\\/gu, "/"));
}

/**
 * Build the server-owned extension used by tenant-isolated sessions.
 *
 * This intentionally installs a reviewed, server-bundled copy of the
 * biography extension. It does not import TypeScript from the uploaded Skill
 * release. Only the extension's `pi.exec` seam is replaced with an argv-only
 * Docker invocation, so the original interviewer state machine remains
 * intact without executing tenant code on the host.
 */
export function createBiographyWorkflowAdapterExtension(options: {
  skillPaths: readonly string[];
  workspaceRoot?: string;
}): InlineExtension {
  const bridge = findBridgeRoot(options.skillPaths);
  return {
    name: "pi-web-biography-workflow-compatible",
    hidden: true,
    factory: (pi) => {
      const nativePi = new Proxy(pi as object, {
        get(target, property, receiver) {
          if (property !== "exec") {
            const value = Reflect.get(target, property, receiver);
            // The production Pi API always supplies `on`; the tiny fake used
            // by adapter unit tests only needs tool registration.
            if (property === "on" && typeof value !== "function") return () => undefined;
            if (property === "registerTool" && typeof value === "function") {
              return (rawTool: unknown) => {
                const tool = rawTool as NativeTool | undefined;
                if (!tool || typeof tool.execute !== "function") return value.call(target, tool);
                const execute = tool.execute;
                return value.call(target, {
                  ...tool,
                  execute: async (...callArgs: unknown[]) => {
                    const context = callArgs[4];
                    const manager = (context as { sessionManager?: Record<string, unknown> } | undefined)?.sessionManager;
                    if (manager && typeof manager.getBranch !== "function") {
                      callArgs[4] = {
                        ...(context as Record<string, unknown>),
                        sessionManager: { ...manager, getBranch: () => [] },
                      };
                    }
                    return execute(...callArgs);
                  },
                });
              };
            }
            return typeof value === "function" ? value.bind(target) : value;
          }
          return async (_command: string, rawArgs: readonly string[], execOptions: { signal?: AbortSignal; timeout?: number } = {}) => {
            if (!bridge) throw new Error("runtime artifact not ready: biography bridge is not present");
            const normalized = containerizeNativeArgs(rawArgs, options.workspaceRoot);
            const result = await runAgentSandboxSkillCommand(
              normalized.sessionId,
              bridge.root,
              bridge.script,
              normalized.args.slice(3),
              {
                signal: execOptions.signal,
                timeoutMs: execOptions.timeout ?? resolveSkillExecutionTimeoutMs(),
                modelRoute: normalized.provider && normalized.modelId
                  ? { provider: normalized.provider, modelId: normalized.modelId }
                  : undefined,
              },
            );
            return {
              code: result.exitCode ?? 1,
              stdout: rewriteWorkspacePaths(result.stdout || result.output, options.workspaceRoot),
              stderr: rewriteWorkspacePaths(result.stderr, options.workspaceRoot),
              killed: result.cancelled || result.timedOut,
            };
          };
        },
      });
      installNativeBiographyWorkflow(nativePi as never);
    },
  };
}
