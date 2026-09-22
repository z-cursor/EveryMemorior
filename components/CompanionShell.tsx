"use client";

import { useEffect, useRef, useState } from "react";

type CompanionMessage = { id: string; role: "user" | "assistant"; text: string; incomplete?: boolean; buffered?: boolean; sources?: Array<{ title: string; url: string }> };

type CompanionEvent = {
  type: string;
  clientMessageId?: string;
  text?: string;
  replyText?: string;
  visibleText?: string;
  buffered?: boolean;
  sources?: Array<{ title: string; url: string }>;
  failureType?: string;
};

function newMessageId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
}

export function CompanionShell() {
  const [messages, setMessages] = useState<CompanionMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("凡小忆随时在这里听您说。凡小忆是 AI，不能联系、定位、报警或救援。");
  const [error, setError] = useState("");
  const activeId = useRef<string | null>(null);
  const requestRef = useRef<AbortController | null>(null);

  useEffect(() => {
    let mounted = true;
    void fetch("/api/companion", { cache: "no-store" }).then(async (response) => {
      if (!response.ok) throw new Error(await response.text());
      return response.json() as Promise<{ history?: Array<{ role: "user" | "assistant"; text: string }> }>;
    }).then((data) => {
      if (!mounted) return;
      setMessages((data.history ?? []).map((message, index) => ({ ...message, id: `history-${index}` })));
    }).catch((cause) => mounted && setError(cause instanceof Error ? cause.message : String(cause)));
    const source = new EventSource("/api/companion/events");
    source.onmessage = (message) => {
      const event = JSON.parse(message.data) as CompanionEvent;
      const clientMessageId = event.clientMessageId;
      if (!clientMessageId) return;
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

  return (
    <main className="companion-shell">
      <header className="companion-header">
        <div><span className="companion-eyebrow">陪伴对话</span><h1>凡小忆</h1><p>您的 AI 陪伴伙伴</p></div>
        <button type="button" className="companion-privacy" onClick={() => setStatus("您可以随时停止、纠正或结束对话。长期记忆需要单独同意；凡小忆不会执行现实救援。")}>隐私说明</button>
      </header>
      <section className="companion-notice" aria-label="凡小忆说明">凡小忆是 AI，不是真人。它可以陪您聊天，但不能替您联系家人、报警、定位或进行现实救援。</section>
      <section className="companion-messages" aria-live="polite" aria-label="与凡小忆的对话">
        {messages.length === 0 && <div className="companion-welcome"><h2>您好，我是凡小忆。</h2><p>您可以从今天的心情、身边的小事，或者任何想说的话开始。</p></div>}
        {messages.map((message) => <article className={`companion-message is-${message.role}`} key={message.id}><span className="companion-message-label">{message.role === "user" ? "您" : "凡小忆 · AI"}</span><p>{message.text || (message.buffered ? "正在核对，请稍等……" : "正在想一想……")}</p>{message.incomplete && <small>未完成回复 · 不会作为下一次对话的依据</small>}{message.sources && message.sources.length > 0 && <details><summary>查看来源</summary><ul>{message.sources.map((source) => <li key={source.url}><a href={source.url} target="_blank" rel="noreferrer">{source.title}</a></li>)}</ul></details>}</article>)}
        {(status || error) && <p className={error ? "companion-error" : "companion-status"} role={error ? "alert" : "status"}>{error || status}</p>}
      </section>
      <form className="companion-composer" onSubmit={(event) => { event.preventDefault(); void send(); }}>
        <label htmlFor="companion-input">想和凡小忆说点什么？</label>
        <textarea id="companion-input" value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="请写下您想说的话" rows={3} disabled={busy} />
        <div className="companion-composer-actions"><span>按 Enter 发送，Shift + Enter 换行</span>{busy ? <button type="button" onClick={() => void stop()}>停止回复</button> : <button type="submit" disabled={!draft.trim()}>发送</button>}</div>
      </form>
    </main>
  );
}
