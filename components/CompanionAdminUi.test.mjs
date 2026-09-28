import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const team = await readFile(new URL("./TenantSettings.tsx", import.meta.url), "utf8");
const quality = await readFile(new URL("./CompanionGovernanceSettings.tsx", import.meta.url), "utf8");
const css = await readFile(new URL("../app/companion-admin.css", import.meta.url), "utf8");
const panel = await readFile(new URL("./SettingsPanel.tsx", import.meta.url), "utf8");

test("member administration comes before advanced settings and never fetches governance data", () => {
  assert.ok(team.indexOf('title="成员与权限"') < team.indexOf("租户管理 ·"));
  assert.match(team, /邀请陪伴成员/);
  assert.match(team, /role: "member" as Role/);
  assert.match(team, /不会创建 Member 账号/);
  assert.doesNotMatch(team, /\/api\/tenant\/companion|companionDraft|refreshGovernance/);
});

test("administration surfaces own their scroll area and support narrow screens", () => {
  assert.match(css, /\.admin-settings\s*\{[^}]*height: 100%[^}]*overflow-y: auto/s);
  assert.match(css, /@media \(max-width: 600px\)/);
  assert.match(css, /focus-visible/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(panel, /import "@\/app\/companion-admin\.css"/);
  assert.match(panel, /onOpenQuality=\{\(\) => activateSection\("quality"\)\}/);
  assert.match(panel, /onOpenTeam=\{\(\) => activateSection\("tenant"\)\}/);
});

test("skill governance is loaded for admins and draft upload stays in its own form", () => {
  assert.match(team, /data\?\.canManage \? "\?view=governance"/);
  assert.match(team, /onSubmit=\{\(event\) => \{ event\.stopPropagation\(\); uploadSkill\(event\); \}\}/);
  assert.match(team, /<ConfigButton type="submit" onClick=\{\(event\) => event\.stopPropagation\(\)\}[^>]*>上传 ZIP 草稿/);
  assert.match(team, /sendAgentCommand\(sessionId, \{ type: "reload", refreshTenantSkills: true \}\)/);
});

test("advanced Skill upload keeps the file picker and submit action connected", () => {
  assert.match(team, /htmlFor="tenant-skill-file"/);
  assert.match(team, /id="tenant-skill-file"[\s\S]*?ref=\{skillFileInputRef\}/);
  assert.match(team, /className="admin-file-picker"[\s\S]*?skillFile\?\.name/);
  assert.match(team, /<input ref=\{skillFileInputRef\} id="tenant-skill-file" className="admin-file-input"/);
  assert.match(team, /setSkillFile\(null\);\s*if \(skillFileInputRef\.current\) skillFileInputRef\.current\.value = ""/);
  assert.match(team, /className="admin-skill-upload"/);
});

test("quality separates tasks, preserves dirty drafts and requires explicit publication", () => {
  for (const label of ["配置与发布", "人工复核", "内部试用", "迁移与审计"]) assert.ok(quality.includes(label));
  assert.match(quality, /if \(!initialized\.current\)/);
  assert.match(quality, /publicationBlocker\(config\.id, state\.evaluations\)/);
  assert.match(quality, /window\.confirm\(`确认发布/);
  assert.match(quality, /const confirmMigration/);
  assert.match(quality, /取消，不作修改/);
  assert.match(quality, /暂无样本/);
  assert.match(quality, /role=|AdminFeedback/);
});
