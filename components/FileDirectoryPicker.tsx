'use client';
import { useEffect, useState } from 'react';
import { encodeFilePathForApi, getFileDirectory, joinFilePath } from '@/lib/file-paths';
import { useI18n } from '@/hooks/useI18n';
export interface FileDirectoryPickerProps {
    cwd: string;
    onSelect: (path: string) => void;
    onCancel: () => void;
    disabledPaths?: string[];
    finalAction?: string;
}
export function FileDirectoryPicker({ cwd, onSelect, onCancel, disabledPaths = [], finalAction }: FileDirectoryPickerProps) {
    const { t } = useI18n();
    const [directory, setDirectory] = useState(cwd);
    const [entries, setEntries] = useState<string[]>([]);
    const [error, setError] = useState('');
    const [name, setName] = useState('');
    const [refresh, setRefresh] = useState(0);
    const [busy, setBusy] = useState(false);
    const disabled = (p: string) => disabledPaths.some(source => p === source || p.startsWith(source + '/'));
    useEffect(() => { let active = true; setEntries([]); setError(''); fetch(`/api/files/${encodeFilePathForApi(directory)}?type=list`).then(async (res) => { const data = await res.json(); if (!res.ok)
        throw new Error(data.error); if (active)
        setEntries((data.entries as {
            name: string;
            isDir: boolean;
        }[]).filter(e => e.isDir).map(e => e.name)); }).catch(e => { if (active)
        setError(String(e.message)); }); return () => { active = false; }; }, [directory, refresh]);
    async function create() { setBusy(true); setError(''); try {
        const res = await fetch('/api/files/operations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ operation: 'mkdir', cwd, target: directory, name }) });
        const data = await res.json();
        if (!res.ok)
            throw new Error(data.error);
        setRefresh(n => n + 1);
        setName('');
    }
    catch (e) {
        setError(e instanceof Error ? e.message : String(e));
    }
    finally {
        setBusy(false);
    } }
    return <div role="dialog" aria-modal="true" aria-label={t('files.chooseDirectory')} style={{ position: 'fixed', inset: 0, zIndex: 100, background: '#0008', display: 'grid', placeItems: 'center' }}><div style={{ background: 'var(--bg-panel)', color: 'var(--text)', padding: 20, width: 'min(420px,90vw)', maxHeight: '85vh', overflow: 'auto' }}>
 <h3>{t('files.chooseDirectory')}</h3><p style={{ overflowWrap: 'anywhere' }}>{directory}</p><button className="file-operation-button" onClick={() => setDirectory(cwd)}>{t('files.rootDirectory')}</button> <button className="file-operation-button" disabled={directory === cwd} onClick={() => setDirectory(getFileDirectory(directory))}>{t('files.parentDirectory')}</button>
 <div>{entries.map(entry => { const p = joinFilePath(directory, entry); return <button className="file-operation-button" key={entry} disabled={disabled(p)} style={{ display: 'block', width: '100%', textAlign: 'left', padding: 8 }} onClick={() => setDirectory(p)}>📁 {entry}</button>; })}</div>
 <input aria-label={t('files.newDirectory')} placeholder={t('files.newDirectory')} value={name} onChange={e => setName(e.target.value)}/><button className="file-operation-button" disabled={!name || busy} onClick={() => void create()}>{t('files.createDirectory')}</button>
 {error && <p role="alert">{error}</p>}<div style={{ marginTop: 12 }}><button className="file-operation-button" onClick={onCancel}>{t('files.cancel')}</button> <button className="file-operation-button" disabled={busy || disabled(directory)} onClick={() => onSelect(directory)}>{finalAction || t('files.moveHere')}</button></div>
 </div></div>;
}
