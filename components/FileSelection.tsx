'use client';
import { createContext, useContext } from 'react';
export interface FileSelectionContextValue {
    selected: Set<string>;
    registerNode: (path: string, isDirectory: boolean) => void;
    toggle: (path: string, shift: boolean) => void;
}
export const FileSelectionContext = createContext<FileSelectionContextValue | null>(null);
export function FileSelectionCheckbox({ path, label }: {
    path: string;
    label: string;
}) { const state = useContext(FileSelectionContext); if (!state)
    return null; return <input type="checkbox" checked={state.selected.has(path)} aria-label={label} onClick={e => { e.stopPropagation(); state.toggle(path, e.shiftKey); }} onChange={() => { }}/>; }
