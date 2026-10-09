import { NextRequest, NextResponse } from 'next/server';
import { getAllowedFileRoots, isFilePathAllowed, isExistingFilePathAllowed } from '@/lib/file-access';
import { tenantWorkspaceRootsForRequest } from '@/lib/tenant-agent-runtime';
import { requireTenantSession, TenantAuthenticationError } from '@/lib/tenant-auth';
import { workspacePathFromClient, workspacePathToClient } from '@/lib/tenant-workspace';
import { getTenantStore } from '@/lib/tenant-store';
import { samePath } from '@/lib/paths';
import { isApiRequestAllowed } from '@/lib/request-security';
import { executeFileOperations } from '@/lib/file-operations';
import type { FileOperationRequest } from '@/lib/file-operation-types';
export async function POST(request: NextRequest) {
    if (!isApiRequestAllowed(request))
        return NextResponse.json({ error: 'Untrusted API request' }, { status: 403 });
    try {
        const session = requireTenantSession(request);
        const body = await request.json() as FileOperationRequest;
        if (!body || !['mkdir', 'move', 'delete'].includes(body.operation) || typeof body.cwd !== 'string' || (body.paths !== undefined && (!Array.isArray(body.paths) || body.paths.length > 1000 || body.paths.some(p => typeof p !== 'string'))) || (body.target !== undefined && typeof body.target !== 'string') || (body.name !== undefined && typeof body.name !== 'string'))
            return NextResponse.json({ error: 'Invalid operation' }, { status: 400 });
        if ([body.cwd, ...(body.paths || []), body.target || ''].some(value => value.split(/[\\/]/).some(part => part === '..' || part === '.'))) {
            return NextResponse.json({ error: 'Invalid path' }, { status: 400 });
        }
        const root = workspacePathFromClient(session, body.cwd);
        const global = await getAllowedFileRoots();
        const owned = tenantWorkspaceRootsForRequest(request);
        if (!root || !owned.some(p => samePath(p, root)) || !isFilePathAllowed(root, global) || !isExistingFilePathAllowed(root, new Set(owned)))
            return NextResponse.json({ error: 'Access denied' }, { status: 403 });
        const paths = body.paths?.map(p => workspacePathFromClient(session, p));
        const target = body.target ? workspacePathFromClient(session, body.target) : undefined;
        if (paths?.some(p => !p || !isFilePathAllowed(p, new Set([root]))) || (body.target && (!target || !isFilePathAllowed(target, new Set([root])))))
            return NextResponse.json({ error: 'Access denied' }, { status: 403 });
        const otherRoots = getTenantStore().listActiveWorkspaces(session.tenant.id).map(workspace => workspace.rootPath).filter(p => !samePath(p, root) && isFilePathAllowed(p, new Set([root])));
        if ([...(paths || []), target].some(p => p && otherRoots.some(other => isFilePathAllowed(p, new Set([other])))))
            return NextResponse.json({ error: 'Access denied' }, { status: 403 });
        if ((paths || []).some(source => source && otherRoots.some(other => isFilePathAllowed(other, new Set([source]))))) {
            return NextResponse.json({ error: 'Access denied' }, { status: 403 });
        }
        const results = executeFileOperations({ ...body, paths: paths as string[] | undefined, target: target || undefined }, root).map(item => ({ ...item, source: workspacePathToClient(session, item.source) || body.cwd, destination: item.destination ? workspacePathToClient(session, item.destination) || undefined : undefined }));
        return NextResponse.json({ results });
    }
    catch (error) {
        return NextResponse.json({ error: error instanceof TenantAuthenticationError ? error.message : 'File operation failed' }, { status: error instanceof TenantAuthenticationError ? 401 : 400 });
    }
}
