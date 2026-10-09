export type FileOperationStatus = 'success' | 'skipped' | 'failed' | 'conflict' | 'pending';
export interface FileOperationResult {
    source: string;
    status: FileOperationStatus;
    destination?: string;
    isDir?: boolean;
    error?: string;
    undoToken?: string;
}
export interface FileOperationRequest {
    operation: 'mkdir' | 'move' | 'delete';
    cwd: string;
    paths?: string[];
    target?: string;
    name?: string;
    strategy?: 'error' | 'rename' | 'skip' | 'cancel';
}
export interface FileOperationResponse {
    results: FileOperationResult[];
    error?: string;
}
