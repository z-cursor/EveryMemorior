import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assembleBiographyBook, createBiographyBookAssemblerExtension, BIOGRAPHY_BOOK_ASSEMBLER_TOOL } from "./biography-book-assembler.ts";

const titles = [
  "第一章 出生与童年", "第二章 求学与青春", "第三章 工作与奋斗",
  "第四章 家庭与养育", "第五章 晚年与当下", "第六章 感悟与寄语",
];

const sha256 = (value) => createHash("sha256").update(value, "utf8").digest("hex");
const noPunctuation = (value) => [...value].filter((char) => !/\s/u.test(char) && !/\p{P}/u.test(char)).join("");

async function writeJson(file, value) {
  await mkdir(join(file, ".."), { recursive: true });
  await writeFile(file, `${JSON.stringify(value)}\n`, "utf8");
}

async function createCase(root) {
  const caseId = "xiaoming-1";
  const caseRoot = join(root, "cases", caseId);
  await writeJson(join(root, "biography-project.json"), { schema_version: 1, active_case_id: caseId, cases: [{ case_id: caseId }] });
  await writeJson(join(root, "policies", "chapter-lengths.json"), { book: { minimum: 6 } });
  await writeJson(join(caseRoot, "case.json"), {
    case_id: caseId,
    title: "小明",
    narrative_config: { subject_type: "direct_relative", biography_type: "family_biography", narrative_person: "third" },
  });
  for (let index = 0; index < titles.length; index += 1) {
    const chapter = index + 1;
    const body = `这是第${chapter}章。`;
    const bodySha = sha256(body);
    const stem = `chapter-${String(chapter).padStart(2, "0")}`;
    await writeJson(join(caseRoot, "chapters", `${stem}.json`), {
      chapter_order: chapter, title: titles[index], body_text: body,
    });
    await mkdir(join(caseRoot, "chapters"), { recursive: true });
    await writeFile(join(caseRoot, "chapters", `${stem}.txt`), `${titles[index]}\n\n${body}\n`, "utf8");
    await writeJson(join(caseRoot, "reviews", `${stem}-punctuation.json`), { status: "pass", chapter_sha256: bodySha });
    await writeJson(join(caseRoot, "reviews", `${stem}-proofreading.json`), { status: "pass", chapter_sha256: bodySha, non_punctuation_sha256: sha256(noPunctuation(body)) });
    await writeJson(join(caseRoot, "reviews", `${stem}-review.json`), { status: "pass", approved_for_assembly: true, chapter_sha256: bodySha });
    await writeJson(join(caseRoot, "reviews", `${stem}-user-approval.json`), { user_approved: true, chapter_sha256: bodySha, chapter_visible_character_count: [...body].length });
  }
  return { caseId, caseRoot };
}

test("the tenant biography assembler blocks incomplete chapters and writes a virtualized final path", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "pi-web-biography-"));
  try {
    const { caseId } = await createCase(workspace);
    const result = await assembleBiographyBook(workspace, { now: new Date("2026-09-27T00:00:00.000Z") });
    assert.deepEqual(result, {
      status: "success",
      case_id: caseId,
      final_txt: "/workspace/deliverables/2026-09-27/xiaoming-1/小明传_2026-09-27.txt",
      book_name: "小明传",
      visible_character_count: 36,
    });
    const output = await readFile(join(workspace, "deliverables", "2026-09-27", caseId, "小明传_2026-09-27.txt"), "utf8");
    assert.match(output, /《小明传》/u);
    assert.match(output, /传主：小明/u);
    assert.match(output, /目录[\s\S]*正文/u);

    await rm(join(workspace, "cases", caseId, "reviews", "chapter-06-user-approval.json"));
    const blocked = await assembleBiographyBook(workspace, { now: new Date("2026-09-28T00:00:00.000Z") });
    assert.equal(blocked.status, "blocked");
    assert.equal(blocked.blocking_chapters?.[0]?.chapter, 6);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("the inline extension registers the model-facing assembler tool", () => {
  const registered = [];
  createBiographyBookAssemblerExtension({ workspaceRoot: "/workspace" }).factory({
    registerTool(tool) { registered.push(tool); },
  });
  assert.equal(registered[0].name, BIOGRAPHY_BOOK_ASSEMBLER_TOOL);
});
