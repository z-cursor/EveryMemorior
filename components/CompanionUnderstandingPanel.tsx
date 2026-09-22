"use client";

import { useCallback, useEffect, useState } from "react";
import styles from "./CompanionUnderstandingPanel.module.css";

type Memory = { id: string; content: string; status: "pending_confirmation" | "confirmed"; sensitivity: "ordinary" | "sensitive" };
type Profile = { field: string; value: string; source: "explicit" | "inferred" | "enterprise"; sourceLabel?: string | null };
type Fragment = { id: string; summary: string };
type Understanding = {
  explanation: string;
  consent: { memoryEnabled: boolean };
  memories: Memory[];
  profile: Profile[];
  fragments: Fragment[];
  privacy: { rawRetentionDays: number };
};

const PROFILE_FIELDS = [
  ["form_of_address", "称呼"], ["reply_length", "回复长短"], ["question_preference", "追问偏好"],
  ["topics", "常聊话题"], ["humor", "幽默偏好"], ["advice_preference", "建议偏好"],
  ["boundaries", "明确边界"], ["familiarity", "熟悉度"],
] as const;

async function patchUnderstanding(body: Record<string, unknown>): Promise<void> {
  const response = await fetch("/api/companion/understanding", {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error((await response.json() as { error?: string }).error ?? "更新失败");
}

function MemoryEditor({ memory, refresh }: { memory: Memory; refresh: () => void }) {
  const [content, setContent] = useState(memory.content);
  const applyMemoryUpdate = async (body: Record<string, unknown>) => { await patchUnderstanding(body); refresh(); };
  return (
    <li className={styles.item}>
      <label>记住的内容<input value={content} onChange={(event) => setContent(event.target.value)} /></label>
      <p className={styles.muted}>{memory.status === "pending_confirmation" ? "敏感内容，尚未用于对话" : "已确认，可随时纠正或撤销"}</p>
      <div className={styles.actions}>
        {memory.status === "pending_confirmation" && <button className={styles.button} type="button" onClick={() => void applyMemoryUpdate({ action: "confirm_memory", memoryId: memory.id })}>确认记住</button>}
        <button className={styles.button} type="button" onClick={() => void applyMemoryUpdate({ action: "correct_memory", memoryId: memory.id, content })}>保存纠正</button>
        <button className={`${styles.button} ${styles.danger}`} type="button" onClick={() => void applyMemoryUpdate({ action: "delete_memory", memoryId: memory.id })}>删除</button>
      </div>
    </li>
  );
}

function FragmentEditor({ fragment, refresh }: { fragment: Fragment; refresh: () => void }) {
  const [summary, setSummary] = useState(fragment.summary);
  const applyFragmentUpdate = async (body: Record<string, unknown>) => { await patchUnderstanding(body); refresh(); };
  return (
    <li className={styles.item}>
      <label>较早对话摘要<input value={summary} onChange={(event) => setSummary(event.target.value)} /></label>
      <div className={styles.actions}>
        <button className={styles.button} type="button" onClick={() => void applyFragmentUpdate({ action: "correct_fragment", fragmentId: fragment.id, summary })}>保存纠正</button>
        <button className={`${styles.button} ${styles.danger}`} type="button" onClick={() => void applyFragmentUpdate({ action: "delete_fragment", fragmentId: fragment.id })}>删除</button>
      </div>
    </li>
  );
}

export function CompanionUnderstandingPanel({ onClose }: { onClose: () => void }) {
  const [data, setData] = useState<Understanding | null>(null);
  const [status, setStatus] = useState("");
  const [field, setField] = useState<string>(PROFILE_FIELDS[0][0]);
  const [value, setValue] = useState("");
  const load = useCallback(() => {
    void fetch("/api/companion/understanding", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("无法读取凡小忆对您的了解");
        setData(await response.json() as Understanding);
      })
      .catch((error) => setStatus(error instanceof Error ? error.message : String(error)));
  }, []);
  useEffect(load, [load]);
  const applyUnderstandingUpdate = async (body: Record<string, unknown>, message = "已更新") => {
    try { await patchUnderstanding(body); setStatus(message); load(); } catch (error) { setStatus(error instanceof Error ? error.message : String(error)); }
  };
  const applyDisplayPreference = (key: "companionTextSize" | "companionContrast", value: string) => {
    localStorage.setItem(key, value);
    if (key === "companionTextSize") document.documentElement.dataset.companionTextSize = value;
    else document.documentElement.dataset.companionContrast = value;
  };

  return (
    <div className={styles.backdrop} role="presentation">
      <aside className={styles.panel} role="dialog" aria-modal="true" aria-labelledby="companion-understanding-title">
        <header className={styles.header}><div><h2 id="companion-understanding-title">凡小忆对我的了解</h2><p className={styles.muted}>您可以查看、纠正、删除或重置每一项。</p></div><button className={styles.close} type="button" onClick={onClose} aria-label="关闭">关闭</button></header>
        <p className={styles.status} role="status">{status}</p>

        <section className={styles.section} aria-labelledby="memory-title">
          <h3 id="memory-title">长期记忆</h3>
          <p className={styles.muted}>{data?.explanation ?? "长期记忆默认关闭；不开启也能正常聊天。"}</p>
          <label className={styles.switch}><input type="checkbox" checked={data?.consent.memoryEnabled ?? false} onChange={(event) => void applyUnderstandingUpdate({ action: "set_consent", enabled: event.target.checked }, event.target.checked ? "长期记忆已开启" : "长期记忆已关闭")} />允许跨对话使用已确认的信息</label>
          <ul className={styles.list}>{data?.memories.map((memory) => <MemoryEditor key={memory.id} memory={memory} refresh={load} />)}</ul>
          <button className={`${styles.button} ${styles.danger}`} type="button" onClick={() => void applyUnderstandingUpdate({ action: "reset_memories" }, "已清空记忆")}>重置全部记忆</button>
        </section>

        <section className={styles.section} aria-labelledby="profile-title">
          <h3 id="profile-title">陪伴画像</h3><p className={styles.muted}>这里只保存称呼、回复方式、话题和明确边界，不保存诊断、人格或经济标签。</p>
          <ul className={styles.list}>{data?.profile.map((item) => <li className={styles.item} key={item.field}><strong>{PROFILE_FIELDS.find(([key]) => key === item.field)?.[1] ?? item.field}</strong><p>{item.value}</p>{item.source === "enterprise" && <small>来源：{item.sourceLabel}</small>}<div className={styles.actions}><button className={`${styles.button} ${styles.danger}`} type="button" onClick={() => void applyUnderstandingUpdate({ action: "delete_profile", field: item.field })}>删除</button></div></li>)}</ul>
          {!data?.consent.memoryEnabled && <p className={styles.muted}>开启长期记忆后，才会保存并在对话中使用陪伴画像。</p>}
          <form className={styles.form} onSubmit={(event) => { event.preventDefault(); void applyUnderstandingUpdate({ action: "set_profile", field, value }, "偏好已立即生效"); setValue(""); }}><label>偏好类别<select disabled={!data?.consent.memoryEnabled} value={field} onChange={(event) => setField(event.target.value)}>{PROFILE_FIELDS.map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label><label>您的偏好<input disabled={!data?.consent.memoryEnabled} required value={value} onChange={(event) => setValue(event.target.value)} /></label><button className={styles.button} disabled={!data?.consent.memoryEnabled} type="submit">保存偏好</button></form>
          <button className={`${styles.button} ${styles.danger}`} type="button" onClick={() => void applyUnderstandingUpdate({ action: "reset_profile" }, "已重置陪伴画像")}>重置陪伴画像</button>
        </section>

        <section className={styles.section} aria-labelledby="fragments-title">
          <h3 id="fragments-title">较早对话摘要</h3>
          <p className={styles.muted}>只保留日常话题的概括，不保留原句；您可以纠正或删除。</p>
          <ul className={styles.list}>{data?.fragments.map((fragment) => <FragmentEditor key={fragment.id} fragment={fragment} refresh={load} />)}</ul>
          <button className={`${styles.button} ${styles.danger}`} type="button" onClick={() => void applyUnderstandingUpdate({ action: "reset_fragments" }, "已清空较早对话摘要")}>重置全部摘要</button>
        </section>

        <section className={styles.section} aria-labelledby="display-title"><h3 id="display-title">显示设置</h3><div className={styles.form}><label>文字大小<select defaultValue="normal" onChange={(event) => applyDisplayPreference("companionTextSize", event.target.value)}><option value="normal">标准</option><option value="large">大</option><option value="largest">最大</option></select></label><label>对比度<select defaultValue="normal" onChange={(event) => applyDisplayPreference("companionContrast", event.target.value)}><option value="normal">标准</option><option value="high">高对比</option></select></label></div></section>
        <section className={styles.section} aria-labelledby="privacy-title"><h3 id="privacy-title">隐私说明</h3><p className={styles.muted}>原始陪伴消息在内部试用中默认保留不超过 90 天（当前设置：{data?.privacy.rawRetentionDays ?? 90} 天）。删除来源消息时，相关候选、证据和摘要会同步移除；已确认记忆由您另行决定是否删除。</p></section>
      </aside>
    </div>
  );
}
