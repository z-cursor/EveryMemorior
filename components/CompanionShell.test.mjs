import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const shell = await readFile(new URL("./CompanionShell.tsx", import.meta.url), "utf8");
const understanding = await readFile(new URL("./CompanionUnderstandingPanel.tsx", import.meta.url), "utf8");
const appShell = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

test("routes ordinary members to the companion shell and keeps the coding shell for administrators", () => {
  assert.match(appShell, /tenantRole === "member" && hostAccess === false/);
  assert.match(appShell, /<CompanionShell \/>/);
});
test("companion shell discloses AI identity and provides keyboard-accessible stop and privacy controls", () => {
  assert.match(shell, /凡小忆是 AI/);
  assert.match(shell, /不能联系、定位、报警或救援/);
  assert.match(shell, /停止回复/);
  assert.match(shell, /隐私说明/);
  assert.match(shell, /aria-live="polite"/);
  assert.match(shell, /role=\{error \? "alert" : "status"\}/);
  assert.match(css, /\.companion-composer button:focus-visible/);
  assert.match(css, /min-height: 46px/);
});

test("member shell exposes consent, memory receipts, profile, display, and privacy controls without Agent settings", () => {
  assert.match(shell, /凡小忆对我的了解/);
  assert.match(shell, /长期记忆默认关闭/);
  assert.match(shell, /memory_receipt/);
  assert.match(shell, /memory_confirmation/);
  assert.match(shell, /setMemoryNotices\(\(current\) =>/);
  assert.match(shell, /memoryNotices\.map/);
  assert.match(shell, /current\.filter\(\(notice\) => notice\.id !== memoryNotice\.id\)/);
  assert.match(shell, /撤销记忆/);
  assert.match(shell, /确认记住/);
  assert.match(shell, /preview_source_deletion/);
  assert.match(shell, /delete_source/);
  assert.match(understanding, /\/api\/companion\/understanding/);
  assert.match(understanding, /set_consent/);
  assert.match(understanding, /correct_memory/);
  assert.match(understanding, /delete_memory/);
  assert.match(understanding, /reset_memories/);
  assert.match(understanding, /set_profile/);
  assert.match(understanding, /disabled={!data\?\.consent\.memoryEnabled}/);
  assert.match(understanding, /reset_profile/);
  assert.match(understanding, /correct_fragment/);
  assert.match(understanding, /delete_fragment/);
  assert.match(understanding, /reset_fragments/);
  assert.match(understanding, /显示设置/);
  assert.match(understanding, /90 天/);
  assert.doesNotMatch(understanding, /模型|thinking|tools|system prompt/i);
});
