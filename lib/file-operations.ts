import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { isExistingFilePathAllowed, isFilePathAllowed } from './file-access';
import { samePath } from './paths';
import type { FileOperationRequest, FileOperationResult } from './file-operation-types';

export const PROTECTED_FILE_NAMES = new Set(['node_modules', '.git', '.next', 'dist', 'build', '__pycache__', '.turbo', '.cache', 'coverage', '.pytest_cache', '.mypy_cache', 'target', 'vendor', '.DS_Store']);
export function isProtectedFilePath(root: string, value: string): boolean {
  return path.relative(root, value).split(path.sep).some(part => PROTECTED_FILE_NAMES.has(part));
}
interface UndoRecord { scope: string; root: string; source: string; destination: string; identity: string; parentIdentity: string; expires: number; }
declare global { var __piFileUndoRecords: Map<string, UndoRecord> | undefined; }
function records() { return globalThis.__piFileUndoRecords ??= new Map(); }
function identity(value: string) { const s = fs.lstatSync(value, { bigint: true }); return `${s.dev}:${s.ino}:${s.birthtimeNs}:${s.isDirectory() ? 'dir' : 'file'}`; }

/** Snapshot a tree without following symlinks; detect edits before deleting originals. */
function fingerprint(value: string): string {
  const hash = createHash('sha256');
  function visit(entry: string) {
    const stat = fs.lstatSync(entry, { bigint: true });
    hash.update(`${entry.slice(value.length)}:${stat.dev}:${stat.ino}:${stat.mode}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`);
    if (stat.isSymbolicLink()) hash.update(fs.readlinkSync(entry));
    else if (stat.isDirectory()) for (const name of fs.readdirSync(entry).sort()) visit(path.join(entry, name));
    else if (stat.isFile()) {
      const fd = fs.openSync(entry, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try { const buffer = Buffer.allocUnsafe(64 * 1024); let count: number; while ((count = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, count)); }
      finally { fs.closeSync(fd); }
    }
    else throw new Error('Unsupported item inside directory');
  }
  visit(value); return hash.digest('hex');
}
function copyChildren(source: string, destination: string) {
  for (const name of fs.readdirSync(source)) {
    const from = path.join(source, name); const to = path.join(destination, name); const stat = fs.lstatSync(from);
    if (stat.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(from), to);
    else if (stat.isDirectory()) { fs.mkdirSync(to, { mode: stat.mode }); copyChildren(from, to); fs.utimesSync(to, stat.atime, stat.mtime); }
    else if (stat.isFile()) { fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL); fs.chmodSync(to, stat.mode); fs.utimesSync(to, stat.atime, stat.mtime); }
    else throw new Error('Unsupported item inside directory');
  }
}
/** Exclusive creation never overwrites a racing destination. Directory movement
 * is copy-then-remove, with verification and cleanup before source removal. */
function moveExclusive(source: string, destination: string) {
  const stat = fs.lstatSync(source);
  if (stat.isFile()) {
    const sourceIdentity = identity(source);
    let before: string | undefined;
    try { fs.linkSync(source, destination); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
      before = fingerprint(source);
      fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(destination, stat.mode); fs.utimesSync(destination, stat.atime, stat.mtime);
    }
    const createdIdentity = identity(destination);
    try {
      if (identity(source) !== sourceIdentity || (before && fingerprint(source) !== before)) throw new Error('File changed during movement');
      fs.unlinkSync(source);
    } catch (error) { if (present(destination) && identity(destination) === createdIdentity) fs.unlinkSync(destination); throw error; }
    return;
  }
  const before = fingerprint(source);
  fs.mkdirSync(destination, { mode: stat.mode });
  const createdIdentity = identity(destination);
  try {
    copyChildren(source, destination);
    fs.utimesSync(destination, stat.atime, stat.mtime);
    if (fingerprint(source) !== before || identity(destination) !== createdIdentity) throw new Error('Directory changed during movement');
  } catch (error) {
    if (present(destination) && identity(destination) === createdIdentity) fs.rmSync(destination, { recursive: true });
    throw error;
  }
  // Keep the verified destination if source deletion fails, so content is never lost.
  try { fs.rmSync(source, { recursive: true, force: false }); }
  catch { throw new Error('Directory copied but source removal failed; inspect both locations'); }
}
function present(value: string) { try { fs.lstatSync(value); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e; } }
function renamed(destination: string, isDir: boolean, index: number) { const ext = isDir ? '' : path.extname(destination); return `${destination.slice(0, destination.length - ext.length)} (${index})${ext}`; }

export function fileUndoPaths(tokens: string[], scope: string, root: string): string[] {
  return tokens.flatMap(token => { const record = records().get(token); return record && record.scope === scope && samePath(record.root, root) && record.expires > Date.now() ? [record.source, record.destination] : []; });
}
export function executeFileOperations(input: FileOperationRequest, root: string, scope = ''): FileOperationResult[] {
  for (const [token, record] of records()) if (record.expires < Date.now()) records().delete(token);
  const roots = new Set([root]);
  function validate(value: string, existing = true) {
    if (!isFilePathAllowed(value, roots) || isProtectedFilePath(root, value) || (existing && !isExistingFilePathAllowed(value, roots))) throw new Error('Access denied');
    if (existing && fs.lstatSync(value).isSymbolicLink()) throw new Error('Symbolic links cannot be changed');
  }
  if (input.operation === 'mkdir') {
    const parent = input.target || root;
    validate(parent);
    if (!fs.statSync(parent).isDirectory()) throw new Error('Target is not a directory');
    if (!input.name || input.name === '.' || input.name === '..' || /[<>:"/\\|?*\x00-\x1f]/.test(input.name) || /[. ]$/.test(input.name)) throw new Error('Invalid directory name');
    const destination = path.join(parent, input.name); validate(destination, false); fs.mkdirSync(destination);
    return [{ source: parent, destination, status: 'success', isDir: true }];
  }
  const undo = input.operation === 'undo';
  const sources = [...new Set(undo ? input.tokens || [] : input.paths || [])];
  const normalized = undo ? sources : sources.filter(item => !sources.some(other => !samePath(item, other) && isFilePathAllowed(item, new Set([other]))));
  if (input.operation === 'move') { if (!input.target) throw new Error('Target directory required'); validate(input.target); if (!fs.statSync(input.target).isDirectory()) throw new Error('Target is not a directory'); }
  let stopped = false;
  return normalized.map(value => {
    const record = undo ? records().get(value) : undefined;
    const source = undo ? record?.destination || root : value;
    try {
      if (stopped || input.strategy === 'cancel') return { source, status: 'pending', error: 'Canceled; completed moves are kept' };
      if (undo && (!record || record.scope !== scope || !samePath(record.root, root) || record.expires <= Date.now())) throw new Error('Undo is unavailable');
      validate(source);
      if (samePath(source, root)) throw new Error('Workspace roots cannot be changed');
      const stat = fs.lstatSync(source);
      if (!stat.isFile() && !stat.isDirectory()) throw new Error('Only files and directories can be changed');
      if (input.operation === 'delete') { fs.rmSync(source, { recursive: stat.isDirectory() }); return { source, status: 'success', isDir: stat.isDirectory() }; }
      const original = undo ? record!.source : path.join(input.target!, path.basename(source));
      const target = path.dirname(original); validate(target);
      if (undo && (identity(source) !== record!.identity || identity(target) !== record!.parentIdentity)) throw new Error('Moved item or original parent was replaced; cannot undo');
      const realSource = fs.realpathSync(source); const realTarget = fs.realpathSync(target);
      if (stat.isDirectory() && isFilePathAllowed(realTarget, new Set([realSource]))) throw new Error('Cannot move a folder into itself');
      if (samePath(fs.realpathSync(path.dirname(source)), realTarget)) return { source, status: 'skipped', error: 'Already in target directory' };
      let destination = original; validate(destination, false);
      for (let index = 0; ; index++) {
        if (present(destination)) {
          if (input.strategy === 'skip') return { source, destination, status: 'skipped', error: 'Destination already exists' };
          if (input.strategy !== 'rename') { stopped = true; return { source, destination, status: 'conflict', error: 'Destination already exists' }; }
          destination = renamed(original, stat.isDirectory(), index + 1); continue;
        }
        try { moveExclusive(source, destination); break; } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          if (input.strategy !== 'rename') { stopped = true; return { source, destination, status: input.strategy === 'skip' ? 'skipped' : 'conflict', error: 'Destination already exists' }; }
        }
      }
      let undoToken: string | undefined;
      if (undo) records().delete(value);
      else {
        undoToken = randomUUID();
        records().set(undoToken, { scope, root, source, destination, identity: identity(destination), parentIdentity: identity(path.dirname(source)), expires: Date.now() + 24 * 60 * 60 * 1000 });
      }
      return { source, destination, status: 'success', isDir: stat.isDirectory(), undoToken };
    } catch (error) { return { source, status: 'failed', error: error instanceof Error && !('code' in error) ? error.message : 'File operation failed' }; }
  });
}
