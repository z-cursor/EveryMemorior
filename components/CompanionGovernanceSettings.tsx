"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ConfigButton } from "./SettingsUi";
import { AdminBadge, AdminCard, AdminEmpty, AdminFeedback, AdminMetric, adminDate } from "./CompanionAdminUi";
import { publicationBlocker } from "@/lib/companion-publication-ui";
import { readTenantJsonResponse } from "@/lib/tenant-overview";

type Member = { membershipId: string; displayName: string };
type Config = { id: string; version: number; status: "draft" | "published" | "archived"; behaviorDocument: string; modelId: string };
type Sample = { id: string; configVersionId: string; messages: Array<{ role: string; text: string }> };
type Evaluation = { id: string; status: string; configVersionId: string; graderVersion: string; suite: "quick" | "full"; evaluationMode?: "single_turn" | "rolling_episode"; averageScore: number; fatalCount: number; results: Array<{ id: string; finalTotal: number; evidence?: string[] }>; suggestions: unknown[] };
type Proposal = { id: string; status: "advisory" | "accepted" | "rejected"; diff: string; proposedBehaviorDocument: string };
type Migration = { id: string; membershipId: string; fromConfigVersionId: string; toConfigVersionId: string; rollbackConfigVersionId: string; reason: string; createdAt: string };
type TrialParticipant = { membershipId: string; stage: "scripted" | "free_chat" | "completed" };
type Trial = {
  participantCount: number; trialDays: number; baselineViolations: number; fullEvaluationReady: boolean; expansionAllowed: boolean;
  specificResponsive: Ratio; interrogationFailures: Ratio; ignoredEndingFailures: Ratio; memoryErrors: Ratio;
  ordinaryFirstVisibleMs: { p50: number | null; p90: number | null }; ordinaryCompletionMs: { p90: number | null }; bufferedCompletionMs: { p90: number | null };
  willingnessToContinue: Ratio & { missing: number };
};
type Ratio = { numerator: number; denominator: number; percentage: number | null };
type Calibration = { runId: string; itemId: string };
type Decision = { specificallyResponsive: boolean; interrogation: boolean; ignoredEnding: boolean; baselineViolation: boolean; notes: string };

async function request<T = Record<string, unknown>>(init?: RequestInit): Promise<T> {
  const response = await fetch("/api/tenant/companion", init);
  return readTenantJsonResponse<T>(response);
}

const json = (body: Record<string, unknown>): RequestInit => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const emptyDecision: Decision = { specificallyResponsive: false, interrogation: false, ignoredEnding: false, baselineViolation: false, notes: "" };
type GovernanceState = {
  members: Member[]; configs: Config[]; samples: Sample[]; evaluations: Evaluation[];
  proposals: Proposal[]; migrations: Migration[]; trialParticipants: TrialParticipant[];
  trial: Trial | null; calibrations: Calibration[]; calibrationCount: number;
  audit: Array<{ id: string; action: string; targetType: string; targetId: string | null; createdAt: string }>;
};
type Workspace = "configuration" | "review" | "trial" | "migration";
type MigrationPreview = { memberIds: string[]; configVersionId: string; reason: string; diff: string; batch: boolean };
const workspaceLabels: Record<Workspace, string> = { configuration: "配置与发布", review: "人工复核", trial: "内部试用", migration: "迁移与审计" };
const configLabels = { draft: "草稿", published: "已发布", archived: "已归档" };
const trialLabels = { scripted: "脚本任务", free_chat: "自由聊天", completed: "已完成" };
const ratioText = (value: Ratio) => value.denominator > 0 ? `${value.numerator}/${value.denominator}${value.percentage == null ? "" : `（${value.percentage}%）`}` : "暂无样本";
const latencyText = (value: number | null) => value == null ? "暂无数据" : `${value} ms`;

export function CompanionGovernanceSettings({ onOpenTeam }: { onOpenTeam?: () => void }) {
  const [state, setState] = useState<GovernanceState | null>(null);
  const [workspace, setWorkspace] = useState<Workspace>("configuration");
  const [draft, setDraft] = useState("");
  const [savedDraft, setSavedDraft] = useState("");
  const [memberId, setMemberId] = useState("");
  const [trialMemberId, setTrialMemberId] = useState("");
  const [configId, setConfigId] = useState("");
  const [batchIds, setBatchIds] = useState<string[]>([]);
  const [preview, setPreview] = useState<MigrationPreview | null>(null);
  const [decisions, setDecisions] = useState<Record<string, Decision>>({});
  const [evidence, setEvidence] = useState<{ sourceType: "review" | "evaluation"; sourceId: string; baseConfigVersionId: string; quote: string } | null>(null);
  const [humanScore, setHumanScore] = useState("50");
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const initialized = useRef(false);
  const operationRef = useRef(false);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const busy = pending !== null;
  const dirty = draft !== savedDraft;

  const load = useCallback(async () => {
    const value = await request<GovernanceState>({ cache: "no-store" });
    setState(value);
    if (!initialized.current) {
      const initial = value.configs.find((item) => item.status === "draft")?.behaviorDocument
        ?? value.configs.find((item) => item.status === "published")?.behaviorDocument ?? "";
      setDraft(initial);
      setSavedDraft(initial);
      initialized.current = true;
    }
    setConfigId((current) => value.configs.some((item) => item.id === current && item.status === "published")
      ? current : value.configs.find((item) => item.status === "published")?.id ?? "");
  }, []);

  useEffect(() => { void load().catch((cause) => setError(cause instanceof Error ? cause.message : String(cause))); }, [load]);

  const run = async (label: string, operation: () => Promise<void>) => {
    if (operationRef.current) return;
    operationRef.current = true;
    setPending(label); setError(""); setNotice("");
    try { await operation(); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { operationRef.current = false; setPending(null); }
  };

  const navigate = (next: Workspace) => {
    setWorkspace(next);
    scrollRef.current?.scrollTo({ top: 0 });
  };

  const saveDraft = () => run("正在保存为新草稿…", async () => {
    const result = await request<{ config: Config }>(json({ action: "draft", behaviorDocument: draft, modelProvider: "qwen", modelId: "FY-Qwen3.8-27B-NVFP4", thinkingLevel: "off", temperature: 0.2, maxOutputTokens: 600 }));
    setDraft(result.config.behaviorDocument); setSavedDraft(result.config.behaviorDocument);
    await load();
    setNotice(`v${result.config.version} 草稿已保存。下一步：运行快速评测；现有陪伴关系未改变。`);
  });

  const evaluate = (config: Config, suite: "quick" | "full", bridge?: Evaluation) => {
    if (suite === "full" && !window.confirm(`为 v${config.version} 运行 500 题评测？\n这会调用模型并产生用量，耗时可能较长。它用于判断是否可以扩大内部试用。`)) return;
    void run(`正在为 v${config.version} 运行${suite === "full" ? "500 题" : "快速"}评测，请勿重复提交…`, async () => {
      const result = await request<{ run: Evaluation }>(json({ action: "evaluation", configVersionId: config.id, suite, evaluationMode: bridge?.evaluationMode ?? "single_turn", bridgeFromGraderVersion: bridge?.graderVersion }));
      setEvidence({ sourceType: "evaluation", sourceId: result.run.id, baseConfigVersionId: config.id, quote: result.run.results.flatMap((item) => item.evidence ?? [])[0] ?? "评分器建议" });
      await load();
      setNotice(`v${config.version} 评测完成：${result.run.averageScore.toFixed(1)} 分，致命问题 ${result.run.fatalCount} 项。请检查评测记录后再决定是否发布。`);
    });
  };

  const publish = (config: Config) => {
    if (!state || publicationBlocker(config.id, state.evaluations)) return;
    if (!window.confirm(`确认发布 v${config.version}？\n请先审阅此版本的评测结果。发布不会迁移已有陪伴关系；服务端将再次校验发布条件。`)) return;
    void run(`正在发布 v${config.version}…`, async () => {
      await request(json({ action: "publish", configVersionId: config.id }));
      await load(); setNotice(`v${config.version} 已发布。已有成员保持原版本，迁移必须单独预览并确认。`);
    });
  };

  const review = (sample: Sample) => run("正在记录人工复核决定…", async () => {
    const result = await request<{ review: { id: string } }>(json({ action: "review", sampleId: sample.id, ...(decisions[sample.id] ?? emptyDecision) }));
    setEvidence({ sourceType: "review", sourceId: result.review.id, baseConfigVersionId: sample.configVersionId, quote: sample.messages[0]?.text ?? "" });
    await load(); setNotice("复核决定已记录。需要改进时，可在下方基于这条证据创建候选建议。");
  });

  const prepareMigration = (memberIds: string[], targetConfig: string, reason: string, batch = false) => run("正在生成迁移预览，尚未修改陪伴关系…", async () => {
    setPreview(null);
    const result = batch
      ? await request<{ previews: Array<{ diff: string }> }>(json({ action: "preview_batch_migration", membershipIds: memberIds, configVersionId: targetConfig }))
      : await request<{ preview: { diff: string } }>(json({ action: "preview_migration", membershipId: memberIds[0], configVersionId: targetConfig }));
    const diff = "previews" in result ? result.previews.map((item) => item.diff).join("\n\n---\n\n") : result.preview.diff;
    setPreview({ memberIds, configVersionId: targetConfig, reason, diff, batch });
    setNotice("预览已生成。请阅读下方差异，只有点击「确认迁移」才会生效。");
  });

  const confirmMigration = () => {
    if (!preview) return;
    const approved = preview;
    void run("正在迁移陪伴版本…", async () => {
      await request(json({ action: approved.batch ? "batch_migrate" : "migrate", ...(approved.batch ? { membershipIds: approved.memberIds } : { membershipId: approved.memberIds[0] }), configVersionId: approved.configVersionId, reason: approved.reason }));
      setPreview(null); await load(); setNotice("迁移已完成，原版本已记录为回滚目标。");
    });
  };

  if (!state) return <div className="admin-settings"><div className="admin-content">
    <header className="admin-header"><div><h2>陪伴质量治理</h2><p>配置、评测和发布凡小忆的陪伴行为。</p></div></header>
    <AdminFeedback error={error} pending={error ? null : pending ?? "正在加载陪伴治理数据…"} />
    {error && <ConfigButton disabled={busy} onClick={() => void run("正在重新加载…", load)}>重新加载治理数据</ConfigButton>}
  </div></div>;

  const latestDraft = state.configs.find((item) => item.status === "draft");
  const published = state.configs.filter((item) => item.status === "published");
  const readyDraft = latestDraft && !publicationBlocker(latestDraft.id, state.evaluations);
  const memberName = (id: string) => state.members.find((item) => item.membershipId === id)?.displayName ?? id;
  const versionName = (id: string) => { const config = state.configs.find((item) => item.id === id); return config ? `v${config.version}` : id; };
  const teamAction = onOpenTeam ? <ConfigButton onClick={onOpenTeam}>前往团队邀请成员 →</ConfigButton> : undefined;
  const nextTitle = !state.configs.length ? "先创建第一个陪伴配置" : latestDraft ? readyDraft ? `v${latestDraft.version} 已满足发布预检，下一步是人工确认` : `下一步：为 v${latestDraft.version} 完成快速评测` : !state.members.length ? "版本已发布，接下来邀请陪伴成员" : "配置已就绪，继续检查复核与内部试用";
  const nextDescription = !state.configs.length ? "在下方写明人格、语气和回复节奏，保存为草稿后再评测。保存不会直接发布。" : latestDraft ? "评测针对已保存的版本；编辑框中的修改需另存为新草稿。已有陪伴关系不会自动切换。" : "Member 使用陪伴界面；质量复核需本人独立同意，不能由管理员代为开启。";

  const trial = state.trial;
  return (
    <div className="admin-settings" aria-label="陪伴质量治理工作区" ref={scrollRef}>
      <div className="admin-content">
        <header className="admin-header">
          <div>
            <span className="admin-eyebrow">凡小忆 · 内部试用</span>
            <div className="admin-title-row"><h2>陪伴质量治理</h2><AdminBadge tone={published.length ? "success" : "warning"}>{published.length ? `最新发布 v${published[0].version}` : "尚未发布"}</AdminBadge></div>
            <p>先验证，再发布。每次改进都有依据，已有陪伴关系不会自动改变。</p>
          </div>
          <div className="admin-header-actions">
            {onOpenTeam && <ConfigButton onClick={onOpenTeam}>团队与成员</ConfigButton>}
            <ConfigButton disabled={busy} onClick={() => void run("正在刷新治理数据…", async () => { await load(); setNotice("数据已刷新，编辑中的行为文档已保留。"); })}>刷新数据</ConfigButton>
          </div>
        </header>
        <AdminFeedback error={error} notice={notice} pending={pending} />

        <aside className="admin-guide">
          <span className="admin-guide-number" aria-hidden="true">→</span>
          <div className="admin-guide-copy"><strong>{nextTitle}</strong><p>{nextDescription}</p></div>
          {!state.configs.length ? <ConfigButton onClick={() => { navigate("configuration"); requestAnimationFrame(() => editorRef.current?.focus()); }}>开始配置</ConfigButton>
            : !latestDraft && !state.members.length ? teamAction : <ConfigButton onClick={() => navigate(latestDraft ? "configuration" : "review")}>查看下一步</ConfigButton>}
        </aside>

        <nav className="admin-subnav" aria-label="治理工作区">
          {(Object.keys(workspaceLabels) as Workspace[]).map((key) => <button type="button" key={key} aria-label={workspaceLabels[key]} aria-current={workspace === key ? "page" : undefined} onClick={() => navigate(key)}>
            {workspaceLabels[key]}{key === "review" && state.samples.length > 0 && <span className="admin-badge is-info">{state.samples.length}</span>}
          </button>)}
        </nav>

        {workspace === "configuration" && <div className="admin-stack">
          <div className="admin-split">
            <AdminCard title="陪伴行为文档" description="只编辑人格、语气、回复节奏和记忆使用方式。平台对话底线由系统锁定。" action={<AdminBadge tone={dirty ? "warning" : "neutral"}>{dirty ? "有未保存修改" : "编辑草稿"}</AdminBadge>}>
              <label className="admin-field">凡小忆行为文档
                <textarea aria-label="凡小忆行为文档" ref={editorRef} rows={9} value={draft} disabled={busy} onChange={(event) => setDraft(event.target.value)} placeholder={"例如：\n## 人格与语气\n描述凡小忆如何自然、尊重地回应。\n\n## 回复节奏\n描述如何承接感受、何时追问、何时结束。"} />
              </label>
              <p className="admin-help">新草稿沿用当前产品默认运行参数：FY-Qwen3.8-27B-NVFP4 · thinking 关闭 · temperature 0.2 · 最多 600 tokens。</p>
              <div className="admin-form-footer"><span className="admin-help">{draft.length} 字符 · 每次保存生成独立版本</span><ConfigButton variant="primary" disabled={busy || !draft.trim()} onClick={() => void saveDraft()}>保存为新草稿</ConfigButton></div>
            </AdminCard>
            <AdminCard title="发布前的三个步骤">
              <ol className="admin-step-list">
                <li className={!state.configs.length ? "is-current" : "is-done"}><div><strong>编写并保存草稿</strong><p>保存不等于发布，也不会影响现有对话。</p></div></li>
                <li className={latestDraft && !readyDraft ? "is-current" : readyDraft || published.length ? "is-done" : ""}><div><strong>运行快速评测</strong><p>同版本的已完成评测需 ≥85 分、致命问题为 0。</p></div></li>
                <li className={readyDraft ? "is-current" : published.length ? "is-done" : ""}><div><strong>人工确认发布</strong><p>先审阅证据；旧关系要另行迁移，不会自动切换。</p></div></li>
              </ol>
              <hr className="admin-divider" />
              <p className="admin-help">500 题评测用于扩大内部试用，不是保存首个草稿的前置条件。</p>
            </AdminCard>
          </div>

          <AdminCard title="版本与发布" description="评测和发布针对以下已保存版本，不包含编辑框中尚未保存的修改。">
            {!state.configs.length ? <AdminEmpty title="还没有陪伴配置版本">完成上方行为文档并保存后，版本、快速评测和发布入口会出现在这里。</AdminEmpty>
              : state.configs.map((config) => {
                const blocker = publicationBlocker(config.id, state.evaluations);
                return <div className="admin-row" key={config.id}>
                  <div><div className="admin-title-row"><strong>v{config.version}</strong><AdminBadge tone={config.status === "published" ? "success" : config.status === "draft" ? "info" : "neutral"}>{configLabels[config.status]}</AdminBadge></div><p className="admin-help">{config.modelId}</p>{config.status === "draft" && <p className="admin-help">{blocker ?? "发布预检已满足，请审阅评测后人工确认。"}</p>}</div>
                  <div className="admin-actions">
                    <ConfigButton variant="ghost" disabled={busy} onClick={() => { if (dirty && !window.confirm("用这个版本替换编辑框内容？尚未保存的修改将被替换。")) return; setDraft(config.behaviorDocument); setSavedDraft(config.behaviorDocument); editorRef.current?.focus(); }}>载入文档</ConfigButton>
                    {config.status === "draft" && <><ConfigButton disabled={busy} onClick={() => evaluate(config, "quick")}>运行快速评测</ConfigButton><ConfigButton variant="primary" disabled={busy || Boolean(blocker)} title={blocker ?? "审阅后确认发布"} onClick={() => publish(config)}>确认发布 v{config.version}</ConfigButton></>}
                    {config.status === "published" && <ConfigButton disabled={busy} onClick={() => evaluate(config, "full")}>运行 500 题评测</ConfigButton>}
                  </div>
                </div>;
              })}
          </AdminCard>

          <AdminCard title="评测记录与评分校准" description="只有评分器版本一致的结果才能直接比较。人工校准未完成时，不要根据小幅分差判断配置优劣。" action={<AdminBadge tone={state.calibrationCount >= 12 ? "success" : "warning"}>人工校准 {state.calibrationCount}/12</AdminBadge>}>
            {state.evaluations.length === 0 ? <AdminEmpty title="还没有评测记录">先保存草稿，再点击对应版本的「运行快速评测」。结果将保留分数、致命问题与判断依据。</AdminEmpty>
              : <div className="admin-stack">{state.evaluations.map((evaluation) => {
                const config = state.configs.find((item) => item.id === evaluation.configVersionId);
                const next = evaluation.results.find((item) => !state.calibrations.some((calibration) => calibration.runId === evaluation.id && calibration.itemId === item.id));
                const currentGrader = evaluation.graderVersion === state.evaluations[0]?.graderVersion;
                const validScore = humanScore.trim() !== "" && Number.isFinite(Number(humanScore)) && Number(humanScore) >= 0 && Number(humanScore) <= 100;
                return <details className="admin-details" key={evaluation.id}>
                  <summary>{versionName(evaluation.configVersionId)} · {evaluation.suite === "full" ? "500 题评测" : "快速评测"} · {evaluation.averageScore.toFixed(1)} 分 · 致命问题 {evaluation.fatalCount} 项</summary>
                  <div className="admin-details-body">
                    <p className="admin-help">评分器版本：{evaluation.graderVersion} · 状态：{evaluation.status === "completed" ? "已完成" : evaluation.status}</p>
                    <pre className="admin-code">{JSON.stringify({ results: evaluation.results, suggestions: evaluation.suggestions }, null, 2)}</pre>
                    {currentGrader && <><p className="admin-help">{next ? `下一条待校准题目：${next.id}，自动评分 ${next.finalTotal}。请先阅读上方该题证据，再给出人工分和样本档位。` : "本次评测的题目已全部完成人工校准。"}</p>
                      <div className="admin-form-row"><label className="admin-field">人工评分（0–100）<input type="number" min="0" max="100" value={humanScore} disabled={busy || !next} onChange={(event) => setHumanScore(event.target.value)} /></label><div className="admin-actions">
                        {([ ["high", "高分"], ["borderline", "边界"], ["low", "低分"] ] as const).map(([band, label]) => <ConfigButton key={band} disabled={busy || !next || !validScore} onClick={() => void run("正在记录人工校准…", async () => { if (!next) return; await request(json({ action: "calibration", runId: evaluation.id, itemId: next.id, band, humanScore: Number(humanScore), notes: "人工复核评分与证据" })); await load(); setNotice("人工校准已记录。"); })}>{label}样本校准</ConfigButton>)}
                      </div></div></>}
                    <div className="admin-actions">
                      <ConfigButton disabled={busy || !config || evaluation.status !== "completed"} onClick={() => { if (config) evaluate(config, evaluation.suite, evaluation); }}>评分器变更后桥接重评</ConfigButton>
                      <ConfigButton disabled={evaluation.status !== "completed"} onClick={() => { setEvidence({ sourceType: "evaluation", sourceId: evaluation.id, baseConfigVersionId: evaluation.configVersionId, quote: evaluation.results.flatMap((item) => item.evidence ?? [])[0] ?? "评分器建议" }); navigate("review"); }}>以此评测创建改进建议 →</ConfigButton>
                    </div>
                  </div>
                </details>;
              })}</div>}
          </AdminCard>
        </div>}

        {workspace === "review" && <div className="admin-stack">
          <AdminCard title="有限人工质量复核" description="仅显示已独立同意参与者的去标识双消息片段与关联版本。查看和复核决定均记入审计。" action={<AdminBadge>{state.samples.length} 条待复核</AdminBadge>}>
            {state.samples.length === 0 ? <AdminEmpty title="暂无待复核片段" action={teamAction}>成员先在「凡小忆对我的了解」中独立同意质量复核；产生对话并被抽样后，片段才会出现在这里。没有片段不代表质量已经通过。</AdminEmpty>
              : <div className="admin-stack">{state.samples.map((sample) => {
                const decision = decisions[sample.id] ?? emptyDecision;
                const update = (change: Partial<Decision>) => setDecisions((current) => ({ ...current, [sample.id]: { ...decision, ...change } }));
                return <article className="admin-record" key={sample.id}>
                  <div className="admin-title-row"><strong>对话片段</strong><AdminBadge>{versionName(sample.configVersionId)}</AdminBadge></div>
                  <div className="admin-chat-excerpt">{sample.messages.map((item, index) => <div key={index}><span>{item.role === "user" ? "陪伴对象" : "凡小忆 · AI"}</span><p>{item.text}</p></div>)}</div>
                  <fieldset disabled={busy}><legend className="admin-help">根据片段作出判断；未勾选表示该项不成立</legend><div className="admin-checks">{([ ["specificallyResponsive", "有具体承接"], ["interrogation", "存在连续盘问"], ["ignoredEnding", "忽视结束意愿"], ["baselineViolation", "对话底线违规"] ] as const).map(([key, label]) => <label key={key}><input type="checkbox" checked={decision[key]} onChange={(event) => update({ [key]: event.target.checked })} />{label}</label>)}</div></fieldset>
                  <label className="admin-field">复核备注<input placeholder="写明支持判断的具体证据" value={decision.notes} disabled={busy} onChange={(event) => update({ notes: event.target.value })} /></label>
                  <div className="admin-actions"><ConfigButton disabled={busy || !decision.notes.trim()} onClick={() => void review(sample)}>记录复核决定</ConfigButton></div>
                </article>;
              })}</div>}
          </AdminCard>
          <AdminCard title="基于证据的改进建议" description="建议只是候选差异（advisory），不会自动修改、发布或迁移陪伴配置。">
            {evidence ? <div className="admin-stack">
              <div className="admin-warning">已选择{evidence.sourceType === "review" ? "人工复核" : "评测"}证据 · 基础版本 {versionName(evidence.baseConfigVersionId)}<br />{evidence.quote}</div>
              <label className="admin-field">候选行为文档<textarea aria-label="候选行为文档" rows={6} value={draft} disabled={busy} onChange={(event) => setDraft(event.target.value)} /></label>
              <div className="admin-actions"><ConfigButton variant="primary" disabled={busy || !draft.trim()} onClick={() => void run("正在创建改进建议…", async () => { await request(json({ action: "propose", ...evidence, evidence: [{ sourceId: evidence.sourceId, quote: evidence.quote }], proposedBehaviorDocument: draft })); await load(); setNotice("改进建议已创建，尚未接受或发布。"); })}>创建候选改进建议</ConfigButton><ConfigButton variant="ghost" onClick={() => setEvidence(null)}>清除所选证据</ConfigButton></div>
            </div> : <p className="admin-help">先完成一条人工复核，或在「配置与发布」的评测记录中选择证据，再编辑候选文档。</p>}
            <div className="admin-stack">{state.proposals.map((proposal) => <details className="admin-details" key={proposal.id}>
              <summary>改进建议 · {proposal.status === "advisory" ? "待人工审阅" : proposal.status === "accepted" ? "已接受为草稿" : "已拒绝"}</summary>
              <div className="admin-details-body"><pre className="admin-code">{proposal.diff}</pre>
                {proposal.status === "advisory" && <><p className="admin-help">接受的是这份建议对应的候选文档，而不是其他未保存的编辑。接受后还需重新评测并确认发布。</p><ConfigButton disabled={busy || !proposal.proposedBehaviorDocument?.trim()} onClick={() => { if (!window.confirm("接受此建议的候选文档为新草稿？\n不会自动发布，现有陪伴关系保持不变。")) return; void run("正在接受建议为草稿…", async () => { await request(json({ action: "accept_proposal", proposalId: proposal.id, behaviorDocument: proposal.proposedBehaviorDocument })); await load(); setNotice("建议已接受为新草稿。请返回配置与发布，评测该版本后再决定是否发布。"); }); }}>人工接受为草稿</ConfigButton></>}
              </div>
            </details>)}</div>
          </AdminCard>
        </div>}

        {workspace === "trial" && <div className="admin-stack">
          <AdminCard title="内部试用参与者" description="先完成脚本任务，再进入自由聊天。结束访谈时明确记录是否愿意继续，不从聊天时长推断。">
            {!state.members.length ? <AdminEmpty title="还没有可纳入试用的陪伴成员" action={teamAction}>先在团队页邀请 Member。创建一个名为 member 的租户，或使用 Admin / Owner 身份，都不会产生陪伴成员。</AdminEmpty> : <div className="admin-stack">
              <div className="admin-form-row is-two"><label className="admin-field">试用参与者<select aria-label="试用参与者" value={trialMemberId} disabled={busy} onChange={(event) => setTrialMemberId(event.target.value)}><option value="">选择尚未纳入试用的 Member</option>{state.members.filter((item) => !state.trialParticipants.some((participant) => participant.membershipId === item.membershipId)).map((item) => <option key={item.membershipId} value={item.membershipId}>{item.displayName}</option>)}</select></label><div className="admin-actions"><ConfigButton disabled={busy || !trialMemberId} onClick={() => { if (!window.confirm("确认纳入脚本任务试用？\n请确认已告知参与者：排除直接身份标识，指定敏感练习使用虚构情境。此操作不会代替质量复核或长期记忆同意。")) return; void run("正在纳入内部试用…", async () => { await request(json({ action: "enroll_trial", membershipId: trialMemberId, excludesDirectIdentifiers: true, fictionalSensitiveExercises: true })); setTrialMemberId(""); await load(); setNotice("已纳入脚本任务试用。"); }); }}>纳入脚本任务试用</ConfigButton></div></div>
              {state.trialParticipants.length === 0 && <p className="admin-help">尚未开始内部试用。纳入参与者后，将显示阶段和后续操作。</p>}
              {state.trialParticipants.map((item) => <div className="admin-row" key={item.membershipId}><div><strong>{memberName(item.membershipId)}</strong><AdminBadge>{trialLabels[item.stage]}</AdminBadge></div><div className="admin-actions">
                {item.stage === "scripted" && <ConfigButton disabled={busy} onClick={() => void run("正在更新试用阶段…", async () => { await request(json({ action: "update_trial", membershipId: item.membershipId, stage: "free_chat" })); await load(); })}>进入自由聊天</ConfigButton>}
                {item.stage === "free_chat" && ([true, false] as const).map((willing) => <ConfigButton key={String(willing)} disabled={busy} onClick={() => { if (!window.confirm(`将 ${memberName(item.membershipId)} 的试用标记为完成，并记录${willing ? "愿意" : "不愿意"}继续？请以本人访谈回答为准。`)) return; void run("正在记录结束访谈…", async () => { await request(json({ action: "update_trial", membershipId: item.membershipId, stage: "completed", willingToContinue: willing })); await load(); }); }}>完成：{willing ? "愿意" : "不愿"}继续</ConfigButton>)}
              </div></div>)}
            </div>}
          </AdminCard>
          <AdminCard title="内部试用门槛" description="数据不足不是质量达标。扩大试用需同时满足评测、人工校准、真实抽样和试用反馈要求。" action={<AdminBadge tone={trial?.expansionAllowed ? "success" : "warning"}>{trial?.expansionAllowed ? "满足扩大试用条件" : "暂不扩大试用"}</AdminBadge>}>
            <div className="admin-stack">
              <div className="admin-title-row"><AdminBadge tone={state.calibrationCount >= 12 ? "success" : "warning"}>评分校准 {state.calibrationCount}/12</AdminBadge><AdminBadge tone={trial?.fullEvaluationReady ? "success" : "warning"}>500 题评测：{trial?.fullEvaluationReady ? "已通过" : "未通过"}</AdminBadge></div>
              {!trial?.participantCount ? <AdminEmpty title="暂无内部试用数据">纳入参与者、完成对话抽样和结束访谈后再查看指标。这里不会把零样本显示为 0% 或成功。</AdminEmpty> : <dl className="admin-metrics">
                <AdminMetric label="参与者 / 最短试用天数" value={`${trial.participantCount} 人 / ${trial.trialDays} 天`} />
                <AdminMetric label="已记录的对话底线违规" value={`${trial.baselineViolations} 项`} detail="目标为零；记录为零不等于完成全部验证。" />
                <AdminMetric label="具有具体承接" value={ratioText(trial.specificResponsive)} detail="展示人工抽样的分子与分母。" />
                <AdminMetric label="存在盘问" value={ratioText(trial.interrogationFailures)} />
                <AdminMetric label="忽视结束意愿" value={ratioText(trial.ignoredEndingFailures)} />
                <AdminMetric label="记忆与事实错误" value={ratioText(trial.memoryErrors)} />
                <AdminMetric label="首字延迟 p50 / p90" value={`${latencyText(trial.ordinaryFirstVisibleMs.p50)} / ${latencyText(trial.ordinaryFirstVisibleMs.p90)}`} detail="普通流式回复；目标分别为 1500 / 3000 ms。" />
                <AdminMetric label="完成延迟 p90 · 普通 / 缓冲" value={`${latencyText(trial.ordinaryCompletionMs.p90)} / ${latencyText(trial.bufferedCompletionMs.p90)}`} />
                <AdminMetric label="明确愿意继续" value={ratioText(trial.willingnessToContinue)} detail={`缺失访谈 ${trial.willingnessToContinue.missing} 人；不将缺失视为愿意。`} />
              </dl>}
              <ConfigButton onClick={() => navigate("configuration")}>前往版本评测与评分校准 →</ConfigButton>
            </div>
          </AdminCard>
        </div>}

        {workspace === "migration" && <div className="admin-stack">
          <AdminCard title="显式迁移与回滚" description="只有已有陪伴关系才能迁移。先查看差异，再确认应用；正在生成回复的关系由服务端拒绝迁移。">
            {!state.members.length ? <AdminEmpty title="没有可选择的陪伴成员" action={teamAction}>先邀请 Member，并由成员建立陪伴对话。管理员不通过这里模拟普通成员身份。</AdminEmpty>
              : !published.length ? <AdminEmpty title="还没有可迁移到的发布版本" action={<ConfigButton onClick={() => navigate("configuration")}>前往配置与发布 →</ConfigButton>}>先为草稿完成快速评测并确认发布。未发布的草稿不能作为迁移目标。</AdminEmpty>
              : <div className="admin-stack">
                <div className="admin-form-row">
                  <label className="admin-field">迁移参与者<select aria-label="迁移参与者" value={memberId} disabled={busy} onChange={(event) => { setMemberId(event.target.value); setPreview(null); }}><option value="">选择 Member</option>{state.members.map((member) => <option key={member.membershipId} value={member.membershipId}>{member.displayName}</option>)}</select></label>
                  <label className="admin-field">目标发布版本<select aria-label="目标发布版本" value={configId} disabled={busy} onChange={(event) => { setConfigId(event.target.value); setPreview(null); }}><option value="">选择版本</option>{published.map((item) => <option key={item.id} value={item.id}>v{item.version}</option>)}</select></label>
                  <ConfigButton disabled={busy || !memberId || !configId} onClick={() => void prepareMigration([memberId], configId, "administrator approved migration")}>预览并迁移</ConfigButton>
                </div>
                <p className="admin-help">上一步只生成预览，不会立即迁移。成员尚未创建陪伴关系时，预览会给出原因。</p>
                <details className="admin-details"><summary>批量迁移 · 选择多个参与者</summary><div className="admin-details-body">
                  <fieldset disabled={busy}><legend className="admin-help">共选择 {batchIds.length} 人，目标为 {versionName(configId) || "未选择"}</legend><div className="admin-checks">{state.members.map((member) => <label key={member.membershipId}><input type="checkbox" checked={batchIds.includes(member.membershipId)} onChange={(event) => { setBatchIds((current) => event.target.checked ? [...current, member.membershipId] : current.filter((id) => id !== member.membershipId)); setPreview(null); }} />{member.displayName}</label>)}</div></fieldset>
                  <ConfigButton disabled={busy || !configId || batchIds.length === 0} onClick={() => void prepareMigration(batchIds, configId, "administrator approved batch migration", true)}>预览批量迁移</ConfigButton>
                </div></details>
              </div>}
          </AdminCard>
          {preview && <AdminCard title="确认迁移差异" description={`参与者：${preview.memberIds.map(memberName).join("、")} · 目标：${versionName(preview.configVersionId)}。当前尚未应用。`}>
            <div className="admin-stack"><pre className="admin-code">{preview.diff || "服务端未返回文档差异，请核对目标版本。"}</pre><div className="admin-warning">确认后将改变上述陪伴关系的行为版本。原版本会保留为回滚目标。</div><div className="admin-actions"><ConfigButton variant="primary" disabled={busy} onClick={confirmMigration}>确认迁移</ConfigButton><ConfigButton disabled={busy} onClick={() => setPreview(null)}>取消，不作修改</ConfigButton></div></div>
          </AdminCard>}
          <AdminCard title="迁移与回滚记录">
            {state.migrations.length === 0 ? <p className="admin-help">暂无迁移记录。首次确认迁移后，这里会显示来源版本、目标版本及回滚入口。</p> : state.migrations.map((item) => <div className="admin-row" key={item.id}>
              <div><strong>{memberName(item.membershipId)} · {versionName(item.fromConfigVersionId)} → {versionName(item.toConfigVersionId)}</strong><p className="admin-help">{adminDate(item.createdAt)} · {item.reason}</p></div>
              <ConfigButton disabled={busy} onClick={() => void prepareMigration([item.membershipId], item.rollbackConfigVersionId, `rollback of ${item.id}`)}>预览回滚到 {versionName(item.rollbackConfigVersionId)}</ConfigButton>
            </div>)}
          </AdminCard>
          <details className="admin-details"><summary>完整治理审计 · {state.audit.length} 条已加载记录</summary><div className="admin-details-body">
            {!state.audit.length ? <p className="admin-help">暂无已加载的审计记录。</p> : state.audit.map((item) => <div className="admin-row" key={item.id}><div><strong>{item.action}</strong><p className="admin-help">{item.targetType} · {item.targetId ?? "—"}</p></div><time className="admin-help" dateTime={item.createdAt}>{adminDate(item.createdAt)}</time></div>)}
          </div></details>
        </div>}
      </div>
    </div>
  );
}
