// Isolated browser regression of the real components. No Next server, login,
// production data or model calls: every API request is fulfilled in memory.
// Run: node e2e/companion-settings.mjs (uses installed Playwright + esbuild).
// Pass --edge to use an existing Microsoft Edge installation without downloading Chromium.
import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { build } from "esbuild";
import { chromium } from "playwright";

const root = resolve(import.meta.dirname, "..");
const output = resolve(root, "test-results/companion-settings");
await mkdir(output, { recursive: true });
const bundle = await build({
  stdin: {
    contents: `import React, {useState} from "react";
      import {createRoot} from "react-dom/client";
      import {TenantSettings} from "./components/TenantSettings";
      import {CompanionGovernanceSettings} from "./components/CompanionGovernanceSettings";
      function Harness() {
        const [section,setSection]=useState(new URLSearchParams(location.search).get("surface") || "team");
        const [visited,setVisited]=useState(new Set([section]));
        function activate(id){setVisited(current=>new Set(current).add(id));setSection(id);}
        return <div className="harness"><header className="harness-header"><strong>设置</strong>
          <button aria-current={section==="team"?"page":undefined} onClick={()=>activate("team")}>团队与成员</button>
          <button aria-current={section==="quality"?"page":undefined} onClick={()=>activate("quality")}>陪伴质量治理</button>
          <small>隔离测试数据</small></header><main className="settings-dialog-main">
          {visited.has("team") && <div className="settings-section-host" hidden={section!=="team"}><TenantSettings onOpenQuality={()=>activate("quality")}/></div>}
          {visited.has("quality") && <div className="settings-section-host" hidden={section!=="quality"}><CompanionGovernanceSettings onOpenTeam={()=>activate("team")}/></div>}
        </main></div>;
      }
      createRoot(document.getElementById("root")).render(<Harness/>);`,
    loader: "tsx", resolveDir: root,
  },
  absWorkingDir: root, bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic",
  define: { "process.env.NODE_ENV": '"development"' }, logLevel: "silent",
});
const globals = (await readFile(resolve(root, "app/globals.css"), "utf8"))
  .replace(/^@import[^;]+;\s*/gm, "").replace(/@theme\s*\{[\s\S]*?\}/, "");
const css = [globals, await readFile(resolve(root, "app/settings.css"), "utf8"), await readFile(resolve(root, "app/companion-admin.css"), "utf8"), `
  *,*::before,*::after{box-sizing:border-box}html,body,#root{height:100%;margin:0}body{font-family:var(--font-sans);background:var(--bg);color:var(--text)}
  button,input,textarea,select{font:inherit}button{cursor:pointer}h1,h2,h3,p{margin:0}button:disabled{cursor:default}fieldset{border:0;padding:0;margin:0}legend{padding:0}
  [hidden]{display:none!important}.harness{display:flex;flex-direction:column;height:100dvh}.harness-header{height:52px;flex-shrink:0;display:flex;align-items:center;gap:24px;padding:0 24px;border-bottom:1px solid var(--border);background:var(--bg)}
  .harness-header strong{font-size:15px}.harness-header button{border:0;align-self:stretch;background:transparent;color:var(--text-muted);font-size:13px;border-bottom:2px solid transparent}
  .harness-header button[aria-current=page]{border-bottom-color:var(--accent);color:var(--text);font-weight:600}.harness-header small{margin-left:auto;color:var(--text-muted);font-size:11px}
  @media(max-width:600px){.harness-header{gap:12px;padding:0 16px}.harness-header small{display:none}}
`].join("\n");
const html = '<!doctype html><html lang="zh-CN" data-theme="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>';
const server = createServer((req, res) => {
  if (req.url?.startsWith("/api/")) { res.writeHead(500); res.end("Unexpected unmocked API call"); return; }
  if (req.url === "/app.js") { res.setHeader("Content-Type", "text/javascript; charset=utf-8"); res.end(bundle.outputFiles[0].contents); }
  else if (req.url === "/style.css") { res.setHeader("Content-Type", "text/css; charset=utf-8"); res.end(css); }
  else { res.setHeader("Content-Type", "text/html; charset=utf-8"); res.end(html); }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;
const ratio = { numerator: 0, denominator: 0, percentage: null };
const emptyGovernance = () => ({
  members: [], configs: [], samples: [], evaluations: [], proposals: [], migrations: [], trialParticipants: [], calibrations: [], calibrationCount: 0, audit: [],
  trial: { participantCount: 0, trialDays: 0, baselineViolations: 0, fullEvaluationReady: false, expansionAllowed: false,
    specificResponsive: ratio, interrogationFailures: ratio, ignoredEndingFailures: ratio, memoryErrors: ratio,
    ordinaryFirstVisibleMs: { p50: null, p90: null }, ordinaryCompletionMs: { p90: null }, bufferedCompletionMs: { p90: null }, willingnessToContinue: { ...ratio, missing: 0 } },
});
const tenant = {
  tenant: { id: "tenant-fixture", name: "陪伴体验组", slug: "companion-test", planCode: "team", seatLimit: null },
  currentMembership: { id: "owner", role: "owner" }, canManage: true,
  organizations: [{ membershipId: "owner", tenantId: "tenant-fixture", tenantName: "陪伴体验组", tenantSlug: "companion-test", role: "owner", status: "active" }, { membershipId: "other-owner", tenantId: "other-tenant", tenantName: "member", tenantSlug: "member", role: "owner", status: "active" }],
  invitations: [], members: [
    { membershipId: "owner", displayName: "测试管理员", email: "owner@example.test", role: "owner", status: "active", joinedAt: "2026-09-01T00:00:00Z" },
    { membershipId: "member-1", displayName: "体验成员", email: "member@example.test", role: "member", status: "active", joinedAt: "2026-09-02T00:00:00Z" },
  ],
};
let governance = emptyGovernance();
let failingQuality = false;
let failingTeam = false;
const requests = [];
const errors = [];
const checks = [];
let browser;
try {
  browser = await chromium.launch({ headless: true, ...(process.argv.includes("--edge") ? { channel: "msedge" } : {}) });
  const context = await browser.newContext({ viewport: { width: 1280, height: 960 }, locale: "zh-CN" });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  page.setDefaultTimeout(10000);
  await page.route("**/api/**", async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    const body = req.method() === "GET" ? null : req.postDataJSON();
    requests.push({ path, method: req.method(), body });
    const respond = (json, status = 200) => route.fulfill({ status, json });
    if (path === "/api/tenant/skills") return tenant.canManage
      ? respond({ error: "模拟技能加载失败" }, 500)
      : respond({ skills: [{ id: "personal-skill", name: "写作助手", description: "个人 Skill", status: "draft", version: 1 }] });
    if (path === "/api/tenant") {
      if (failingTeam && req.method() === "GET") return respond({ error: "模拟成员加载失败" }, 503);
      if (req.method() === "GET") return respond(tenant);
      if (req.method() === "POST") { tenant.invitations.push({ id: "invitation-1", email: body.email, role: body.role, expiresAt: "2026-09-29T12:00:00Z" }); return respond({ token: "isolated-fixture-token" }); }
      if (req.method() === "PATCH") { Object.assign(tenant.members.find((item) => item.membershipId === body.membershipId), { role: body.role }); return respond({ ok: true }); }
      if (req.method() === "DELETE") { tenant.invitations = []; return respond({ ok: true }); }
    }
    if (path === "/api/tenant/companion") {
      if (req.method() === "GET") return respond(failingQuality ? { error: "模拟治理加载失败" } : governance, failingQuality ? 503 : 200);
      if (body.action === "draft") {
        const config = { ...body, id: `config-${governance.configs.length + 1}`, version: governance.configs.length + 1, status: "draft" };
        governance.configs.unshift(config); return respond({ config }, 201);
      }
      if (body.action === "evaluation") {
        const run = { id: "evaluation-1", status: "completed", configVersionId: body.configVersionId, graderVersion: "fixture-grader", suite: body.suite, averageScore: 91, fatalCount: 0, results: [{ id: "sample-1", finalTotal: 91, evidence: ["先承接当下感受，没有连续盘问。"] }], suggestions: [] };
        governance.evaluations.unshift(run); return respond({ run });
      }
      if (body.action === "publish") { const config = governance.configs.find((item) => item.id === body.configVersionId); config.status = "published"; return respond({ config }); }
      if (body.action === "preview_migration") return respond({ preview: { diff: "- 原回复节奏\n+ 更自然地承接感受，尊重结束意愿" } });
      if (body.action === "preview_batch_migration") return respond({ previews: [{ diff: "- 旧版本\n+ 已发布的新版本", affectedMembershipIds: body.membershipIds }] });
      if (body.action === "migrate" || body.action === "batch_migrate") return respond({ ok: true });
      if (body.action === "enroll_trial") { governance.trialParticipants.push({ membershipId: body.membershipId, stage: "scripted" }); governance.trial.participantCount = 1; return respond({ trial: governance.trial }); }
      if (body.action === "update_trial") { Object.assign(governance.trialParticipants.find((item) => item.membershipId === body.membershipId), body); return respond({ trial: governance.trial }); }
      if (body.action === "calibration") { governance.calibrations.push(body); governance.calibrationCount++; return respond({ calibration: body }); }
      if (body.action === "review") { governance.samples = []; return respond({ review: { id: "review-fixture" } }); }
      if (body.action === "propose") { governance.proposals.push({ id: "proposal-fixture", status: "advisory", diff: "+ 候选行为文档", proposedBehaviorDocument: body.proposedBehaviorDocument }); return respond({ ok: true }); }
      if (body.action === "accept_proposal") { governance.proposals[0].status = "accepted"; return respond({ ok: true }); }
    }
    errors.push(`Unhandled fixture API: ${req.method()} ${path} ${body?.action ?? ""}`);
    return respond({ error: "Unmocked fixture action" }, 500);
  });
  const surface = () => page.locator('.settings-section-host:not([hidden]) .admin-settings');
  const screenshot = async (name) => {
    await surface().evaluate((el) => { el.scrollTop = 0; });
    await page.screenshot({ path: resolve(output, name), animations: "disabled" });
  };
  const noOverflow = async () => {
    const values = await surface().evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth, page: document.documentElement.scrollWidth, viewport: innerWidth }));
    assert.ok(values.scroll <= values.client + 1 && values.page <= values.viewport + 1, JSON.stringify(values));
  };
  const workspace = async (name) => page.getByRole("navigation", { name: "治理工作区" }).getByRole("button", { name, exact: true }).click();
  const qualityButton = () => page.locator(".harness-header").getByRole("button", { name: "陪伴质量治理", exact: true });
  const teamButton = () => page.locator(".harness-header").getByRole("button", { name: "团队与成员", exact: true });

  await page.goto(origin);
  await page.getByRole("table", { name: "租户成员" }).waitFor();
  const table = await page.getByRole("table", { name: "租户成员" }).boundingBox();
  assert.ok(table.y + table.height < 960, "Member list must fit the desktop first screen");
  assert.ok(!requests.some((item) => item.path === "/api/tenant/companion" || item.path === "/api/tenant/skills"));
  await noOverflow(); await screenshot("team-desktop.png");
  checks.push("Desktop first-screen invitation and member list; team does not fetch governance or skills");

  await page.getByRole("button", { name: "＋ 邀请陪伴成员", exact: true }).click();
  assert.equal(await page.getByLabel("邀请角色", { exact: true }).inputValue(), "member");
  await page.getByLabel("受邀邮箱", { exact: true }).fill("tester@example.test");
  await page.getByRole("button", { name: "生成邀请链接", exact: true }).click();
  await page.getByLabel("邀请链接", { exact: true }).waitFor();
  assert.match(await page.getByLabel("邀请链接", { exact: true }).inputValue(), /invite=isolated-fixture-token$/);
  assert.equal(requests.find((item) => item.path === "/api/tenant" && item.method === "POST").body.role, "member");
  await page.evaluate(() => Object.defineProperty(navigator, "clipboard", { value: { writeText: async () => { throw new Error("permission denied"); } }, configurable: true }));
  await page.getByRole("button", { name: "复制邀请链接", exact: true }).click();
  await page.getByText("浏览器未允许自动复制。链接已选中，请按 Ctrl+C 或使用系统复制菜单。").waitFor();
  checks.push("Invitation defaults to Member, returned link is real fixture token, clipboard failure has manual recovery");
  await screenshot("team-invitation.png");
  await page.getByRole("button", { name: "收起", exact: true }).click();
  await page.getByLabel("搜索成员", { exact: true }).fill("does-not-exist");
  await page.getByText("没有匹配的成员", { exact: true }).waitFor();
  await page.getByLabel("搜索成员", { exact: true }).fill("");
  await page.getByText("成员技能 · 高级设置", { exact: true }).click();
  await page.getByText("模拟技能加载失败", { exact: true }).waitFor();
  assert.ok(await page.getByRole("table", { name: "租户成员" }).isVisible());
  checks.push("Search empty state and isolated skill-loading failure leave member management available");

  await qualityButton().click();
  await page.getByRole("heading", { name: "陪伴行为文档", exact: true }).waitFor();
  await noOverflow(); await screenshot("quality-empty-desktop.png");
  await page.getByLabel("凡小忆行为文档", { exact: true }).fill("# 陪伴表达\n先承接具体感受。尊重结束意愿，不连续盘问。");
  await page.getByRole("button", { name: "刷新数据", exact: true }).click();
  await page.getByText("数据已刷新，编辑中的行为文档已保留。").waitFor();
  assert.match(await page.getByLabel("凡小忆行为文档", { exact: true }).inputValue(), /尊重结束意愿/);
  await workspace("人工复核");
  await page.getByText("暂无待复核片段", { exact: true }).waitFor();
  await workspace("内部试用");
  await page.getByText("暂无内部试用数据", { exact: true }).waitFor();
  assert.ok(!(await surface().innerText()).includes("0/0"));
  await workspace("配置与发布");
  assert.match(await page.getByLabel("凡小忆行为文档", { exact: true }).inputValue(), /尊重结束意愿/);
  checks.push("Empty-state guidance, four workspaces and draft preserved across refresh and navigation");

  await page.getByRole("button", { name: "保存为新草稿", exact: true }).click();
  const publish = page.getByRole("button", { name: "确认发布 v1", exact: true });
  await publish.waitFor(); assert.ok(await publish.isDisabled());
  await page.getByRole("button", { name: "运行快速评测", exact: true }).click();
  await page.getByText(/v1 评测完成：91\.0 分/).waitFor();
  assert.ok(await publish.isEnabled());
  page.once("dialog", (dialog) => dialog.dismiss()); await publish.click();
  assert.equal(requests.filter((item) => item.body?.action === "publish").length, 0);
  await screenshot("quality-ready-desktop.png");
  page.once("dialog", (dialog) => dialog.accept()); await publish.click();
  await page.getByText("最新发布 v1", { exact: true }).waitFor();
  assert.equal(requests.filter((item) => item.body?.action === "publish").length, 1);
  checks.push("Draft publication blocked before qualifying evaluation; cancel does not publish; explicit acceptance publishes once");

  governance.members = [{ membershipId: "member-1", displayName: "体验成员" }];
  await page.getByRole("button", { name: "刷新数据", exact: true }).click();
  await page.getByText("数据已刷新，编辑中的行为文档已保留。").waitFor();
  await workspace("迁移与审计");
  await page.getByLabel("迁移参与者", { exact: true }).selectOption("member-1");
  await page.getByRole("button", { name: "预览并迁移", exact: true }).click();
  await page.getByRole("heading", { name: "确认迁移差异", exact: true }).waitFor();
  assert.equal(requests.filter((item) => item.body?.action === "migrate").length, 0);
  await page.getByRole("button", { name: "取消，不作修改", exact: true }).click();
  assert.equal(requests.filter((item) => item.body?.action === "migrate").length, 0);
  await page.getByRole("button", { name: "预览并迁移", exact: true }).click();
  await page.getByRole("heading", { name: "确认迁移差异", exact: true }).waitFor();
  await screenshot("quality-migration-preview.png");
  await page.getByRole("button", { name: "确认迁移", exact: true }).click();
  await page.getByText("迁移已完成，原版本已记录为回滚目标。").waitFor();
  assert.equal(requests.filter((item) => item.body?.action === "migrate").length, 1);
  checks.push("Migration preview is read-only; cancellation leaves state unchanged; confirmation sends exactly one write");

  await workspace("内部试用");
  await page.getByLabel("试用参与者", { exact: true }).selectOption("member-1");
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "纳入脚本任务试用", exact: true }).click();
  await page.getByText("已纳入脚本任务试用。", { exact: true }).waitFor();
  await page.getByRole("button", { name: "进入自由聊天", exact: true }).click();
  await page.getByRole("button", { name: "完成：愿意继续", exact: true }).waitFor();
  checks.push("Trial enrollment has an independent selector and preserves explicit stages");
  await screenshot("quality-trial-desktop.png");

  await page.setViewportSize({ width: 390, height: 844 });
  await teamButton().click(); await screenshot("team-mobile.png"); await noOverflow();
  await page.getByText("租户管理 · 切换或新建租户", { exact: true }).click();
  await page.getByRole("button", { name: "新建租户并切换", exact: true }).scrollIntoViewIfNeeded();
  assert.ok(await page.getByRole("button", { name: "新建租户并切换", exact: true }).isVisible());
  await qualityButton().click();
  for (const name of ["配置与发布", "人工复核", "内部试用", "迁移与审计"]) { await workspace(name); await noOverflow(); }
  await workspace("配置与发布"); await screenshot("quality-mobile.png");
  checks.push("390px layout has no page overflow; all workspaces and lower advanced controls remain reachable");
  await page.setViewportSize({ width: 1280, height: 960 });
  await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
  await screenshot("quality-dark.png");

  failingQuality = true;
  await page.goto(`${origin}/?surface=quality`);
  await page.getByText("模拟治理加载失败", { exact: true }).waitFor();
  assert.equal(await page.getByText("暂无内部试用数据", { exact: true }).count(), 0);
  failingQuality = false;
  await page.getByRole("button", { name: "重新加载治理数据", exact: true }).click();
  await page.getByRole("heading", { name: "陪伴行为文档", exact: true }).waitFor();
  failingTeam = true;
  await page.goto(origin);
  await page.getByText("模拟成员加载失败", { exact: true }).waitFor();
  failingTeam = false;
  await page.getByRole("button", { name: "重新加载成员", exact: true }).click();
  await page.getByRole("table", { name: "租户成员" }).waitFor();
  checks.push("Failed API loads render errors, not false empty dashboards, and retry recovers");

  tenant.currentMembership = { id: "member-1", role: "member" };
  tenant.canManage = false;
  await page.goto(origin);
  await page.getByRole("heading", { name: "我的 Skills", exact: true }).waitFor();
  await page.getByText("写作助手 · v1", { exact: true }).waitFor();
  assert.ok(requests.some((item) => item.path === "/api/tenant/skills" && item.method === "GET"));
  await noOverflow(); await screenshot("member-skills-desktop.png");
  await page.setViewportSize({ width: 390, height: 844 });
  await noOverflow(); await screenshot("member-skills-mobile.png");
  checks.push("Member account and personal Skills load automatically; desktop and mobile layouts have no overflow");

  assert.deepEqual(errors, []);
  checks.push("No browser runtime errors or unmocked API calls");
  await writeFile(resolve(output, "report.json"), JSON.stringify({ passed: checks, apiCalls: requests.length, browserErrors: errors, note: "Actual React components, isolated in-memory API fixtures; no live server or data modifications." }, null, 2));
  console.log(JSON.stringify({ outcome: "passed", checks, output }, null, 2));
  await context.close();
} catch (error) {
  console.error(error);
  const failedPage = browser?.contexts()[0]?.pages()[0];
  if (failedPage) await failedPage.screenshot({ path: resolve(output, "failure.png") }).catch(() => undefined);
  await writeFile(resolve(output, "failure.json"), JSON.stringify({ message: String(error), errors, checks }, null, 2));
  process.exitCode = 1;
} finally {
  await browser?.close();
  await new Promise((done) => server.close(done));
}
