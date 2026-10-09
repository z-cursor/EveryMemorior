"use client";

import { useEffect, useRef, useState, type DragEvent, type RefObject } from "react";

import { droppedUploadFiles } from "@/lib/browser-drop-files";

const INTERNAL_FILES = "application/x-everymemorior-files";
interface DragFeedback {
  operation: "move" | "upload";
  count: number;
  target: string | null;
}
interface Options {
  container: RefObject<HTMLDivElement | null>;
  cwd: string;
  selected: Set<string>;
  busy: boolean;
  expand: (path: string) => void;
  move: (paths: string[], target: string) => void;
  upload: (files: File[], target: string) => void;
  uploadError: (message: string) => void;
}

function scrollContainer(element: HTMLElement): HTMLElement | null {
  for (let parent: HTMLElement | null = element; parent; parent = parent.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(parent).overflowY) && parent.scrollHeight > parent.clientHeight) return parent;
  }
  return null;
}

/** One drag session owns its source snapshot, target, hover timer and scroll loop. */
export function useFileExplorerDrag(options: Options) {
  const current = useRef(options);
  current.current = options;
  const [feedback, setFeedback] = useState<DragFeedback | null>(null);
  const session = useRef<{ operation: "move" | "upload"; paths: string[]; directories: string[]; count: number; cwd: string } | null>(null);
  const cancelled = useRef(false);
  const hovered = useRef<string | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollFrame = useRef<number | null>(null);
  const pointerY = useRef(0);

  function clearMotion() {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    hoverTimer.current = null;
    hovered.current = null;
    if (scrollFrame.current !== null) cancelAnimationFrame(scrollFrame.current);
    scrollFrame.current = null;
  }

  function reset() {
    clearMotion();
    session.current = null;
    setFeedback(null);
  }

  useEffect(() => {
    function escape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      cancelled.current = true;
      clearMotion();
      setFeedback(null);
    }
    window.addEventListener("keydown", escape);
    return () => { window.removeEventListener("keydown", escape); clearMotion(); };
  }, []);

  useEffect(() => {
    cancelled.current = true;
    reset();
    // The drag snapshot is scoped to the workspace in which it started.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options.cwd]);

  function ensureSession(event: DragEvent) {
    if (session.current) return session.current;
    if (!Array.from(event.dataTransfer.types).includes("Files")) return null;
    session.current = { operation: "upload", paths: [], directories: [], count: event.dataTransfer.items.length || event.dataTransfer.files.length, cwd: current.current.cwd };
    cancelled.current = false;
    return session.current;
  }

  function destination(event: DragEvent): string | null {
    const state = session.current;
    if (!state || current.current.busy || cancelled.current || state.cwd !== current.current.cwd) return null;
    const element = event.target instanceof Element ? event.target : null;
    if (!element || !current.current.container.current?.contains(element)) return null;
    // Toolbar, search and operation dialogs are controls, never a blank drop surface.
    if (element.closest('[data-file-drop-controls], [role="dialog"]')) return null;
    const row = element.closest<HTMLElement>('[data-file-path]');
    let target: string | null = null;
    if (row) {
      if (row.dataset.fileDirectory === "true") target = row.dataset.filePath!;
    } else if (element.closest('[data-file-drop-root]') || state.operation === "upload") {
      target = current.current.cwd;
    }
    if (target && state.operation === "move" && state.directories.some(path => target === path || target.startsWith(path + '/'))) return null;
    return target;
  }

  function motion(event: DragEvent, target: string | null) {
    if (hovered.current !== target) {
      if (hoverTimer.current) clearTimeout(hoverTimer.current);
      hovered.current = target;
      hoverTimer.current = target && target !== current.current.cwd ? setTimeout(() => {
        if (!cancelled.current) current.current.expand(target);
      }, 700) : null;
    }
    pointerY.current = event.clientY;
    if (scrollFrame.current !== null) return;
    const scroll = () => {
      const container = current.current.container.current;
      const scroller = container ? scrollContainer(container) : null;
      if (scroller && session.current && !cancelled.current) {
        const bounds = scroller.getBoundingClientRect();
        const distance = 32;
        const y = pointerY.current;
        const speed = y < bounds.top + distance ? -Math.min(12, (bounds.top + distance - y) / 2) : y > bounds.bottom - distance ? Math.min(12, (y - bounds.bottom + distance) / 2) : 0;
        if (y >= bounds.top && y <= bounds.bottom) scroller.scrollTop += speed;
      }
      scrollFrame.current = requestAnimationFrame(scroll);
    };
    scrollFrame.current = requestAnimationFrame(scroll);
  }

  const handlers = {
    onDragStart(event: DragEvent<HTMLDivElement>) {
      const element = event.target instanceof Element ? event.target : null;
      const row = element?.closest<HTMLElement>('[data-file-path]');
      if (!row || current.current.busy || element?.closest('button,input')) { event.preventDefault(); return; }
      const path = row.dataset.filePath!;
      const paths = current.current.selected.has(path) ? [...current.current.selected] : [path];
      const directories = paths.filter(value => current.current.container.current?.querySelector(`[data-file-path="${CSS.escape(value)}"]`)?.getAttribute('data-file-directory') === 'true');
      session.current = { operation: "move", paths, directories, count: paths.length, cwd: current.current.cwd };
      cancelled.current = false;
      event.dataTransfer.setData(INTERNAL_FILES, path);
      event.dataTransfer.effectAllowed = "move";
      setFeedback({ operation: "move", count: paths.length, target: null });
    },
    onDragEnter(event: DragEvent<HTMLDivElement>) {
      if (ensureSession(event)) event.preventDefault();
    },
    onDragOver(event: DragEvent<HTMLDivElement>) {
      const state = ensureSession(event);
      if (!state) return;
      event.preventDefault();
      const target = destination(event);
      event.dataTransfer.dropEffect = target ? state.operation === "move" ? "move" : "copy" : "none";
      if (!cancelled.current) setFeedback({ operation: state.operation, count: state.count, target });
      motion(event, target);
    },
    onDragLeave(event: DragEvent<HTMLDivElement>) {
      const container = current.current.container.current;
      if (event.relatedTarget instanceof Node && container?.contains(event.relatedTarget)) return;
      const bounds = container?.getBoundingClientRect();
      if (bounds && event.clientX >= bounds.left && event.clientX <= bounds.right && event.clientY >= bounds.top && event.clientY <= bounds.bottom) return;
      clearMotion();
      setFeedback(null);
      if (session.current?.operation === 'upload') { session.current = null; cancelled.current = false; }
    },
    onDrop(event: DragEvent<HTMLDivElement>) {
      const state = ensureSession(event);
      if (!state) return;
      event.preventDefault();
      const target = destination(event);
      const files = state.operation === "upload" && target ? droppedUploadFiles(event.dataTransfer) : null;
      const owner = current.current;
      reset();
      if (!target) return;
      if (state.operation === "move") current.current.move(state.paths, target);
      else if (files) void files.then(collected => {
        if (current.current.cwd === state.cwd) owner.upload(collected, target);
      }).catch(error => {if(current.current.cwd === state.cwd) owner.uploadError(error instanceof Error ? error.message : String(error));});
    },
    onDragEnd() { reset(); cancelled.current = false; },
  };
  return { handlers, feedback };
}
