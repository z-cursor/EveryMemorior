import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const shell = await readFile(new URL("./CompanionShell.tsx", import.meta.url), "utf8");
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
