import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";
import { NextRequest } from "next/server.js";

const root = mkdtempSync(join(tmpdir(), "pi-web-file-delete-"));
const previousDatabase = process.env.PI_WEB_DATABASE_PATH;
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_WEB_DATABASE_PATH = join(root, "tenant.sqlite");
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true, moduleCache: false });
const { setupTenantOwner, TENANT_SESSION_COOKIE } = await jiti.import("../../../../lib/tenant-auth.ts");
const { getTenantStore, closeTenantStore } = await jiti.import("../../../../lib/tenant-store.ts");
const { allowFileRoot } = await jiti.import("../../../../lib/file-access.ts");
const { POST } = await jiti.import("./route.ts");

const auth = await setupTenantOwner({
  tenantName: "Delete", tenantSlug: "delete", displayName: "Owner",
  email: "owner@delete.test", password: "correct horse battery staple",
});
const workspace = join(root, "workspace");
mkdirSync(workspace, { recursive: true });
allowFileRoot(workspace);
getTenantStore().ensureWorkspace(
  { tenantId: auth.session.tenant.id, membershipId: auth.session.membership.id },
  { name: "Workspace", rootPath: workspace },
);

after(() => {
  closeTenantStore();
  if (previousDatabase === undefined) delete process.env.PI_WEB_DATABASE_PATH;
  else process.env.PI_WEB_DATABASE_PATH = previousDatabase;
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(root, { recursive: true, force: true });
});

function request(body) {
 return new NextRequest("http://localhost/api/files/operations", {method:"POST", headers:{Cookie:`${TENANT_SESSION_COOKIE}=${auth.token}`,Host:"localhost", "Content-Type":"application/json"},body:JSON.stringify(body)});
}
test("moves a mixed selection once, preserving content and removing originals", async()=>{
 const folder=join(workspace,"folder"); mkdirSync(folder); writeFileSync(join(folder,"note.txt"),"hello");
 const target=join(workspace,"destination"); mkdirSync(target);
 const response=await POST(request({operation:"move",cwd:workspace,paths:[folder,join(folder,"note.txt")],target}));
 assert.equal(response.status,200); const data=await response.json(); assert.equal(data.results.length,1); assert.equal(data.results[0].status,"success"); assert.equal(existsSync(folder),false); assert.equal(existsSync(join(target,"folder","note.txt")),true);
});

test('refuses cross-workspace inputs, protected paths and missing authentication', async()=>{
 const foreign=join(root,'other');mkdirSync(foreign);allowFileRoot(foreign);getTenantStore().ensureWorkspace({tenantId:auth.session.tenant.id,membershipId:auth.session.membership.id},{name:'Other',rootPath:foreign});
 const note=join(workspace,'outside.txt');writeFileSync(note,'protected');
 const cross=await POST(request({operation:'move',cwd:workspace,paths:[note],target:foreign}));assert.equal(cross.status,403);assert.equal(existsSync(note),true);
 const protectedFolder=join(workspace,'.git');mkdirSync(protectedFolder);writeFileSync(join(protectedFolder,'config'),'private');
 const denied=await POST(request({operation:'delete',cwd:workspace,paths:[protectedFolder]}));assert.equal((await denied.json()).results[0].status,'failed');assert.equal(existsSync(protectedFolder),true);
 const unauth=await POST(new NextRequest('http://localhost/api/files/operations',{method:'POST',headers:{Host:'localhost'},body:JSON.stringify({operation:'delete',cwd:workspace,paths:[note]})}));assert.equal(unauth.status,401);
});

test('creates a selected directory, rejects existing/invalid names, and deletes normalized batches despite a missing item',async()=>{
 const response=await POST(request({operation:'mkdir',cwd:workspace,target:workspace,name:'New folder'}));assert.equal(response.status,200);assert.equal(existsSync(join(workspace,'New folder')),true);
 assert.equal((await POST(request({operation:'mkdir',cwd:workspace,target:workspace,name:'New folder'}))).status,400);
 assert.equal((await POST(request({operation:'mkdir',cwd:workspace,target:workspace,name:'../escape'}))).status,400);
 const folder=join(workspace,'New folder');const note=join(folder,'child.txt');writeFileSync(note,'data');
 const deleted=await POST(request({operation:'delete',cwd:workspace,paths:[folder,note,join(workspace,'missing.txt')]}));
 const data=await deleted.json();assert.deepEqual(data.results.map(r=>r.status),['success','failed']);assert.equal(existsSync(folder),false);
});

test('does not overwrite conflicts and rejects self/descendant targets; same parent skips',async()=>{
 const folder=join(workspace,'Parent');mkdirSync(folder);const child=join(folder,'Child');mkdirSync(child);writeFileSync(join(folder,'keep.txt'),'original');
 const self=await POST(request({operation:'move',cwd:workspace,paths:[folder],target:child}));assert.equal((await self.json()).results[0].status,'failed');
 const skipped=await POST(request({operation:'move',cwd:workspace,paths:[folder],target:workspace}));assert.equal((await skipped.json()).results[0].status,'skipped');
 const destination=join(workspace,'Destination2');mkdirSync(destination);mkdirSync(join(destination,'Parent'));writeFileSync(join(destination,'Parent','keep.txt'),'other');
 const conflict=await POST(request({operation:'move',cwd:workspace,paths:[folder],target:destination}));assert.equal((await conflict.json()).results[0].status,'conflict');assert.equal(existsSync(folder),true);
});

test('cannot delete a folder containing another current workspace',async()=>{
 const container=join(workspace,'Container');const nested=join(container,'Nested');mkdirSync(nested,{recursive:true});writeFileSync(join(nested,'private.txt'),'preserve');
 getTenantStore().ensureWorkspace({tenantId:auth.session.tenant.id,membershipId:auth.session.membership.id},{name:'Nested',rootPath:nested});
 const response=await POST(request({operation:'delete',cwd:workspace,paths:[container]}));assert.equal(response.status,403);assert.equal(existsSync(nested),true);
});
