"use client";

// PROTOTYPE — Three tenant-aware Pi Web shells, switchable with ?variant= and ?screen=.
import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import "./prototype.css";

type Variant = "a" | "b" | "c";
type Screen = "chat" | "settings" | "identity";

const variants: { id: Variant; name: string }[] = [
  { id: "a", name: "专注工作台" },
  { id: "b", name: "双轨控制台" },
  { id: "c", name: "企业工作区" },
];

const screens: { id: Screen; name: string }[] = [
  { id: "chat", name: "对话" },
  { id: "settings", name: "设置" },
  { id: "identity", name: "身份" },
];

function Avatar({ compact = false }: { compact?: boolean }) {
  return <span className={`proto-avatar ${compact ? "is-compact" : ""}`}>林</span>;
}

function Composer() {
  return (
    <div className="proto-composer">
      <div className="proto-compose-input">给 Pi 一个任务，或输入 / 使用命令</div>
      <div className="proto-compose-meta">
        <span>＋ 文件</span><span>GPT-5.6 Sol</span><span>high</span><span>full</span>
        <button>发送 ↗</button>
      </div>
    </div>
  );
}

function Conversation({ inspectorOpen = false, onToggleInspector }: { inspectorOpen?: boolean; onToggleInspector?: () => void }) {
  return (
    <div className="proto-conversation">
      <header className="proto-chat-heading">
        <div><span className="proto-eyebrow">当前任务</span><h1>整理季度研究报告</h1></div>
        <div className="proto-chat-actions"><button className="proto-quiet-button">···</button>{onToggleInspector && <button className="proto-panel-toggle" aria-expanded={inspectorOpen} onClick={onToggleInspector}>{inspectorOpen ? "收起侧栏" : "查看文件 / 终端　▸"}</button>}</div>
      </header>
      <div className="proto-thread">
        <div className="proto-message is-user">
          <span className="proto-message-label">你</span>
          <p>读取项目中的访谈资料，整理成一份结构清晰的季度研究报告。</p>
        </div>
        <div className="proto-message is-agent">
          <span className="proto-message-label">PI</span>
          <p>我会先检查资料结构，再生成报告提纲和最终文档。</p>
          <div className="proto-work-block">
            <div><strong>处理详情</strong><span>4 条消息 · 3 次工具调用</span></div>
            <div className="proto-tool-row"><span>01</span><code>读取 research/interviews</code><b>完成</b></div>
            <div className="proto-tool-row"><span>02</span><code>归纳主题与引用</code><b>完成</b></div>
            <div className="proto-tool-row"><span>03</span><code>生成 report-q3.md</code><b>完成</b></div>
          </div>
          <p>报告已完成，包含关键发现、原始证据和下一步建议。</p>
          <div className="proto-artifact"><span>MD</span><div><strong>report-q3.md</strong><small>18.4 KB · 刚刚生成</small></div><button>打开</button></div>
        </div>
      </div>
      <Composer />
    </div>
  );
}

function WorkspaceFiles({ onOpenFile, onOpenTerminal }: { onOpenFile: (name: string) => void; onOpenTerminal: () => void }) {
  return (
    <div className="proto-files">
      <header><strong>文件资源</strong><span>研究产品</span><button onClick={onOpenTerminal}>终端　›</button></header>
      <div className="proto-file-tree">
        <button><span>⌄　app</span></button>
        <button onClick={() => onOpenFile("app/page.tsx")}><span>　　page.tsx</span><b>M</b></button>
        <button><span>›　components</span></button>
        <button><span>⌄　reports</span></button>
        <button className="is-current" onClick={() => onOpenFile("reports/report-q3.md")}><span>　　report-q3.md</span><b>A</b></button>
        <button onClick={() => onOpenFile("package.json")}><span>package.json</span></button>
        <button onClick={() => onOpenFile("README.md")}><span>README.md</span><b>M</b></button>
      </div>
      <footer><span>6 个文件</span><span>+2　−1</span></footer>
    </div>
  );
}

function InspectorPanel({ tab, fileName, onTab, onClose }: { tab: "file" | "terminal"; fileName: string; onTab: (tab: "file" | "terminal") => void; onClose: () => void }) {
  return (
    <section className="proto-inspector">
      <header><button className={tab === "file" ? "is-active" : ""} onClick={() => onTab("file")}>文件　{fileName.split("/").at(-1)}</button><button className={tab === "terminal" ? "is-active" : ""} onClick={() => onTab("terminal")}>终端　1</button><button className="proto-inspector-close" onClick={onClose}>×</button></header>
      {tab === "file" ? (
        <div className="proto-code-view">
          <div className="proto-file-path">{fileName}<span>UTF-8　Markdown</span></div>
          <pre><code><i>01</i><b># 第三季度研究报告</b>{"\n"}<i>02</i>{"\n"}<i>03</i><b>## 执行摘要</b>{"\n"}<i>04</i>本季度的用户研究覆盖 18 位团队成员，{`\n`}<i>05</i>核心需求集中在工作流连续性与企业数据隔离。{"\n"}<i>06</i>{"\n"}<i>07</i><b>## 关键发现</b>{"\n"}<i>08</i>1. 对话仍然是主要工作入口。{"\n"}<i>09</i>2. 文件与终端需要保持随手可达。{"\n"}<i>10</i>3. 企业上下文不应干扰任务执行。{"\n"}<i>11</i>{"\n"}<i>12</i><b>## 下一步</b>{"\n"}<i>13</i>- 验证多租户权限模型{"\n"}<i>14</i>- 补齐运行时隔离测试</code></pre>
        </div>
      ) : (
        <div className="proto-terminal-view"><div className="proto-terminal-meta"><span>PowerShell</span><span>研究产品</span></div><pre><span>PS D:\code\research-product&gt;</span> npm run dev{"\n\n"}&gt; pi-web@0.9.1 dev{"\n"}&gt; next dev -p 30141{"\n\n"}▲ Next.js 16.3.1{"\n"}- Local: http://127.0.0.1:30141{"\n\n"}✓ Ready in 642ms{"\n"}✓ Compiled /api/agent/[id] in 118ms{"\n"}<span>PS D:\code\research-product&gt;</span> <b>_</b></pre></div>
      )}
    </section>
  );
}

function SessionList({ dense = false }: { dense?: boolean }) {
  return (
    <div className={`proto-session-list ${dense ? "is-dense" : ""}`}>
      <div className="proto-sidebar-title"><strong>对话</strong><button>＋ 新建</button></div>
      <label className="proto-search">⌕　搜索对话</label>
      <span className="proto-section-label">今天</span>
      <button className="proto-session is-current"><strong>整理季度研究报告</strong><small>12 分钟前 · 32 条消息</small></button>
      <button className="proto-session"><strong>产品发布检查</strong><small>2 小时前 · 已完成</small></button>
      <span className="proto-section-label">昨天</span>
      <button className="proto-session"><strong>重构身份验证模块</strong><small>昨天 · 18 条消息</small></button>
      <button className="proto-session"><strong>分析客户反馈</strong><small>昨天 · 9 条消息</small></button>
    </div>
  );
}

function AccountDock() {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="proto-account-wrap">
      {expanded && (
        <div className="proto-account-menu">
          <div><strong>林默</strong><small>lin@northstar.ai</small></div>
          <span className="proto-menu-label">当前企业</span>
          <button className="is-selected"><span>✓　北辰智能</span><small>Owner</small></button>
          <button><span>　　远山实验室</span><small>Member</small></button>
          <hr />
          <button><span>设置</span><span>›</span></button>
          <button><span>团队管理</span><span>›</span></button>
          <hr />
          <button><span>退出登录</span></button>
        </div>
      )}
      <button className="proto-account-button" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}><Avatar /><span><strong>林默</strong><small>北辰智能</small></span><b>{expanded ? "⌄" : "⌃"}</b></button>
    </div>
  );
}

function SettingsContent({ vertical = false, table = false }: { vertical?: boolean; table?: boolean }) {
  const nav = ["常规", "团队", "模型", "技能", "子代理", "插件"];
  return (
    <div className={`proto-settings ${vertical ? "is-vertical" : ""} ${table ? "is-table" : ""}`}>
      <header className="proto-settings-heading"><div><span className="proto-eyebrow">北辰智能</span><h1>设置</h1></div><button>关闭 ×</button></header>
      <nav className="proto-settings-nav">{nav.map((item) => <button className={item === "技能" ? "is-active" : ""} key={item}>{item}</button>)}</nav>
      <aside className="proto-settings-list">
        <span className="proto-section-label">当前项目</span>
        <button>报告生成器</button>
        <span className="proto-section-label">北辰智能</span>
        <button className="is-current">研究报告助手</button>
        <button>代码审查</button>
        <button>数据分析</button>
        <span className="proto-section-label">我的技能</span>
        <button>写作风格</button>
        <span className="proto-section-label">系统内置</span>
        <button>网页浏览</button>
        <button>文件处理</button>
        <button className="proto-add-skill">＋ 添加技能</button>
      </aside>
      <main className="proto-settings-detail">
        <div className="proto-scope-row"><span>企业技能</span><code>北辰智能 / research-report</code><label><input type="checkbox" defaultChecked /> 已启用</label></div>
        <div className="proto-setting-copy"><span className="proto-eyebrow">名称</span><h2>研究报告助手</h2><p>从访谈、数据和项目文件中提炼证据，生成结构化研究报告。</p></div>
        <div className="proto-setting-grid">
          <div><span>可用范围</span><strong>所有成员</strong><small>团队成员均可在对话中调用</small></div>
          <div><span>维护者</span><strong>林默</strong><small>上次更新于 3 天前</small></div>
          <div><span>默认模型</span><strong>跟随企业设置</strong><small>GPT-5.6 Sol</small></div>
          <div><span>工具权限</span><strong>读取文件、生成文档</strong><small>不允许访问外部网络</small></div>
        </div>
        <div className="proto-setting-actions"><button>检查更新</button><button className="is-primary">保存更改</button></div>
      </main>
    </div>
  );
}

function IdentityPanel({ mode }: { mode: Variant }) {
  return (
    <div className={`proto-identity mode-${mode}`}>
      <section className="proto-identity-context">
        <span className="proto-wordmark">PI WEB</span>
        <div><span className="proto-eyebrow">企业 AI 工作台</span><h1>{mode === "b" ? "选择你的工作空间" : "把工作留在正确的组织中"}</h1><p>账号、对话、文件与企业资源保持清晰归属。登录后只会看到你有权访问的内容。</p></div>
        <ol><li><span>01</span>成员身份独立</li><li><span>02</span>企业数据隔离</li><li><span>03</span>权限由服务端执行</li></ol>
      </section>
      <section className="proto-login-panel">
        <div className="proto-login-box">
          <span className="proto-eyebrow">安全登录</span><h2>{mode === "c" ? "接受北辰智能的邀请" : "登录 Pi Web"}</h2>
          <p>{mode === "c" ? "lin@northstar.ai 邀请你加入企业工作空间。" : "使用你的工作邮箱继续。"}</p>
          <label>工作邮箱<input defaultValue="lin@northstar.ai" /></label>
          <label>密码<input type="password" defaultValue="12345678" /></label>
          <button className="proto-login-submit">{mode === "c" ? "登录并加入企业" : "继续"}</button>
          <div className="proto-login-foot"><span>忘记密码</span><span>隐私与安全</span></div>
        </div>
      </section>
    </div>
  );
}

function VariantA({ screen }: { screen: Screen }) {
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [inspectorTab, setInspectorTab] = useState<"file" | "terminal">("file");
  const [fileName, setFileName] = useState("reports/report-q3.md");
  const openFile = (name: string) => { setFileName(name); setInspectorTab("file"); setInspectorOpen(true); };
  const openTerminal = () => { setInspectorTab("terminal"); setInspectorOpen(true); };
  if (screen === "identity") return <IdentityPanel mode="a" />;
  return <div className={`proto-shell variant-a ${inspectorOpen && screen === "chat" ? "has-inspector" : ""}`}><aside><div className="proto-brand">Pi Web</div><div className="proto-project">北辰智能 / 研究产品</div>{screen === "chat" && <><SessionList /><WorkspaceFiles onOpenFile={openFile} onOpenTerminal={openTerminal} /></>}<AccountDock /></aside><main>{screen === "chat" ? <Conversation inspectorOpen={inspectorOpen} onToggleInspector={() => setInspectorOpen((value) => !value)} /> : <SettingsContent />}</main>{inspectorOpen && screen === "chat" && <InspectorPanel tab={inspectorTab} fileName={fileName} onTab={setInspectorTab} onClose={() => setInspectorOpen(false)} />}</div>;
}

function VariantB({ screen }: { screen: Screen }) {
  if (screen === "identity") return <IdentityPanel mode="b" />;
  return <div className="proto-shell variant-b"><nav className="proto-rail"><div className="proto-mark">π</div><button className="is-active">对</button><button>文</button><button>任</button><span className="proto-rail-spacer" /></nav><aside><div className="proto-brand">Pi Web</div><div className="proto-project">北辰智能⌄</div>{screen === "chat" && <SessionList dense />}<AccountDock /></aside><main>{screen === "chat" ? <Conversation /> : <SettingsContent vertical />}</main></div>;
}

function VariantC({ screen }: { screen: Screen }) {
  if (screen === "identity") return <IdentityPanel mode="c" />;
  return <div className="proto-shell variant-c"><header className="proto-global-head"><div className="proto-brand">PI WEB</div><strong>北辰智能　/　研究产品</strong><nav><button>对话</button><button>成果</button><button>成员</button></nav><Avatar compact /></header><aside>{screen === "chat" && <SessionList dense />}<AccountDock /></aside><main>{screen === "chat" ? <Conversation /> : <SettingsContent table />}</main></div>;
}

function PrototypeSwitcher({ variant, screen }: { variant: Variant; screen: Screen }) {
  const router = useRouter();
  const setParams = (nextVariant: Variant, nextScreen: Screen) => router.replace(`/prototype/tenant-shell?variant=${nextVariant}&screen=${nextScreen}`);
  const cycle = (delta: number) => {
    const index = variants.findIndex((item) => item.id === variant);
    setParams(variants[(index + delta + variants.length) % variants.length].id, screen);
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (["INPUT", "TEXTAREA"].includes(target.tagName) || target.isContentEditable) return;
      if (event.key === "ArrowLeft") cycle(-1);
      if (event.key === "ArrowRight") cycle(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  if (process.env.NODE_ENV === "production") return null;
  return (
    <div className="proto-switcher">
      <div className="proto-screen-switch">{screens.map((item) => <button className={screen === item.id ? "is-active" : ""} key={item.id} onClick={() => setParams(variant, item.id)}>{item.name}</button>)}</div>
      <div className="proto-variant-switch"><button aria-label="上一个方案" onClick={() => cycle(-1)}>←</button><span><b>{variant.toUpperCase()}</b> {variants.find((item) => item.id === variant)?.name}</span><button aria-label="下一个方案" onClick={() => cycle(1)}>→</button></div>
    </div>
  );
}

function TenantShellPrototype() {
  const params = useSearchParams();
  const variant = (["a", "b", "c"].includes(params.get("variant") ?? "") ? params.get("variant") : "a") as Variant;
  const screen = (["chat", "settings", "identity"].includes(params.get("screen") ?? "") ? params.get("screen") : "chat") as Screen;
  return <div className="proto-root">{variant === "a" ? <VariantA screen={screen} /> : variant === "b" ? <VariantB screen={screen} /> : <VariantC screen={screen} />}<PrototypeSwitcher variant={variant} screen={screen} /></div>;
}

export default function TenantShellPage() {
  return (
    <Suspense fallback={<div className="proto-root" />}>
      <TenantShellPrototype />
    </Suspense>
  );
}
