"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
export type CompanionThinkingLevel = "auto" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type CompanionController = {
  send: (text: string) => Promise<void>;
  stop: () => Promise<void>;
  compact: () => Promise<void>;
  setThinkingLevel: (level: CompanionThinkingLevel) => Promise<void>;
};

function newMessageId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
}

function companionErrorMessage(value: string): string {
  try {
    const parsed = JSON.parse(value) as { error?: string };
    value = parsed.error ?? value;
  } catch {}
  if (/model is not available in the enabled scope|companion model .* is not available/i.test(value)) {
    return "凡小忆暂时无法连接到已配置的模型。请管理员在「设置 → 模型」确认模型可用，并在「陪伴质量治理 → 配置与发布」检查陪伴模型。模型容器运行中不代表应用已选中同一个模型。";
  }
  if (/\bENOENT\b|no such file or directory/i.test(value)) {
    return "陪伴对话记录暂时无法读取，正在恢复会话。请刷新页面后重试。";
  }
  return value;
}

export function CompanionShell({ onController, onBusyChange, onThinkingLevelChange, onConversationStarted, embedded = false, understandingOpen, onUnderstandingOpenChange }: {
  onController?: (controller: CompanionController | null) => void;
  onBusyChange?: (busy: boolean) => void;
  onThinkingLevelChange?: (level: CompanionThinkingLevel) => void;
  onConversationStarted?: (started: boolean) => void;
  embedded?: boolean;
  understandingOpen: boolean;
  onUnderstandingOpenChange: (open: boolean) => void;
}) {
  const [messages, setMessages] = useState<CompanionMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [memoryNotices, setMemoryNotices] = useState<MemoryNotice[]>([]);
  const requestRef = useRef<AbortController | null>(null);

  useEffect(() => onBusyChange?.(busy), [busy, onBusyChange]);
  useEffect(() => onConversationStarted?.(messages.length > 0), [messages.length, onConversationStarted]);

  useEffect(() => {
    document.documentElement.dataset.companionTextSize = localStorage.getItem("companionTextSize") ?? "normal";
    document.documentElement.dataset.companionContrast = localStorage.getItem("companionContrast") ?? "normal";
    let mounted = true;
    void fetch("/api/companion", { cache: "no-store" }).then(async (response) => {
      if (!response.ok) throw new Error(companionErrorMessage(await response.text()));
      return response.json() as Promise<{ history?: Array<{ entryId?: string; role: "user" | "assistant"; text: string }>; config?: { thinkingLevel?: CompanionThinkingLevel } }>;
    }).then((data) => {
      if (!mounted) return;
      setMessages((data.history ?? []).map((message, index) => ({ ...message, id: `history-${index}` })));
      if (data.config?.thinkingLevel) onThinkingLevelChange?.(data.config.thinkingLevel);
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
          setStatus("");
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
  }, [onThinkingLevelChange]);

  const send = useCallback(async (rawText: string) => {
    const text = rawText.trim();
    if (!text || busy) return;
    const clientMessageId = newMessageId();
    setMessages((current) => [...current, { id: `user-${clientMessageId}`, role: "user", text }]);
    setBusy(true);
    setStatus("");
    setError("");
    const controller = new AbortController();
    requestRef.current = controller;
    try {
      const response = await fetch("/api/companion", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ clientMessageId, text }), signal: controller.signal });
      const data = await response.json() as { error?: string; turn?: { replyText?: string | null; status?: string } };
      if (!response.ok) throw new Error(companionErrorMessage(data.error ?? "暂时无法回复"));
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
      window.dispatchEvent(new Event("companion:history-changed"));
    } catch (cause) {
      if (!(cause instanceof DOMException && cause.name === "AbortError")) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      requestRef.current = null;
      setBusy(false);
    }
  }, [busy]);

  const stop = useCallback(async () => {
    requestRef.current?.abort();
    await fetch("/api/companion", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "stop" }) }).catch(() => undefined);
    setBusy(false);
    setStatus("已停止这次回复。");
  }, []);

  const compact = useCallback(async () => {
    const response = await fetch("/api/companion", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "compact" }) });
    if (!response.ok) throw new Error("无法整理当前陪伴对话，请稍后重试。");
    setStatus("已整理对话上下文。");
  }, []);

  const setThinkingLevel = useCallback(async (level: CompanionThinkingLevel) => {
    const response = await fetch("/api/companion", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "set_thinking_level", level }) });
    if (!response.ok) throw new Error("无法更改思考强度，请稍后重试。");
  }, []);

  useEffect(() => {
    onController?.({ send, stop, compact, setThinkingLevel });
    return () => onController?.(null);
  }, [onController, send, stop, compact, setThinkingLevel]);

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
    <main className={`companion-inline${embedded && messages.length === 0 ? " is-empty" : ""}`}>
      <section className="companion-messages" aria-live="polite" aria-label="与凡小忆的对话">
        {messages.length === 0 && <article className="companion-message is-assistant companion-welcome"><span className="companion-message-label">凡小忆 · AI</span><p>你好，我是凡小忆。想聊聊今天的心情，或任何你愿意分享的事吗？凡小忆是 AI，不能联系家人、报警、定位或进行现实救援。</p></article>}
        {messages.map((message) => <article className={`companion-message is-${message.role}${message.role === "assistant" && !message.text ? " is-pending" : ""}`} key={message.id}>{message.role === "assistant" && <span className="companion-message-label">凡小忆 · AI</span>}<p>{message.text || (message.buffered ? "正在核对，请稍等……" : "正在想一想……")}</p>{message.role === "user" && message.entryId && <button type="button" className="companion-privacy" onClick={() => void deleteSource(message)}>删除这条消息</button>}{message.incomplete && <small>未完成回复 · 不会作为下一次对话的依据</small>}{message.sources && message.sources.length > 0 && <details><summary>查看来源</summary><ul>{message.sources.map((source) => <li key={source.url}><a href={source.url} target="_blank" rel="noreferrer">{source.title}</a></li>)}</ul></details>}</article>)}
        {memoryNotices.map((memoryNotice) => <aside className="companion-notice companion-memory-notice" aria-live="polite" key={memoryNotice.id}><strong>{memoryNotice.confirmation ? "这是一项敏感信息，是否确认记住？" : "记忆回执"}</strong><p>{memoryNotice.content}</p><button type="button" className="companion-privacy" onClick={() => void memoryAction(memoryNotice, memoryNotice.confirmation ? "confirm_memory" : "delete_memory")}>{memoryNotice.confirmation ? "确认记住" : "撤销记忆"}</button>{memoryNotice.confirmation && <button type="button" className="companion-privacy" onClick={() => void memoryAction(memoryNotice, "delete_memory")}>不要记住</button>}</aside>)}
        {(status || error) && <p className={error ? "companion-error" : "companion-status"} role={error ? "alert" : "status"}>{error || status}</p>}
      </section>
      {understandingOpen && <CompanionUnderstandingPanel onClose={() => onUnderstandingOpenChange(false)} />}
    </main>
  );
}
