'use client';

import { useEffect, useRef, useState } from 'react';
import { normalizeFileSelection } from '@/lib/file-selection';
import type { FileOperationResult } from '@/lib/file-operation-types';
type Choice = 'rename' | 'skip' | 'cancel';
export function useFileOperations(cwd: string, onSuccess: (results: FileOperationResult[], target?: string) => void) {
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<FileOperationResult[]>([]);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState<FileOperationResult | null>(null);
  const [undoState, setUndoState] = useState<{ cwd: string; tokens: string[] } | null>(null);
  const currentWorkspace = useRef(cwd); currentWorkspace.current = cwd;
  const canceled = useRef(false);
  const resolveChoice = useRef<((value: { choice: Choice; remaining: boolean }) => void) | null>(null);
  useEffect(() => {
    setUndoState(null);
    setConflict(null);
    return () => { canceled.current = true; resolveChoice.current?.({ choice: 'cancel', remaining: false }); };
  }, [cwd]);
  function chooseConflict(choice: Choice, remaining: boolean) { resolveChoice.current?.({ choice, remaining }); resolveChoice.current = null; setConflict(null); }
  function cancel() { canceled.current = true; chooseConflict('cancel', false); }
  async function perform(operation: 'move' | 'delete' | 'undo', paths: string[], target?: string) {
    if (busy) return;
    const workspace = cwd; const done: FileOperationResult[] = []; let strategy: Choice | undefined;
    const normalized = operation === 'undo' ? paths : normalizeFileSelection(paths);
    canceled.current = false; setBusy(true); setError(''); setResults([]);
    async function request(item: string, choice?: Choice) {
      const response = await fetch('/api/files/operations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ operation, cwd: workspace, paths: operation === 'undo' ? undefined : [item], tokens: operation === 'undo' ? [item] : undefined, target, strategy: choice }) });
      const data = await response.json(); if (!response.ok) throw new Error(data.error);
      return data.results[0] as FileOperationResult;
    }
    try {
      for (const item of normalized) {
        if (currentWorkspace.current !== workspace || canceled.current) break;
        let result: FileOperationResult;
        try { result = await request(item, strategy); }
        catch (failure) { done.push({ source: operation === 'undo' ? '' : item, status: 'failed', error: failure instanceof Error ? failure.message : String(failure) }); setResults([...done]); continue; }
        while (result.status === 'conflict') {
          if (currentWorkspace.current !== workspace || canceled.current) break;
          setConflict(result);
          const selection = await new Promise<{ choice: Choice; remaining: boolean }>(resolve => { resolveChoice.current = resolve; });
          if (selection.choice === 'cancel') { canceled.current = true; break; }
          if (selection.remaining) strategy = selection.choice;
          try { result = await request(item, selection.choice); }
          catch (failure) { result = { source: result.source, status: 'failed', error: failure instanceof Error ? failure.message : String(failure) }; break; }
        }
        if (currentWorkspace.current !== workspace) break;
        if (canceled.current && result.status === 'conflict') { done.push({ ...result, status: 'pending', error: 'Canceled; completed moves are kept' }); break; }
        done.push(result); setResults([...done]);
        if (result.status === 'success') onSuccess([result], target || (result.destination ? result.destination.slice(0, result.destination.lastIndexOf('/')) : undefined));
        if (canceled.current) break;
      }
      if (currentWorkspace.current === workspace) {
        if (canceled.current) { const processed = done.length; normalized.slice(processed).forEach(item => done.push({ source: operation === 'undo' ? '' : item, status: 'pending', error: 'Canceled; completed moves are kept' })); }
        setResults([...done]);
        if (operation === 'move') { const tokens = done.flatMap(r => r.undoToken ? [r.undoToken] : []); if (tokens.length) setUndoState({ cwd: workspace, tokens }); }
        if (operation === 'undo') { const tokens = normalized.filter((_, index) => done[index]?.status !== 'success'); setUndoState(tokens.length ? { cwd: workspace, tokens } : null); }
      }
    } catch (failure) { if (currentWorkspace.current === workspace) { setError(failure instanceof Error ? failure.message : String(failure)); if (operation === 'move') { const tokens = done.flatMap(r => r.undoToken ? [r.undoToken] : []); if (tokens.length) setUndoState({ cwd: workspace, tokens }); } } }
    finally { setBusy(false); setConflict(null); resolveChoice.current = null; }
  }
  return { busy, results, error, perform, setResults, setError, conflict, chooseConflict, cancel, canUndo: undoState?.cwd === cwd && !!undoState.tokens.length, undo: () => undoState?.cwd === cwd ? perform('undo', undoState.tokens) : Promise.resolve() };
}
