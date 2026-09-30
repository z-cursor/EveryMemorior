import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type InlineExtension } from "@earendil-works/pi-coding-agent";

export const BIOGRAPHY_BOOK_ASSEMBLER_TOOL = "biography_book_assembler";

const CHAPTER_TITLES = [
  "第一章 出生与童年",
  "第二章 求学与青春",
  "第三章 工作与奋斗",
  "第四章 家庭与养育",
  "第五章 晚年与当下",
  "第六章 感悟与寄语",
] as const;

type JsonObject = Record<string, unknown>;

export type BiographyAssemblyResult =
  | {
      status: "success";
      case_id: string;
      final_txt: string;
      book_name: string;
      visible_character_count: number;
    }
  | {
      status: "blocked";
      reason: string;
      case_id?: string;
      blocking_chapters?: Array<{ chapter: number; title: string; reasons: string[] }>;
    };

function normalizeText(value: string): string {
  return value.replace(/^\uFEFF/u, "").replace(/\r\n?/gu, "\n").replace(/[\u200B\uFEFF]/gu, "").trim();
}

function visibleCount(value: string): number {
  return [...value.replace(/\s/gu, "")].length;
}

function withoutPunctuation(value: string): string {
  return [...value].filter((char) => !/\s/u.test(char) && !/\p{P}/u.test(char)).join("");
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function readJson(file: string): Promise<JsonObject> {
  const value = JSON.parse(await readFile(file, "utf8"));
  if (!value || Array.isArray(value) || typeof value !== "object") throw new Error(`JSON 顶层必须是对象：${file}`);
  return value as JsonObject;
}

async function exists(file: string): Promise<boolean> {
  try {
    await readFile(file);
    return true;
  } catch {
    return false;
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function safeCaseId(value: string): string {
  if (!/^[\p{L}\p{N}._-]+$/u.test(value)) throw new Error("case_id contains an unsafe path");
  return value;
}

function virtualPath(root: string, file: string): string {
  const suffix = relative(resolve(root), resolve(file)).split(sep).join("/");
  return suffix ? `/workspace/${suffix}` : "/workspace";
}

function isoDate(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

function displayDate(date = new Date()): string {
  const [year, month, day] = isoDate(date).split("-").map(Number);
  return `${year}年${month}月${day}日`;
}

function fileNamePart(value: string): string {
  return value.replace(/[<>:"/\\|?*\u0000-\u001F]/gu, "-").trim() || "传记";
}

async function findPolicy(workspaceRoot: string, skillPaths: readonly string[]): Promise<JsonObject | undefined> {
  for (const root of [workspaceRoot, ...skillPaths]) {
    const file = join(root, "policies", "chapter-lengths.json");
    if (await exists(file)) return readJson(file);
  }
  // A published package may keep policies beside its declared `skills/`
  // directory (for example `<release>/biography-agent-longform/policies`).
  // Search only inside the immutable release roots and never follow symlinks.
  const pending = skillPaths.map((root) => ({ root: resolve(root), depth: 0 }));
  while (pending.length > 0) {
    const { root, depth } = pending.shift()!;
    if (depth >= 4) continue;
    let entries;
    try { entries = await readdir(root, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
      const child = join(root, entry.name);
      const policy = join(child, "policies", "chapter-lengths.json");
      if (await exists(policy)) return readJson(policy);
      pending.push({ root: child, depth: depth + 1 });
    }
  }
  return undefined;
}

async function resolveCase(workspaceRoot: string, requestedCaseId?: string): Promise<{ caseId: string; caseRoot: string } | null> {
  const registryFile = join(workspaceRoot, "biography-project.json");
  if (await exists(registryFile)) {
    const registry = await readJson(registryFile);
    const caseId = requestedCaseId ?? stringValue(registry.active_case_id);
    if (!caseId) return null;
    const item = Array.isArray(registry.cases)
      ? registry.cases.find((candidate) => candidate && typeof candidate === "object" && (candidate as JsonObject).case_id === caseId) as JsonObject | undefined
      : undefined;
    const caseDir = stringValue(item?.case_dir) ?? join("cases", safeCaseId(caseId));
    const caseRoot = resolve(workspaceRoot, caseDir);
    if (!isWithin(workspaceRoot, caseRoot)) throw new Error("case_dir is outside the workspace");
    return { caseId, caseRoot };
  }

  if (requestedCaseId) {
    const caseId = safeCaseId(requestedCaseId);
    return { caseId, caseRoot: join(workspaceRoot, "cases", caseId) };
  }
  return null;
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`));
}

async function validateChapter(caseRoot: string, chapter: number): Promise<{ body: string; reasons: string[] }> {
  const stem = `chapter-${String(chapter).padStart(2, "0")}`;
  const chapterJson = join(caseRoot, "chapters", `${stem}.json`);
  const chapterTxt = join(caseRoot, "chapters", `${stem}.txt`);
  const reasons: string[] = [];
  if (!(await exists(chapterJson))) reasons.push("缺少章节 JSON");
  if (!(await exists(chapterTxt))) reasons.push("缺少章节 TXT");
  if (reasons.length) return { body: "", reasons };

  const chapterData = await readJson(chapterJson);
  const body = stringValue(chapterData.body_text) ?? "";
  const title = stringValue(chapterData.title);
  if (chapterData.chapter_order !== chapter || title !== CHAPTER_TITLES[chapter - 1] || !body) reasons.push("章节 JSON 与当前章节不一致");
  const txt = normalizeText(await readFile(chapterTxt, "utf8"));
  if (txt !== normalizeText(`${CHAPTER_TITLES[chapter - 1]}\n\n${body}`)) reasons.push("章节 TXT 与 JSON 正文不一致");

  const bodySha = sha256(body);
  const noPunctuationSha = sha256(withoutPunctuation(body));
  const punctuation = await readJson(join(caseRoot, "reviews", `${stem}-punctuation.json`)).catch(() => null);
  const proofreading = await readJson(join(caseRoot, "reviews", `${stem}-proofreading.json`)).catch(() => null);
  const review = await readJson(join(caseRoot, "reviews", `${stem}-review.json`)).catch(() => null);
  const approval = await readJson(join(caseRoot, "reviews", `${stem}-user-approval.json`)).catch(() => null);

  if (punctuation?.status !== "pass" || punctuation.chapter_sha256 !== bodySha) reasons.push("标点报告未绑定当前正文");
  if (proofreading?.status !== "pass" || proofreading.chapter_sha256 !== bodySha || proofreading.non_punctuation_sha256 !== noPunctuationSha) reasons.push("文字校正报告未绑定当前正文");
  if (review?.status !== "pass" || review.approved_for_assembly !== true || review.chapter_sha256 !== bodySha) reasons.push("审核报告未通过或未绑定当前正文");
  if (approval?.user_approved !== true || approval.chapter_sha256 !== bodySha || approval.chapter_visible_character_count !== visibleCount(body)) reasons.push("用户批准未绑定当前正文");
  return { body, reasons };
}

export async function assembleBiographyBook(
  workspaceRoot: string,
  options: { caseId?: string; skillPaths?: readonly string[]; now?: Date } = {},
): Promise<BiographyAssemblyResult> {
  const root = resolve(workspaceRoot);
  const resolved = await resolveCase(root, options.caseId);
  if (!resolved) return { status: "blocked", reason: "没有活动传记案例；请先建立案例并登记六章问答" };
  const { caseId, caseRoot } = resolved;
  if (!isWithin(root, caseRoot) || !(await exists(join(caseRoot, "case.json")))) {
    return { status: "blocked", reason: "传记案例不存在或不在当前工作区", case_id: caseId };
  }
  const caseData = await readJson(join(caseRoot, "case.json"));
  const subject = stringValue(caseData.subject_name) ?? stringValue(caseData.title);
  if (!subject) return { status: "blocked", reason: "案例缺少传主姓名", case_id: caseId };

  const checked = await Promise.all(CHAPTER_TITLES.map((_, index) => validateChapter(caseRoot, index + 1)));
  const blockingChapters = checked
    .map((item, index) => ({ chapter: index + 1, title: CHAPTER_TITLES[index], reasons: item.reasons }))
    .filter((item) => item.reasons.length);
  if (blockingChapters.length) return { status: "blocked", reason: "六章必须全部通过审核并由用户批准", case_id: caseId, blocking_chapters: blockingChapters };

  const policy = await findPolicy(root, options.skillPaths ?? []);
  const minimum = Number((policy?.book as JsonObject | undefined)?.minimum);
  const visibleCharacterCount = checked.reduce((total, chapter) => total + visibleCount(chapter.body), 0);
  if (!Number.isFinite(minimum) || minimum <= 0) return { status: "blocked", reason: "缺少有效的 policies/chapter-lengths.json", case_id: caseId };
  if (visibleCharacterCount < minimum) return { status: "blocked", reason: `六章正文共 ${visibleCharacterCount} 字，低于整书最低 ${minimum} 字`, case_id: caseId };

  const narrative = (caseData.narrative_config ?? {}) as JsonObject;
  const familyBiography = narrative.subject_type === "direct_relative" || narrative.biography_type === "family_biography" || narrative.narrative_person === "third";
  const bookName = `${subject}${familyBiography ? "传" : "自传"}`;
  const date = options.now ?? new Date();
  const datePart = isoDate(date);
  const output = join(root, "deliverables", datePart, safeCaseId(caseId), `${fileNamePart(bookName)}_${datePart}.txt`);
  const chapterText = checked.map((chapter, index) => `${CHAPTER_TITLES[index]}\n\n${chapter.body}`).join("\n\n");
  const text = [
    `《${bookName}》`,
    "",
    `${familyBiography ? "传主" : "作者"}：${subject}`,
    "整理：Biography Agent",
    `生成日期：${displayDate(date)}`,
    "",
    "目录",
    "",
    ...CHAPTER_TITLES,
    "",
    "正文",
    "",
    chapterText,
    "",
  ].join("\n");
  await mkdir(join(root, "deliverables", datePart, safeCaseId(caseId)), { recursive: true });
  try {
    await writeFile(output, text, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return { status: "blocked", reason: "当天同一案例的最终稿已存在，不覆盖既有成品", case_id: caseId };
    throw error;
  }
  return { status: "success", case_id: caseId, final_txt: virtualPath(root, output), book_name: bookName, visible_character_count: visibleCharacterCount };
}

export function createBiographyBookAssemblerExtension(options: {
  workspaceRoot: string;
  skillPaths?: readonly string[];
}): InlineExtension {
  return {
    name: "pi-web-biography-book-assembler",
    hidden: true,
    factory: (pi) => {
      pi.registerTool(defineTool({
        name: BIOGRAPHY_BOOK_ASSEMBLER_TOOL,
        label: "Biography Book Assembler",
        description: "将六个机器审核通过且均由用户逐章批准的章节 TXT 合成为一份最终中文传记 TXT。只读取并校验当前工作区的案例产物，不改写章节、不补造内容。",
        promptSnippet: "Assemble the six approved biography chapters into the final TXT",
        promptGuidelines: [
          "仅当六章当前正文都有标点报告、文字校正报告、审核 pass 和当前正文哈希一致的用户批准记录时调用。",
          "缺章、报告过期、用户未批准或整书字数不足时，保留 blocked 结果，不要用普通 write/edit/bash 绕过门禁。",
          "最终稿写入当前租户工作区的 deliverables/YYYY-MM-DD/<case_id>/ 目录，并返回 /workspace 虚拟路径。",
        ],
        parameters: Type.Object({
          case_id: Type.Optional(Type.String({ description: "Optional case id; defaults to the active case" })),
        }),
        async execute(_id, params, signal, onUpdate) {
          if (signal?.aborted) throw new Error("Biography book assembly cancelled");
          onUpdate?.({ content: [{ type: "text", text: "正在校验六章传记产物" }], details: { status: "running" } });
          const result = await assembleBiographyBook(options.workspaceRoot, {
            caseId: params.case_id,
            skillPaths: options.skillPaths,
          });
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            details: result,
          };
        },
      }));
    },
  };
}
