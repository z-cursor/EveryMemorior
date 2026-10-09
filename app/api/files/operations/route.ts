import { NextRequest, NextResponse } from 'next/server';
import { getAllowedFileRoots, isFilePathAllowed, isExistingFilePathAllowed } from '@/lib/file-access';
import { tenantWorkspaceRootsForRequest } from '@/lib/tenant-agent-runtime';
import { requireTenantSession, TenantAuthenticationError } from '@/lib/tenant-auth';
import { workspacePathFromClient, workspacePathToClient } from '@/lib/tenant-workspace';
import { getTenantStore } from '@/lib/tenant-store';
import { isWorkspaceMutationPathAllowed } from '@/lib/path-security';
import { samePath } from '@/lib/paths';
import { isApiRequestAllowed } from '@/lib/request-security';
import { executeFileOperations, fileUndoPaths } from '@/lib/file-operations';
import type { FileOperationRequest } from '@/lib/file-operation-types';
export async function POST(request: NextRequest) {
    if (!isApiRequestAllowed(request))
        return NextResponse.json({ error: 'Untrusted API request' }, { status: 403 });
    try {
        const session = requireTenantSession(request);
        const body = await request.json() as FileOperationRequest;
        if (!body || !['mkdir', 'move', 'delete', 'undo'].includes(body.operation) || typeof body.cwd !== 'string' || (body.paths !== undefined && (!Array.isArray(body.paths) || body.paths.length > 1000 || body.paths.some(p => typeof p !== 'string'))) || (body.target !== undefined && typeof body.target !== 'string') || (body.name !== undefined && typeof body.name !== 'string'))
            return NextResponse.json({ error: 'Invalid operation' }, { status: 400 });
        if ((body.strategy !== undefined && !['error','rename','skip','cancel'].includes(body.strategy)) || (body.tokens !== undefined && (!Array.isArray(body.tokens) || body.tokens.length > 1000 || body.tokens.some(t => typeof t !== 'string'))) || (body.operation === 'undo' && !body.tokens?.length)) return NextResponse.json({error:'Invalid operation'}, {status:400});
        if ([body.cwd, ...(body.paths || []), body.target || ''].some(value => value.split(/[\\/]/).some(part => part === '..' || part === '.'))) {
            return NextResponse.json({ error: 'Invalid path' }, { status: 400 });
        }
        const root = workspacePathFromClient(session, body.cwd);
        const global = await getAllowedFileRoots();
        const owned = tenantWorkspaceRootsForRequest(request);
        if (!root || !owned.some(p => samePath(p, root)) || !isFilePathAllowed(root, global) || !isExistingFilePathAllowed(root, new Set(owned)))
            return NextResponse.json({ error: 'Access denied' }, { status: 403 });
        const scope = `${session.tenant.id}:${session.membership.id}`;
        const undoPaths = body.operation === 'undo' ? fileUndoPaths(body.tokens || [], scope, root) : [];
        const paths = body.paths?.map(p => workspacePathFromClient(session, p));
        const target = body.target ? workspacePathFromClient(session, body.target) : undefined;
        if (paths?.some(p => !p || !isFilePathAllowed(p, new Set([root]))) || (body.target && (!target || !isFilePathAllowed(target, new Set([root])))))
            return NextResponse.json({ error: 'Access denied' }, { status: 403 });
        const otherRoots = getTenantStore().listActiveWorkspaces(session.tenant.id).map(workspace => workspace.rootPath).filter(p => !samePath(p, root));
        if ([...(paths || []), ...undoPaths].some(p => p && !isWorkspaceMutationPathAllowed(p, root, otherRoots, true))
            || (target && !isWorkspaceMutationPathAllowed(target, root, otherRoots))) {
            return NextResponse.json({ error: 'Access denied' }, { status: 403 });
        }
        const results = executeFileOperations({ ...body, paths: paths as string[] | undefined, target: target || undefined }, root, scope, otherRoots).map(item => ({ ...item, source: workspacePathToClient(session, item.source) || body.cwd, destination: item.destination ? workspacePathToClient(session, item.destination) || undefined : undefined }));
        return NextResponse.json({ results });
    }
    catch (error) {
        return NextResponse.json({ error: error instanceof TenantAuthenticationError ? error.message : 'File operation failed' }, { status: error instanceof TenantAuthenticationError ? 401 : 400 });
    }
}
