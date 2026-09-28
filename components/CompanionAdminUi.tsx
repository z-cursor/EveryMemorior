"use client";

import { useId, type ReactNode } from "react";

export function AdminCard({ title, description, action, children, className = "" }: {
  title: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const id = useId();
  return (
    <section className={`admin-card ${className}`} aria-labelledby={id}>
      <header className="admin-card-heading">
        <div><h3 id={id}>{title}</h3>{description && <p>{description}</p>}</div>
        {action}
      </header>
      {children}
    </section>
  );
}

export function AdminBadge({ children, tone = "neutral" }: {
  children: ReactNode;
  tone?: "neutral" | "info" | "success" | "warning" | "danger";
}) {
  return <span className={`admin-badge is-${tone}`}>{children}</span>;
}

export function AdminEmpty({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <div className="admin-empty">
      <span className="admin-empty-icon" aria-hidden="true">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <rect x="4" y="3" width="16" height="18" rx="3" /><path d="M8 8h8M8 12h5M8 16h3" />
        </svg>
      </span>
      <strong>{title}</strong>
      <p>{children}</p>
      {action && <div className="admin-actions">{action}</div>}
    </div>
  );
}

export function AdminMetric({ label, value, detail }: { label: string; value: ReactNode; detail?: string }) {
  return <div className="admin-metric"><dt>{label}</dt><dd>{value}</dd>{detail && <p>{detail}</p>}</div>;
}

export function AdminFeedback({ error, notice, pending }: { error?: string; notice?: string; pending?: string | null }) {
  if (!error && !notice && !pending) return null;
  return (
    <div className={`admin-feedback ${error ? "is-error" : pending ? "is-pending" : "is-success"}`} role={error ? "alert" : "status"} aria-live={error ? "assertive" : "polite"}>
      {pending && !error && <span className="admin-spinner" aria-hidden="true" />}
      {error || pending || notice}
    </div>
  );
}

export const membershipLabels = { member: "陪伴成员（Member）", admin: "管理员（Admin）", owner: "所有者（Owner）" } as const;

export function adminDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("zh-CN", { dateStyle: "medium", timeStyle: "short" });
}
