import type { FileOperationResult } from "@/lib/file-operation-types";
import { getFileName } from "@/lib/file-paths";
import type { FileViewerState } from "@/lib/file-viewer-state";
import type { Tab } from "./TabBar";

interface OpenFileTabInput {
  fileName: string;
  filePath: string;
  modeHint?: "diff";
  sourceSessionId?: string | null;
  tabId: string;
}

export function openFileTab(tabs: Tab[], input: OpenFileTabInput): Tab[] {
  const existing = tabs.find((tab) => tab.id === input.tabId);
  if (!existing) {
    return [...tabs, {
      id: input.tabId,
      label: input.fileName,
      filePath: input.filePath,
      sourceSessionId: input.sourceSessionId,
      initialDisplayMode: input.modeHint,
      viewerState: input.modeHint ? {
        displayMode: input.modeHint,
        wrapLines: false,
        scrollTop: 0,
        scrollLeft: 0,
      } : undefined,
      viewerRevision: 0,
    }];
  }

  const sourceChanged = Boolean(
    input.sourceSessionId && existing.sourceSessionId !== input.sourceSessionId,
  );
  const sourceUnchanged = !sourceChanged;
  if (sourceUnchanged && !input.modeHint) return tabs;

  return tabs.map((tab) => {
    if (tab.id !== input.tabId) return tab;
    const next: Tab = { ...tab };
    if (sourceChanged) next.sourceSessionId = input.sourceSessionId;
    if (input.modeHint) {
      next.initialDisplayMode = input.modeHint;
      next.viewerState = {
        displayMode: input.modeHint,
        wrapLines: tab.viewerState?.wrapLines ?? false,
        scrollTop: 0,
        scrollLeft: 0,
      };
      next.viewerRevision = (tab.viewerRevision ?? 0) + 1;
    } else if (sourceChanged) {
      next.viewerRevision = (tab.viewerRevision ?? 0) + 1;
    }
    return next;
  });
}

export function saveFileViewerState(
  tabs: Tab[],
  tabId: string,
  viewerRevision: number,
  viewerState: FileViewerState,
): Tab[] {
  const index = tabs.findIndex((tab) => tab.id === tabId);
  if (index === -1 || (tabs[index].viewerRevision ?? 0) !== viewerRevision) return tabs;

  const next = [...tabs];
  next[index] = { ...next[index], viewerState };
  return next;
}

/** Apply successful filesystem mappings to live previews, including directory descendants. */
export function movedPreviewPath(path: string, results: FileOperationResult[]): string {
  const match = results.find(result => result.status === 'success' && result.destination &&
    (path === result.source || (result.isDir && path.startsWith(result.source + '/'))));
  return match ? match.destination! + path.slice(match.source.length) : path;
}

export function remapMovedFileTabs(tabs: Tab[], results: FileOperationResult[]): Tab[] {
  return tabs.map(tab => {
    if (!tab.filePath) return tab;
    const filePath = movedPreviewPath(tab.filePath, results);
    return filePath === tab.filePath ? tab : {...tab, id: `file:${filePath}`, filePath,
      label: getFileName(filePath), viewerRevision: (tab.viewerRevision ?? 0) + 1};
  });
}

export function remapMovedActiveTab(id: string | null, results: FileOperationResult[]): string | null {
  return id?.startsWith('file:') ? `file:${movedPreviewPath(id.slice(5), results)}` : id;
}
