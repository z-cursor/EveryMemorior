import fs from 'node:fs';
import path from 'node:path';
import { isExistingFilePathAllowed, isFilePathAllowed } from './file-access';
import { samePath } from './paths';
import type { FileOperationRequest, FileOperationResult } from './file-operation-types';
export const PROTECTED_FILE_NAMES = new Set(['node_modules', '.git', '.next', 'dist', 'build', '__pycache__', '.turbo', '.cache', 'coverage', '.pytest_cache', '.mypy_cache', 'target', 'vendor', '.DS_Store']);
export function isProtectedFilePath(root: string, value: string): boolean {
    return path.relative(root, value).split(path.sep).some(part => PROTECTED_FILE_NAMES.has(part));
}
export function executeFileOperations(input: FileOperationRequest, root: string): FileOperationResult[] {
    const roots = new Set([root]);
    function validate(value: string, existing = true) {
        if (!isFilePathAllowed(value, roots) || isProtectedFilePath(root, value) || (existing && !isExistingFilePathAllowed(value, roots)))
            throw new Error('Access denied');
        if (existing && fs.lstatSync(value).isSymbolicLink())
            throw new Error('Symbolic links cannot be changed');
    }
    if (input.operation === 'mkdir') {
        const parent = input.target || root;
        validate(parent);
        if (!fs.statSync(parent).isDirectory())
            throw new Error('Target is not a directory');
        if (!input.name || input.name === '.' || input.name === '..' || /[<>:"/\\|?*\x00-\x1f]/.test(input.name) || /[. ]$/.test(input.name))
            throw new Error('Invalid directory name');
        const destination = path.join(parent, input.name);
        validate(destination, false);
        fs.mkdirSync(destination);
        return [{ source: parent, destination, status: 'success', isDir: true }];
    }
    const sources = [...new Set(input.paths || [])];
    const normalized = sources.filter(item => !sources.some(other => !samePath(item, other) && isFilePathAllowed(item, new Set([other]))));
    if (input.operation === 'move') {
        if (!input.target)
            throw new Error('Target directory required');
        validate(input.target);
        if (!fs.statSync(input.target).isDirectory())
            throw new Error('Target is not a directory');
    }
    return normalized.map(source => {
        try {
            validate(source);
            if (samePath(source, root))
                throw new Error('Workspace roots cannot be changed');
            const stat = fs.lstatSync(source);
            if (!stat.isFile() && !stat.isDirectory())
                throw new Error('Only files and directories can be changed');
            if (input.operation === 'delete') {
                fs.rmSync(source, { recursive: stat.isDirectory() });
                return { source, status: 'success', isDir: stat.isDirectory() };
            }
            const target = input.target!;
            if (stat.isDirectory() && isFilePathAllowed(target, new Set([source])))
                throw new Error('Cannot move a folder into itself');
            if (samePath(path.dirname(source), target))
                return { source, status: 'skipped', error: 'Already in target directory' };
            const destination = path.join(target, path.basename(source));
            validate(destination, false);
            if (fs.existsSync(destination))
                return { source, destination, status: 'conflict', error: 'Destination already exists' };
            fs.renameSync(source, destination);
            return { source, destination, status: 'success', isDir: stat.isDirectory() };
        }
        catch (error) {
            return { source, status: 'failed', error: error instanceof Error && !('code' in error) ? error.message : 'File operation failed' };
        }
    });
}
