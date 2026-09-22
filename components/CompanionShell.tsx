"use client";

import { useEffect, useRef, useState } from "react";
import { CompanionUnderstandingPanel } from "./CompanionUnderstandingPanel";

type CompanionMessage = { id: string; entryId?: string; role: "user" | "assistant"; text: string; incomplete?: boolean; buffered?: boolean; sources?: Array<{ title: string; url: string }> };

type CompanionEvent = {
  type: string;
  clientMessageId?: string;
  text?: string;
  replyText?: string;
  visibleText?: string;
  buffered?: boolean;
  sources?: Array<{ title: string; url: string }>;
  failureType?: string;
  memory?: { id: string; content: string; status: "pending_confirmation" | "confirmed" };
};

type MemoryNotice = { id: string; content: string; confirmation: boolean };

function newMessageId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
}

export function CompanionShell() {
  const [messages, setMessages] = useState<CompanionMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("凡小忆随时在这里听您说。凡小忆是 AI，不能联系、定位、报警或救援。");
  const [error, setError] = useState("");
  const [understandingOpen, setUnderstandingOpen] = useState(false);
  const [memoryNotices, setMemoryNotices] = useState<MemoryNotice[]>([]);
  const activeId = useRef<string | null>(null);
  const requestRef = useRef<AbortController | null>(null);

  useEffect(() => {
    document.documentElement.dataset.companionTextSize = localStorage.getItem("companionTextSize") ?? "normal";
    document.documentElement.dataset.companionContrast = localStorage.getItem("companionContrast") ?? "normal";
    let mounted = true;
    void fetch("/api/companion", { cache: "no-store" }).then(async (response) => {
      if (!response.ok) throw new Error(await response.text());
      return response.json() as Promise<{ history?: Array<{ entryId?: string; role: "user" | "assistant"; text: string }> }>;
    }).then((data) => {
      if (!mounted) return;
      setMessages((data.history ?? []).map((message, index) => ({ ...message, id: `history-${index}` })));
    }).catch((cause) => mounted && setError(cause instanceof Error ? cause.message : String(cause)));
    const source = new EventSource("/api/companion/events");
    source.onmessage = (message) => {
      const event = JSON.parse(message.data) as CompanionEvent;
      const clientMessageId = event.clientMessageId;
      if (!clientMessageId) return;
      if ((event.type === "memory_receipt" || event.type === "memory_confirmation") && event.memory) {
        const notice = { id: event.memory.id, content: event.memory.content, confirmation: event.type === "memory_confirmation" };
        setMemoryNotices((current) => current.some((item) => item.id === notice.id) ? current : [...current, notice]);
        return;
      }
      setMessages((current) => {
        const id = `assistant-${clientMessageId}`;
        const index = current.findIndex((item) => item.id === id);
        const currentMessage = index >= 0 ? current[index] : { id, role: "assistant" as const, text: "" };
        let next = currentMessage;
        if (event.type === "turn_started") {
          next = { ...currentMessage, buffered: event.buffered, text: "" };
          setStatus(event.buffered ? "这条消息需要先核对一下，请稍等。" : "凡小忆正在想一想……");
        } else if (event.type === "text_delta") {
          next = { ...currentMessage, text: currentMessage.text + (event.text ?? "") };
          setStatus("");
        } else if (event.type === "turn_completed") {
          next = { ...currentMessage, text: event.replyText ?? currentMessage.text, sources: event.sources };
          setStatus("");
        } else if (event.type === "turn_incomplete") {
          next = { ...currentMessage, text: event.visibleText ?? currentMessage.text, incomplete: true };
          setStatus("这次回复没有完整完成，您可以稍后重试。 ");
        } else return current;
        if (index >= 0) return current.map((item, itemIndex) => itemIndex === index ? next : item);
        return [...current, next];
      });
    };
    return () => { mounted = false; source.close(); requestRef.current?.abort(); };
  }, []);

  const send = async () => {
    const text = draft.trim();
    if (!text || busy) return;
    const clientMessageId = newMessageId();
    activeId.current = clientMessageId;
    setMessages((current) => [...current, { id: `user-${clientMessageId}`, role: "user", text }]);
    setDraft("");
    setBusy(true);
    setError("");
    const controller = new AbortController();
    requestRef.current = controller;
    try {
      const response = await fetch("/api/companion", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ clientMessageId, text }), signal: controller.signal });
      const data = await response.json() as { error?: string; turn?: { replyText?: string | null; status?: string } };
      if (!response.ok) throw new Error(data.error ?? "暂时无法回复");
      if (data.turn?.replyText) {
        const replyText = data.turn.replyText;
        setMessages((current) => {
          const id = `assistant-${clientMessageId}`;
          const existing = current.find((item) => item.id === id);
          if (existing?.text === replyText) return current;
          if (existing) return current.map((item) => item.id === id ? { ...item, text: replyText } : item);
          return [...current, { id, role: "assistant", text: replyText }];
        });
      }
    } catch (cause) {
      if (!(cause instanceof DOMException && cause.name === "AbortError")) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      requestRef.current = null;
      activeId.current = null;
      setBusy(false);
    }
  };

  const stop = async () => {
    requestRef.current?.abort();
    await fetch("/api/companion", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "stop" }) }).catch(() => undefined);
    setBusy(false);
    setStatus("已停止这次回复。");
  };

  const memoryAction = async (memoryNotice: MemoryNotice, action: "confirm_memory" | "delete_memory") => {
    const response = await fetch("/api/companion/understanding", {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, memoryId: memoryNotice.id }),
    });
    if (!response.ok) {
      setError((await response.json() as { error?: string }).error ?? "无法更新记忆");
      return;
    }
    setStatus(action === "confirm_memory" ? "已确认记住；您随时可以纠正或撤销。" : "已撤销记忆。");
    setMemoryNotices((current) => current.filter((notice) => notice.id !== memoryNotice.id));
  };

  const deleteSource = async (message: CompanionMessage) => {
    if (!message.entryId || !window.confirm("删除这条消息及凡小忆对它的回复吗？")) return;
    const preview = await fetch("/api/companion/understanding", {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "preview_source_deletion", sourceEntryId: message.entryId }),
    });
    const previewBody = await preview.json() as { error?: string; confirmedMemories?: Array<{ content: string }> };
    if (!preview.ok) { setError(previewBody.error ?? "无法检查关联记忆"); return; }
    const associated = previewBody.confirmedMemories ?? [];
    const removeConfirmedMemories = associated.length > 0 && window.confirm(`这条消息还关联 ${associated.length} 条已确认记忆。是否同时删除这些记忆？`);
    const response = await fetch("/api/companion/understanding", {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "delete_source", sourceEntryId: message.entryId, removeConfirmedMemories }),
    });
    if (!response.ok) { setError((await response.json() as { error?: string }).error ?? "无法删除消息"); return; }
    setMessages((current) => {
      const index = current.findIndex((item) => item.id === message.id);
      if (index < 0) return current;
      const removedIds = new Set([message.id, ...(current[index + 1]?.role === "assistant" ? [current[index + 1].id] : [])]);
      return current.filter((item) => !removedIds.has(item.id));
    });
    setStatus(removeConfirmedMemories ? "消息和关联记忆已删除。" : "消息已删除；已确认记忆保持不变。");
  };

  return (
    <main className="companion-shell">
      <header className="companion-header">
        <div><span className="companion-eyebrow">陪伴对话</span><h1>凡小忆</h1><p>您的 AI 陪伴伙伴</p></div>
        <div><button type="button" className="companion-privacy" onClick={() => setUnderstandingOpen(true)}>凡小忆对我的了解</button><button type="button" className="companion-privacy" onClick={() => setStatus("您可以随时停止、纠正或结束对话。长期记忆需要单独同意；凡小忆不会执行现实救援。")}>隐私说明</button></div>
      </header>
      <section className="companion-notice" aria-label="凡小忆说明">凡小忆是 AI，不是真人。它可以陪您聊天，但不能替您联系家人、报警、定位或进行现实救援。</section>
      <section className="companion-notice" aria-label="长期记忆说明">长期记忆默认关闭；不开启也能正常聊天。开启后，普通稳定偏好会显示可撤销回执，敏感信息仍需您逐条确认。 <button type="button" className="companion-privacy" onClick={() => setUnderstandingOpen(true)}>了解与设置</button></section>
      <section className="companion-messages" aria-live="polite" aria-label="与凡小忆的对话">
        {messages.length === 0 && <div className="companion-welcome"><h2>您好，我是凡小忆。</h2><p>您可以从今天的心情、身边的小事，或者任何想说的话开始。</p></div>}
        {messages.map((message) => <article className={`companion-message is-${message.role}`} key={message.id}><span className="companion-message-label">{message.role === "user" ? "您" : "凡小忆 · AI"}</span><p>{message.text || (message.buffered ? "正在核对，请稍等……" : "正在想一想……")}</p>{message.role === "user" && message.entryId && <button type="button" className="companion-privacy" onClick={() => void deleteSource(message)}>删除这条消息</button>}{message.incomplete && <small>未完成回复 · 不会作为下一次对话的依据</small>}{message.sources && message.sources.length > 0 && <details><summary>查看来源</summary><ul>{message.sources.map((source) => <li key={source.url}><a href={source.url} target="_blank" rel="noreferrer">{source.title}</a></li>)}</ul></details>}</article>)}
        {memoryNotices.map((memoryNotice) => <aside className="companion-notice" aria-live="polite" key={memoryNotice.id}><strong>{memoryNotice.confirmation ? "这是一项敏感信息，是否确认记住？" : "记忆回执"}</strong><p>{memoryNotice.content}</p><button type="button" className="companion-privacy" onClick={() => void memoryAction(memoryNotice, memoryNotice.confirmation ? "confirm_memory" : "delete_memory")}>{memoryNotice.confirmation ? "确认记住" : "撤销记忆"}</button>{memoryNotice.confirmation && <button type="button" className="companion-privacy" onClick={() => void memoryAction(memoryNotice, "delete_memory")}>不要记住</button>}</aside>)}
        {(status || error) && <p className={error ? "companion-error" : "companion-status"} role={error ? "alert" : "status"}>{error || status}</p>}
      </section>
      <form className="companion-composer" onSubmit={(event) => { event.preventDefault(); void send(); }}>
        <label htmlFor="companion-input">想和凡小忆说点什么？</label>
        <textarea id="companion-input" value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="请写下您想说的话" rows={3} disabled={busy} />
        <div className="companion-composer-actions"><span>按 Enter 发送，Shift + Enter 换行</span>{busy ? <button type="button" onClick={() => void stop()}>停止回复</button> : <button type="submit" disabled={!draft.trim()}>发送</button>}</div>
      </form>
      {understandingOpen && <CompanionUnderstandingPanel onClose={() => setUnderstandingOpen(false)} />}
    </main>
  );
}
