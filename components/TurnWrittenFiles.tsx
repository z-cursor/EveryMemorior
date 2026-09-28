"use client";

import { useI18n } from "@/hooks/useI18n";
import { encodeFilePathForApi, getFileName } from "@/lib/file-paths";
import type { WrittenFile } from "@/lib/turn-written-files";
import { getFileIcon } from "./FileIcons";

/**
 * Lists the files a turn actually wrote, as buttons that open each one in the
 * preview pane. Entries come from the turn's successful `write`/`edit` tool
 * calls — the reply text is never scanned for paths.
 */
export function TurnWrittenFiles({ files, onOpenFile }: {
  files: WrittenFile[];
  onOpenFile?: (filePath: string) => void;
}) {
  const { t } = useI18n();
  if (files.length === 0) return null;

  return (
    <div aria-label={t("chat.filesWritten")} style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "var(--space-1-5)", marginTop: 6 }}>
      {files.map(({ filePath }) => {
        const name = getFileName(filePath);
        const downloadUrl = `/api/files/${encodeFilePathForApi(filePath)}?type=download`;
        const chipStyle = {
          display: "inline-flex",
          alignItems: "center",
          gap: "var(--space-1)",
          padding: "var(--space-0-5) var(--space-2)",
          fontSize: "var(--font-size-control)",
          fontFamily: "var(--font-mono)",
          color: "var(--text)",
          background: "var(--bg-subtle)",
          border: "var(--border-width) solid var(--border)",
          borderRadius: "var(--radius-control)",
        } as const;
        return (
          <span key={filePath} style={{ display: "inline-flex", alignItems: "center", gap: 2 }}>
            <button
              type="button"
              title={name}
              aria-label={t("chat.openWrittenFile", { name })}
              onClick={() => onOpenFile?.(filePath)}
              style={{ ...chipStyle, cursor: "pointer" }}
            >
              {getFileIcon(name, 12)}
              <span>{name}</span>
            </button>
            <a
              href={downloadUrl}
              download={name}
              title={t("i18n.downloadFile")}
              aria-label={`${t("i18n.downloadFile")}: ${name}`}
              style={{ ...chipStyle, padding: "var(--space-0-5)", cursor: "pointer" }}
            >
              ↓
            </a>
          </span>
        );
      })}
    </div>
  );
}
