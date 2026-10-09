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

test('renames a colliding directory as a whole and issues scoped undo restoring content',async()=>{
 const source=join(workspace,'Trips');mkdirSync(source);writeFileSync(join(source,'note.txt'),'mine');
 const target=join(workspace,'Archive');mkdirSync(target);mkdirSync(join(target,'Trips'));writeFileSync(join(target,'Trips','note.txt'),'existing');
 const moved=await POST(request({operation:'move',cwd:workspace,paths:[source],target,strategy:'rename'}));const result=(await moved.json()).results[0];
 assert.equal(result.status,'success');assert.equal(result.destination,join(target,'Trips (1)'));assert.ok(result.undoToken);assert.equal(existsSync(source),false);
 const undo=await POST(request({operation:'undo',cwd:workspace,tokens:[result.undoToken]}));assert.equal((await undo.json()).results[0].status,'success');assert.equal(existsSync(join(source,'note.txt')),true);
});

test('pauses at conflicts, preserves completed moves on cancel, and skips without overwriting',async()=>{
 const a=join(workspace,'first.txt'),b=join(workspace,'second.txt'),c=join(workspace,'third.txt');for(const p of [a,b,c])writeFileSync(p,'source');
 const target=join(workspace,'Batch');mkdirSync(target);writeFileSync(join(target,'second.txt'),'existing');
 const data=await (await POST(request({operation:'move',cwd:workspace,paths:[a,b,c],target}))).json();assert.deepEqual(data.results.map(r=>r.status),['success','conflict','pending']);assert.equal(existsSync(a),false);assert.equal(existsSync(c),true);
 const canceled=await (await POST(request({operation:'move',cwd:workspace,paths:[b,c],target,strategy:'cancel'}))).json();assert.deepEqual(canceled.results.map(r=>r.status),['pending','pending']);
 const skipped=await (await POST(request({operation:'move',cwd:workspace,paths:[b,c],target,strategy:'skip'}))).json();assert.deepEqual(skipped.results.map(r=>r.status),['skipped','success']);assert.equal(existsSync(b),true);
});

test('undo handles new original conflicts, replaced objects and reused tokens safely',async()=>{
 const source=join(workspace,'restore.txt');writeFileSync(source,'original');const target=join(workspace,'Undo');mkdirSync(target);
 const moved=(await (await POST(request({operation:'move',cwd:workspace,paths:[source],target}))).json()).results[0];writeFileSync(source,'new');
 const conflict=(await (await POST(request({operation:'undo',cwd:workspace,tokens:[moved.undoToken]}))).json()).results[0];assert.equal(conflict.status,'conflict');
 const restored=(await (await POST(request({operation:'undo',cwd:workspace,tokens:[moved.undoToken],strategy:'rename'}))).json()).results[0];assert.equal(restored.destination,join(workspace,'restore (1).txt'));assert.equal(restored.status,'success');
 const repeat=(await (await POST(request({operation:'undo',cwd:workspace,tokens:[moved.undoToken]}))).json()).results[0];assert.equal(repeat.status,'failed');
 const source2=join(workspace,'replaced.txt');writeFileSync(source2,'before');const moved2=(await (await POST(request({operation:'move',cwd:workspace,paths:[source2],target}))).json()).results[0];rmSync(moved2.destination);writeFileSync(moved2.destination,'replacement');
 const replaced=(await (await POST(request({operation:'undo',cwd:workspace,tokens:[moved2.undoToken]}))).json()).results[0];assert.equal(replaced.status,'failed');assert.equal(existsSync(source2),false);
});

test('undo rejects a replacement original parent and tokens scoped to a different workspace',async()=>{
 const parent=join(workspace,'Old parent');mkdirSync(parent);const source=join(parent,'note.txt');writeFileSync(source,'keep');const target=join(workspace,'Secure undo');mkdirSync(target);
 const moved=(await (await POST(request({operation:'move',cwd:workspace,paths:[source],target}))).json()).results[0];
 const other=join(root,'other');const wrong=(await (await POST(request({operation:'undo',cwd:other,tokens:[moved.undoToken]}))).json()).results[0];assert.equal(wrong.status,'failed');
 rmSync(parent,{recursive:true});mkdirSync(parent);
 const result=(await (await POST(request({operation:'undo',cwd:workspace,tokens:[moved.undoToken]}))).json()).results[0];assert.equal(result.status,'failed');assert.equal(existsSync(moved.destination),true);assert.equal(existsSync(source),false);
});

test('continues after a missing item and picks the next available filename without altering extension',async()=>{
 const source=join(workspace,'image.jpg');writeFileSync(source,'pixels');const target=join(workspace,'Images');mkdirSync(target);writeFileSync(join(target,'image.jpg'),'first');writeFileSync(join(target,'image (1).jpg'),'second');
 const data=await (await POST(request({operation:'move',cwd:workspace,paths:[join(workspace,'absent.jpg'),source],target,strategy:'rename'}))).json();assert.deepEqual(data.results.map(r=>r.status),['failed','success']);assert.equal(data.results[1].destination,join(target,'image (2).jpg'));
});
