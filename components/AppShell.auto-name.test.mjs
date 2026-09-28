import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync(new URL("./AppShell.tsx", import.meta.url), "utf8");

test("压缩后的会话仍可根据持久化消息数生成标题", () => {
  assert.match(
    source,
    /\(sessionStats\?\.userMessages \?\? 0\) > 0 \|\| selectedSession\.messageCount > 0/,
  );
});

test("尚未落盘的会话不会触发依赖 JSONL 的自动命名", () => {
  assert.match(
    source,
    /const disabled = !selectedSession \|\| selectedSession\.transient \|\| !hasMessages/,
  );
});

test("会话落盘后会用服务端记录清除临时状态", () => {
  assert.match(source, /\{ \.\.\.prev, \.\.\.full, transient: full\.transient \?\? false \}/);
  assert.match(source, /if \(selectedSession\) hydrateSelectedSession\(selectedSession\.id\)/);
});

test("旧租户会话不会从 URL 恢复", () => {
  assert.match(source, /SessionSidebar only restores ids present in the current tenant's/);
  assert.match(source, /router\.replace\(window\.location\.pathname, \{ scroll: false \}\)/);
});

test("会话失去租户权限时会卸载并停止重试", () => {
  assert.match(source, /onSessionAccessLost=\{handleSessionAccessLost\}/);
  assert.match(source, /setSelectedSession\(null\)/);
  assert.match(source, /setSessionKey\(\(k\) => k \+ 1\)/);
});
