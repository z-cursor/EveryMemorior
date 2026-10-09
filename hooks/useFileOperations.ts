'use client';

import { useRef, useState } from 'react';
import type { FileOperationResult } from '@/lib/file-operation-types';

export function useFileOperations(cwd: string, onSuccess: (results: FileOperationResult[], target?: string) => void) {
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<FileOperationResult[]>([]);
  const [error, setError] = useState('');
  const currentWorkspace = useRef(cwd);
  currentWorkspace.current = cwd;

  async function perform(operation: 'move' | 'delete', paths: string[], target?: string) {
    const workspace = cwd;
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/files/operations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operation, cwd: workspace, paths, target }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      if (currentWorkspace.current !== workspace) return;
      setResults(data.results);
      onSuccess(data.results.filter((result: FileOperationResult) => result.status === 'success'), target);
    } catch (failure) {
      if (currentWorkspace.current === workspace) {
        setError(failure instanceof Error ? failure.message : String(failure));
      }
    } finally {
      setBusy(false);
    }
  }

  return { busy, results, error, perform, setResults, setError };
}
