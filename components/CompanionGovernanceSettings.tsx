"use client";

import { useCallback, useEffect, useState } from "react";

type Member = { membershipId: string; displayName: string };
type Config = { id: string; version: number; status: "draft" | "published" | "archived"; behaviorDocument: string; modelId: string };
type Sample = { id: string; configVersionId: string; messages: Array<{ role: string; text: string }> };
type Evaluation = { id: string; configVersionId: string; graderVersion: string; suite: "quick" | "full"; averageScore: number; fatalCount: number; results: Array<{ id: string; finalTotal: number; evidence?: string[] }>; suggestions: unknown[] };
type Proposal = { id: string; status: "advisory" | "accepted" | "rejected"; diff: string };
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
  const body = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `Request failed (${response.status})`);
  return body;
}

const json = (body: Record<string, unknown>): RequestInit => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const emptyDecision: Decision = { specificallyResponsive: false, interrogation: false, ignoredEnding: false, baselineViolation: false, notes: "人工质量复核" };

export function CompanionGovernanceSettings() {
  const [state, setState] = useState<{ members: Member[]; configs: Config[]; samples: Sample[]; evaluations: Evaluation[]; proposals: Proposal[]; migrations: Migration[]; trialParticipants: TrialParticipant[]; trial: Trial | null; calibrations: Calibration[]; calibrationCount: number; audit: Array<{ id: string; action: string; targetType: string; targetId: string | null; createdAt: string }> }>({ members: [], configs: [], samples: [], evaluations: [], proposals: [], migrations: [], trialParticipants: [], trial: null, calibrations: [], calibrationCount: 0, audit: [] });
  const [draft, setDraft] = useState("");
  const [memberId, setMemberId] = useState("");
  const [configId, setConfigId] = useState("");
  const [batchIds, setBatchIds] = useState<string[]>([]);
  const [decisions, setDecisions] = useState<Record<string, Decision>>({});
  const [evidence, setEvidence] = useState<{ sourceType: "review" | "evaluation"; sourceId: string; baseConfigVersionId: string; quote: string } | null>(null);
  const [humanScore, setHumanScore] = useState("50");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    const value = await request<typeof state>({ cache: "no-store" });
    setState(value);
    setDraft((current) => current || value.configs.find((item) => item.status === "draft")?.behaviorDocument || value.configs.find((item) => item.status === "published")?.behaviorDocument || "");
    setConfigId((current) => current || value.configs.find((item) => item.status === "published")?.id || "");
  }, []);

  useEffect(() => { void load().catch((error) => setMessage(error instanceof Error ? error.message : String(error))); }, [load]);

  const run = async (operation: () => Promise<void>) => {
    setBusy(true); setMessage("");
    try { await operation(); } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); } finally { setBusy(false); }
  };

  const evaluate = (config: Config, suite: "quick" | "full", bridgeFromGraderVersion?: string) => run(async () => {
    const result = await request<{ run: Evaluation }>(json({ action: "evaluation", configVersionId: config.id, suite, evaluationMode: "single_turn", bridgeFromGraderVersion }));
    setEvidence({ sourceType: "evaluation", sourceId: result.run.id, baseConfigVersionId: config.id, quote: result.run.results.flatMap((item) => item.evidence ?? [])[0] ?? "评分器建议" });
    await load(); setMessage(`评测完成：${result.run.averageScore.toFixed(1)} 分，致命问题 ${result.run.fatalCount} 项。`);
  });

  const review = (sample: Sample) => run(async () => {
    const result = await request<{ review: { id: string } }>(json({ action: "review", sampleId: sample.id, ...(decisions[sample.id] ?? emptyDecision) }));
    setEvidence({ sourceType: "review", sourceId: result.review.id, baseConfigVersionId: sample.configVersionId, quote: sample.messages[0]?.text ?? "" });
    await load(); setMessage("复核决定已记录。 ");
  });

  const migrate = (targetMemberId: string, targetConfigId: string, reason: string) => run(async () => {
    const result = await request<{ preview: { diff: string } }>(json({ action: "preview_migration", membershipId: targetMemberId, configVersionId: targetConfigId }));
    if (!window.confirm(`确认迁移？\n\n${result.preview.diff}`)) return;
    await request(json({ action: "migrate", membershipId: targetMemberId, configVersionId: targetConfigId, reason }));
    await load();
  });

  const trial = state.trial;
  return <div className="config-detail">
    <h2>凡小忆质量治理</h2>
    <p>人工复核、改进建议、版本迁移、评测与内部试用门槛。系统不会自动应用建议、发布版本或迁移既有关系。</p>

    <section><h3>配置与模型评测</h3>
      <textarea aria-label="凡小忆行为文档" rows={8} value={draft} onChange={(event) => setDraft(event.target.value)} />
      <button type="button" disabled={busy || !draft.trim()} onClick={() => void run(async () => { await request(json({ action: "draft", behaviorDocument: draft, modelProvider: "qwen", modelId: "FY-Qwen3.8-27B-NVFP4", thinkingLevel: "off", temperature: 0.2, maxOutputTokens: 600 })); await load(); })}>保存草稿</button>
      {state.configs.map((config) => <div key={config.id}><strong>v{config.version}</strong> · {config.status} · {config.modelId} {config.status === "draft" && <><button disabled={busy} onClick={() => void evaluate(config, "quick")}>运行快速评测</button><button disabled={busy} onClick={() => void run(async () => { await request(json({ action: "publish", configVersionId: config.id })); await load(); })}>显式发布</button></>}{config.status === "published" && <button disabled={busy} onClick={() => void evaluate(config, "full")}>运行 500 题评测</button>}</div>)}
      {state.evaluations.map((evaluation) => { const next = evaluation.results.find((item) => !state.calibrations.some((calibration) => calibration.runId === evaluation.id && calibration.itemId === item.id)); return <details key={evaluation.id}><summary>{evaluation.suite} · {evaluation.averageScore.toFixed(1)} 分 · 致命 {evaluation.fatalCount} · grader {evaluation.graderVersion}</summary><pre>{JSON.stringify({ results: evaluation.results, suggestions: evaluation.suggestions }, null, 2)}</pre><label>人工分 <input type="number" min="0" max="100" value={humanScore} onChange={(event) => setHumanScore(event.target.value)} /></label>{(["high", "borderline", "low"] as const).map((band) => <button key={band} disabled={busy || !next} onClick={() => void run(async () => { if (!next) return; await request(json({ action: "calibration", runId: evaluation.id, itemId: next.id, band, humanScore: Number(humanScore), notes: "人工复核评分与证据" })); await load(); })}>{band} 校准</button>)}<button disabled={busy} onClick={() => void evaluate(state.configs.find((item) => item.id === evaluation.configVersionId)!, evaluation.suite, evaluation.graderVersion)}>评分器变更后桥接</button></details>; })}
      <p>当前 grader 人工校准：{state.calibrationCount}/12</p>
    </section>

    <section><h3>有限人工质量复核</h3><p>只显示已独立同意参与者的去标识双消息片段和关联配置；查看与决定均记入审计。</p>
      {state.samples.length === 0 ? <p>暂无待复核片段。</p> : state.samples.map((sample) => { const decision = decisions[sample.id] ?? emptyDecision; const update = (change: Partial<Decision>) => setDecisions((current) => ({ ...current, [sample.id]: { ...decision, ...change } })); return <div key={sample.id}><p>{sample.messages.map((item) => `${item.role}: ${item.text}`).join(" / ")}</p>{([ ["specificallyResponsive", "具体承接"], ["interrogation", "盘问失败"], ["ignoredEnding", "忽视结束"], ["baselineViolation", "底线违规"] ] as const).map(([key, label]) => <label key={key}><input type="checkbox" checked={decision[key]} onChange={(event) => update({ [key]: event.target.checked })} />{label}</label>)}<input aria-label="复核备注" value={decision.notes} onChange={(event) => update({ notes: event.target.value })} /><button disabled={busy || !decision.notes.trim()} onClick={() => void review(sample)}>记录复核决定</button></div>; })}
      {evidence && <button disabled={busy || !draft.trim()} onClick={() => void run(async () => { await request(json({ action: "propose", ...evidence, evidence: [{ sourceId: evidence.sourceId, quote: evidence.quote }], proposedBehaviorDocument: draft })); await load(); })}>以所选证据创建 advisory 建议</button>}
      {state.proposals.map((proposal) => <div key={proposal.id}><pre>{proposal.diff}</pre><span>{proposal.status}</span>{proposal.status === "advisory" && <button disabled={busy} onClick={() => void run(async () => { await request(json({ action: "accept_proposal", proposalId: proposal.id, behaviorDocument: draft })); await load(); })}>人工接受为草稿</button>}</div>)}
    </section>

    <section><h3>显式迁移与回滚</h3>
      <select aria-label="参与者" value={memberId} onChange={(event) => setMemberId(event.target.value)}><option value="">选择参与者</option>{state.members.map((member) => <option key={member.membershipId} value={member.membershipId}>{member.displayName}</option>)}</select>
      <select aria-label="目标版本" value={configId} onChange={(event) => setConfigId(event.target.value)}><option value="">选择版本</option>{state.configs.filter((item) => item.status === "published").map((item) => <option key={item.id} value={item.id}>v{item.version}</option>)}</select>
      <button disabled={busy || !memberId || !configId} onClick={() => void migrate(memberId, configId, "administrator approved migration")}>预览并迁移</button>
      {state.members.map((member) => <label key={member.membershipId}><input type="checkbox" checked={batchIds.includes(member.membershipId)} onChange={(event) => setBatchIds((current) => event.target.checked ? [...current, member.membershipId] : current.filter((id) => id !== member.membershipId))} />{member.displayName}</label>)}
      <button disabled={busy || !configId || batchIds.length === 0} onClick={() => void run(async () => { const preview = await request<{ previews: Array<{ affectedMembershipIds: string[]; diff: string }> }>(json({ action: "preview_batch_migration", membershipIds: batchIds, configVersionId: configId })); if (!window.confirm(`确认迁移 ${preview.previews.flatMap((item) => item.affectedMembershipIds).length} 人？\n${preview.previews.map((item) => item.diff).join("\n---\n")}`)) return; await request(json({ action: "batch_migrate", membershipIds: batchIds, configVersionId: configId, reason: "administrator approved batch migration" })); await load(); })}>预览并批量迁移</button>
      {state.migrations.map((item) => <div key={item.id}>{item.membershipId}: {item.fromConfigVersionId} → {item.toConfigVersionId} · {item.reason} <button disabled={busy} onClick={() => void migrate(item.membershipId, item.rollbackConfigVersionId, `rollback of ${item.id}`)}>预览并回滚</button></div>)}
    </section>

    <section><h3>内部试用门槛</h3>
      <button disabled={busy || !memberId} onClick={() => void run(async () => { await request(json({ action: "enroll_trial", membershipId: memberId, excludesDirectIdentifiers: true, fictionalSensitiveExercises: true })); await load(); })}>纳入脚本任务试用</button>
      {state.trialParticipants.map((item) => <div key={item.membershipId}>{item.membershipId} · {item.stage} {item.stage === "scripted" && <button onClick={() => void run(async () => { await request(json({ action: "update_trial", membershipId: item.membershipId, stage: "free_chat" })); await load(); })}>进入自由聊天</button>}{item.stage === "free_chat" && <><button onClick={() => void run(async () => { await request(json({ action: "update_trial", membershipId: item.membershipId, stage: "completed", willingToContinue: true })); await load(); })}>完成：愿意继续</button><button onClick={() => void run(async () => { await request(json({ action: "update_trial", membershipId: item.membershipId, stage: "completed", willingToContinue: false })); await load(); })}>完成：不愿继续</button></>}</div>)}
      {trial && <dl><dt>参与者 / 最短天数</dt><dd>{trial.participantCount} / {trial.trialDays}</dd><dt>底线违规</dt><dd>{trial.baselineViolations}</dd><dt>具体承接</dt><dd>{trial.specificResponsive.numerator}/{trial.specificResponsive.denominator} ({trial.specificResponsive.percentage ?? "—"}%)</dd><dt>盘问 / 忽视结束</dt><dd>{trial.interrogationFailures.numerator} / {trial.ignoredEndingFailures.numerator}</dd><dt>记忆错误</dt><dd>{trial.memoryErrors.numerator}/{trial.memoryErrors.denominator} ({trial.memoryErrors.percentage ?? "—"}%)</dd><dt>首字 p50 / p90</dt><dd>{trial.ordinaryFirstVisibleMs.p50 ?? "—"} / {trial.ordinaryFirstVisibleMs.p90 ?? "—"} ms</dd><dt>普通 / 缓冲完成 p90</dt><dd>{trial.ordinaryCompletionMs.p90 ?? "—"} / {trial.bufferedCompletionMs.p90 ?? "—"} ms</dd><dt>愿意继续</dt><dd>{trial.willingnessToContinue.numerator}/{trial.willingnessToContinue.denominator}，缺失 {trial.willingnessToContinue.missing}</dd><dt>500 题 / 扩大试用</dt><dd>{trial.fullEvaluationReady ? "通过" : "未通过"} / {trial.expansionAllowed ? "允许" : "阻止"}</dd></dl>}
    </section>

    <details><summary>完整治理审计</summary>{state.audit.map((item) => <div key={item.id}>{item.createdAt} · {item.action} · {item.targetType} {item.targetId ?? ""}</div>)}</details>
    {message && <p role="status">{message}</p>}
  </div>;
}
