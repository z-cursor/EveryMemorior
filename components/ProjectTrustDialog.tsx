"use client";

import { useI18n } from "@/hooks/useI18n";

export function ProjectTrustDialog({
  cwd,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  cwd: string;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useI18n();

  return (
    <div
      role="presentation"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1100,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
        background: "rgba(0,0,0,0.4)",
      }}
      onClick={(event) => {
        if (!busy && event.target === event.currentTarget) onCancel();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-trust-title"
        style={{
          width: 440,
          maxWidth: "100%",
          border: "var(--border-width) solid var(--border)",
          borderRadius: "var(--radius-panel)",
          background: "var(--bg-panel)",
          boxShadow: "0 12px 36px rgba(0,0,0,0.24)",
          overflow: "hidden",
        }}
      >
        <div style={{ display: "flex", gap: "var(--space-3)", padding: "var(--space-4-5) var(--space-4-5) var(--space-3-5)" }}>
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="var(--palette-amber-500)"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            style={{ flexShrink: 0, marginTop: 1 }}
          >
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" />
            <path d="m9 12 2 2 4-4" />
          </svg>
          <div style={{ minWidth: 0 }}>
            <div id="project-trust-title" style={{ fontSize: "var(--font-size-title)", fontWeight: 700, color: "var(--text)" }}>
              {t("trust.dialogTitle")}
            </div>
            <div style={{ marginTop: 7, fontSize: "var(--font-size-control)", lineHeight: 1.6, color: "var(--text-muted)" }}>
              {t("trust.dialogBody")}
            </div>
            <code
              style={{
                display: "block",
                marginTop: 10,
                padding: "var(--space-2) var(--space-2-5)",
                border: "var(--border-width) solid var(--border)",
                borderRadius: "var(--radius-item)",
                background: "var(--bg)",
                color: "var(--text)",
                fontFamily: "var(--font-mono)",
                fontSize: "var(--font-size-meta)",
                overflowWrap: "anywhere",
              }}
            >
              {cwd}
            </code>
            {error && (
              <div role="alert" style={{ marginTop: 10, color: "var(--palette-red-500)", fontSize: "var(--font-size-control)", lineHeight: 1.5 }}>
                {error}
              </div>
            )}
          </div>
        </div>
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: "var(--space-2)",
            padding: "var(--space-2-5) var(--space-4-5)",
            borderTop: "var(--border-width) solid var(--border)",
          }}
        >
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            style={{
              height: 32,
              padding: "0 var(--space-3)",
              border: "var(--border-width) solid var(--border)",
              borderRadius: "var(--radius-item)",
              background: "transparent",
              color: "var(--text-muted)",
              cursor: busy ? "not-allowed" : "pointer",
              fontSize: "var(--font-size-control)",
            }}
          >
            {t("trust.cancel")}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            style={{
              height: 32,
              padding: "0 var(--space-3)",
              border: "var(--border-width) solid var(--accent)",
              borderRadius: "var(--radius-item)",
              background: "var(--accent)",
              color: "var(--accent-contrast)",
              cursor: busy ? "wait" : "pointer",
              opacity: busy ? 0.7 : 1,
              fontSize: "var(--font-size-control)",
              fontWeight: 600,
            }}
          >
            {busy ? t("trust.trusting") : t("trust.trustProject")}
          </button>
        </div>
      </div>
    </div>
  );
}
