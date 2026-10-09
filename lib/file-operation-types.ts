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
    operation: 'mkdir' | 'move' | 'delete' | 'undo';
    cwd: string;
    paths?: string[];
    tokens?: string[];
    target?: string;
    name?: string;
    strategy?: 'error' | 'rename' | 'skip' | 'cancel';
}
export interface FileOperationResponse {
    results: FileOperationResult[];
    error?: string;
}
