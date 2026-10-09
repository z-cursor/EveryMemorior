// Browser acceptance against real authenticated routes and an isolated filesystem.
// Run: node e2e/file-explorer.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { createJiti } from 'jiti';
import { NextRequest } from 'next/server.js';
import { build } from 'esbuild';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';
import { chromium } from 'playwright';

const repo = resolve(import.meta.dirname, '..');
const fixture = fs.mkdtempSync(join(tmpdir(), 'file-explorer-browser-'));
const output = join(repo, 'test-results/file-explorer');
fs.mkdirSync(output, { recursive: true });
const previousDatabase = process.env.PI_WEB_DATABASE_PATH;
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_WEB_DATABASE_PATH = join(fixture, 'tenant.sqlite');
process.env.PI_CODING_AGENT_DIR = join(fixture, 'agent');
const jiti = createJiti(import.meta.url, { alias: { '@': repo }, interopDefault: true, moduleCache: false });
const { setupTenantOwner, TENANT_SESSION_COOKIE } = await jiti.import('../lib/tenant-auth.ts');
const { getTenantStore, closeTenantStore } = await jiti.import('../lib/tenant-store.ts');
const { allowFileRoot } = await jiti.import('../lib/file-access.ts');
const { workspacePathToClient } = await jiti.import('../lib/tenant-workspace.ts');
const files = await jiti.import('../app/api/files/[...path]/route.ts');
const operations = await jiti.import('../app/api/files/operations/route.ts');
const gitStatus = await jiti.import('../app/api/git/status/route.ts');
const gitDiff = await jiti.import('../app/api/git/diff/route.ts');
const fileIndex = await jiti.import('../app/api/file-index/route.ts');
const auth = await setupTenantOwner({ tenantName: 'Browser', tenantSlug: 'browser', displayName: 'Owner', email: 'owner@browser.test', password: 'correct horse battery staple' });
const workspace = join(fixture, 'workspace');
fs.mkdirSync(workspace);
allowFileRoot(workspace);
getTenantStore().ensureWorkspace({ tenantId: auth.session.tenant.id, membershipId: auth.session.membership.id }, { name: 'Browser', rootPath: workspace });
const cwd = workspacePathToClient(auth.session, workspace);
const secondWorkspace = join(fixture, 'other-workspace');
fs.mkdirSync(secondWorkspace);
allowFileRoot(secondWorkspace);
getTenantStore().ensureWorkspace({tenantId:auth.session.tenant.id,membershipId:auth.session.membership.id},{name:'Other',rootPath:secondWorkspace});
const secondCwd = workspacePathToClient(auth.session, secondWorkspace);
function reset() {
  for (const entry of fs.readdirSync(workspace)) fs.rmSync(join(workspace, entry), { recursive: true, force: true });
  fs.mkdirSync(join(workspace, 'Folder'));
  fs.mkdirSync(join(workspace, 'Destination'));
  fs.writeFileSync(join(workspace, 'Folder', 'nested.txt'), 'nested content');
  fs.writeFileSync(join(workspace, 'alpha.txt'), 'alpha content');
  fs.writeFileSync(join(workspace, 'beta.txt'), 'beta content');
}
reset();
const bundle = await build({
  stdin: { loader: 'tsx', resolveDir: repo, contents: `
    import React,{useState,useRef} from 'react';
    import {createRoot} from 'react-dom/client';
    import {FileExplorer} from './components/FileExplorer';
    import {I18nProvider} from './hooks/useI18n';
    import {FileViewer} from './components/FileViewer';
    import {openFileTab,remapMovedFileTabs,remapMovedActiveTab} from './components/file-tab-state';
    function Harness(){const explorer=useRef(null);const [currentCwd,setCwd]=useState(${JSON.stringify(cwd)});const [draft,setDraft]=useState('');const [tabs,setTabs]=useState([]);const [active,setActive]=useState(null);const opened=tabs.find(tab=>tab.id===active);return <I18nProvider>
      <button onClick={()=>explorer.current?.openUploadPicker()}>Upload files</button><button onClick={()=>explorer.current?.openDirectoryPicker()}>Upload folder</button>
      <button onClick={()=>setCwd(${JSON.stringify(secondCwd)})}>Other workspace</button><button onClick={()=>setCwd(${JSON.stringify(cwd)})}>Original workspace</button>
      <div id="panel" style={{width:'min(500px,100vw)',height:500,overflow:'auto'}}><FileExplorer ref={explorer} cwd={currentCwd} changesCollapsed fileSearchOpen
        onOpenFile={(path,name)=>{setTabs(current=>openFileTab(current,{filePath:path,fileName:name,tabId:'file:'+path}));setActive('file:'+path)}}
        onPathsMoved={results=>{setTabs(current=>remapMovedFileTabs(current,results));setActive(current=>remapMovedActiveTab(current,results))}} onAtMentions={paths=>setDraft(current=>current+'\\n'+paths.join('\\n'))}/></div>
      <output aria-label="Opened preview">{opened?.filePath}</output>{opened&&<div aria-label="Preview content"><FileViewer key={opened.id+opened.viewerRevision} filePath={opened.filePath} cwd={${JSON.stringify(cwd)}} watchEnabled={false}/></div>}<textarea aria-label="Chat draft" readOnly value={draft}/>
    </I18nProvider>;}createRoot(document.getElementById('root')).render(<Harness/>);` },
  absWorkingDir: repo, bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"development"' }, logLevel: 'silent',
});
const css = (await postcss([tailwind({ base: repo })]).process(fs.readFileSync(join(repo, 'app/globals.css'), 'utf8'), { from: join(repo, 'app/globals.css') })).css;
const requests = [];
const serverErrors = [];
let heldResponse = null;
let origin;
const server = createServer(async (incoming, outgoing) => {
  try {
    const url = new URL(incoming.url, origin);
    if (!url.pathname.startsWith('/api/')) {
      outgoing.setHeader('Content-Type', url.pathname === '/app.js' ? 'text/javascript' : url.pathname === '/style.css' ? 'text/css' : 'text/html');
      outgoing.end(url.pathname === '/app.js' ? bundle.outputFiles[0].contents : url.pathname === '/style.css' ? css : '<!doctype html><html data-theme="light"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>');
      return;
    }
    requests.push({ method: incoming.method, path: url.pathname });
    const chunks = [];
    for await (const chunk of incoming) chunks.push(chunk);
    const headers = new Headers();
    for (const [key, value] of Object.entries(incoming.headers)) if (value) headers.set(key, Array.isArray(value) ? value.join(',') : value);
    const request = new NextRequest(url, { method: incoming.method, headers, body: ['GET', 'HEAD'].includes(incoming.method) ? undefined : Buffer.concat(chunks) });
    let response;
    if (url.pathname === '/api/files/operations') {
      response = await operations.POST(request);
      if(heldResponse) {const hold=heldResponse;heldResponse=null;hold.started();await hold.released;}
    }
    else if (url.pathname.startsWith('/api/files/')) {
      const params = { params: Promise.resolve({ path: url.pathname.slice('/api/files/'.length).split('/').map(decodeURIComponent) }) };
      response = await files[incoming.method](request, params);
    } else if (url.pathname === '/api/git/diff') response = await gitDiff.GET(request);
    else if (url.pathname === '/api/git/status') response = await gitStatus.GET(request);
    else if (url.pathname === '/api/file-index') response = await fileIndex.GET(request);
    else throw new Error(`Unexpected API request: ${incoming.method} ${url.pathname}`);
    if (response.status >= 500) serverErrors.push(`${incoming.method} ${url.pathname}: HTTP ${response.status}`);
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    serverErrors.push(String(error));
    outgoing.writeHead(500); outgoing.end('Harness request failed');
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
let activePage;
let context;
const browserErrors = [];
const checkbox = (page, name) => page.getByRole('checkbox', { name: `Select ${name}`, exact: true });
async function fresh(viewport = { width: 1100, height: 800 }, prepare = () => {}) {
  await context?.close();
  reset();
  prepare();
  // Each scenario uses a fresh browser context and filesystem fixture.
  context = await browser.newContext({ viewport, locale: 'en-US' });
  await context.addCookies([{ name: TENANT_SESSION_COOKIE, value: auth.token, url: origin }]);
  await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
  activePage = await context.newPage();
  activePage.on('pageerror', error => browserErrors.push(error.message));
  activePage.setDefaultTimeout(10000);
  await activePage.goto(origin);
  await checkbox(activePage, 'alpha.txt').waitFor();
  return activePage;
}
const row = (page, relative) => page.locator(`[data-file-path=${JSON.stringify(join(workspace, relative))}]`);
async function externalData(page, entries) {
  return page.evaluateHandle(items => {const data = new DataTransfer();for (const item of items) {
    const file = new File([item.content], item.name, {type:'text/plain'});
    if (item.path) Object.defineProperty(file, 'webkitRelativePath', {value:item.path});
    data.items.add(file);
  }return data;}, entries);
}
async function externalDrop(page, target, entries) {
  const dataTransfer = await externalData(page, entries);
  await target.dispatchEvent('dragenter', {dataTransfer});
  await target.dispatchEvent('dragover', {dataTransfer});
  await target.dispatchEvent('drop', {dataTransfer});
  await dataTransfer.dispose();
}
async function moveWithPicker(page, paths, folder='Destination') {
  for (const path of paths) await row(page,path).getByRole('checkbox').check();
  await page.getByRole('button',{name:'Move to…'}).click();
  const dialog = page.getByRole('dialog',{name:'Choose folder'});
  if (folder) await dialog.getByRole('button',{name:'📁 '+folder,exact:true}).click();
  await dialog.getByRole('button',{name:'Move here'}).click();
}
try {
  let page = await fresh();
  await page.locator('[data-file-path]').filter({ hasText: 'alpha.txt' }).click();
  assert.equal(await page.getByLabel('Opened preview').textContent(), join(workspace, 'alpha.txt'));
  assert.equal(await checkbox(page, 'alpha.txt').isChecked(), false);
  await checkbox(page, 'alpha.txt').click();
  await page.locator('[data-file-path]').filter({ hasText: 'beta.txt' }).click({ modifiers: ['Control'] });
  assert.equal(await checkbox(page, 'beta.txt').isChecked(), true);
  await page.locator('[data-file-path]').filter({ hasText: /^Destination$/ }).click({ modifiers: ['Meta'] });
  assert.equal(await checkbox(page, 'Destination').isChecked(), true);
  await page.getByRole('button', { name: 'Clear selection' }).click();
  await checkbox(page, 'Destination').click();
  await checkbox(page, 'beta.txt').click({ modifiers: ['Shift'] });
  assert.equal(await page.getByRole('checkbox', { checked: true }).count(), 4);
  await page.getByRole('button', { name: 'Clear selection' }).click();
  await page.getByRole('button', { name: 'Select visible' }).click();
  assert.equal(await page.getByRole('checkbox', { checked: true }).count(), 4);
  await page.getByRole('textbox', { name: 'Search files', exact: true }).fill('alpha');
  assert.equal(await page.getByRole('checkbox', { checked: true }).count(), 0);

  page = await fresh();
  await page.locator('[data-file-path]').filter({ hasText: /^Folder$/ }).click();
  await checkbox(page, 'nested.txt').waitFor();
  await checkbox(page, 'Folder').click();
  await checkbox(page, 'nested.txt').click();
  await page.getByRole('button', { name: 'Reference in chat' }).click();
  const draft = await page.getByRole('textbox', { name: 'Chat draft' }).inputValue();
  assert.match(draft, /Folder\nFolder\/nested\.txt/);
  assert.equal(await page.getByRole('checkbox', { checked: true }).count(), 2);
  await page.getByRole('button', { name: 'Move to…' }).click();
  const picker = page.getByRole('dialog', { name: 'Choose folder' });
  assert.equal(await picker.getByRole('button', { name: '📁 Folder', exact: true }).isDisabled(), true);
  await picker.getByRole('button', { name: '📁 Destination', exact: true }).click();
  await picker.getByRole('button', { name: 'Parent folder', exact: true }).click();
  await picker.getByRole('button', { name: '📁 Destination', exact: true }).click();
  await picker.getByRole('textbox', { name: 'New folder name' }).fill('Created');
  await picker.getByRole('button', { name: 'Create folder' }).click();
  await picker.getByRole('button', { name: '📁 Created', exact: true }).click();
  await picker.getByRole('button', { name: 'Move here' }).click();
  await page.getByRole('status').filter({ hasText: '1 succeeded' }).waitFor();
  assert.equal(fs.existsSync(join(workspace, 'Folder')), false);
  assert.equal(fs.readFileSync(join(workspace, 'Destination', 'Created', 'Folder', 'nested.txt'), 'utf8'), 'nested content');
  assert.equal(await page.getByRole('checkbox', { checked: true }).count(), 0);

  await page.getByRole('button', { name: 'Undo last move', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('button')?.disabled);
  await page.getByRole('button', { name: 'Undo last move', exact: true }).waitFor({ state: 'hidden' });
  assert.equal(fs.existsSync(join(workspace, 'Folder', 'nested.txt')), true);
  assert.equal(fs.existsSync(join(workspace, 'Destination', 'Created', 'Folder')), false);

  page = await fresh();
  fs.writeFileSync(join(workspace, 'Destination', 'alpha.txt'), 'existing alpha');
  fs.writeFileSync(join(workspace, 'Destination', 'beta.txt'), 'existing beta');
  await checkbox(page, 'alpha.txt').click(); await checkbox(page, 'beta.txt').click();
  await page.getByRole('button', { name: 'Move to…' }).click();
  let conflictPicker = page.getByRole('dialog', { name: 'Choose folder' });
  await conflictPicker.getByRole('button', { name: '📁 Destination', exact: true }).click();
  await conflictPicker.getByRole('button', { name: 'Move here' }).click();
  let conflictDialog = page.getByRole('dialog', { name: 'Name conflict' });
  await conflictDialog.getByRole('checkbox', { name: 'Apply to remaining conflicts' }).check();
  await conflictDialog.getByRole('button', { name: 'Keep both', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '2 succeeded' }).waitFor();
  assert.equal(fs.readFileSync(join(workspace, 'Destination', 'alpha.txt'), 'utf8'), 'existing alpha');
  assert.equal(fs.readFileSync(join(workspace, 'Destination', 'alpha (1).txt'), 'utf8'), 'alpha content');
  assert.equal(fs.readFileSync(join(workspace, 'Destination', 'beta (1).txt'), 'utf8'), 'beta content');
  fs.writeFileSync(join(workspace, 'alpha.txt'), 'new original');
  await page.getByRole('button', { name: 'Undo last move', exact: true }).click();
  conflictDialog = page.getByRole('dialog', { name: 'Name conflict' });
  await conflictDialog.getByRole('button', { name: 'Keep both', exact: true }).click();
  await page.getByRole('button', { name: 'Undo last move', exact: true }).waitFor({ state: 'hidden' });
  assert.equal(fs.readFileSync(join(workspace, 'alpha.txt'), 'utf8'), 'new original');
  assert.equal(fs.readFileSync(join(workspace, 'alpha (1).txt'), 'utf8'), 'alpha content');
  assert.equal(fs.readFileSync(join(workspace, 'beta.txt'), 'utf8'), 'beta content');

  page = await fresh();
  fs.writeFileSync(join(workspace, 'Destination', 'beta.txt'), 'existing');
  await checkbox(page, 'alpha.txt').click(); await checkbox(page, 'beta.txt').click();
  await page.getByRole('button', { name: 'Move to…' }).click();
  conflictPicker = page.getByRole('dialog', { name: 'Choose folder' });
  await conflictPicker.getByRole('button', { name: '📁 Destination', exact: true }).click();
  await conflictPicker.getByRole('button', { name: 'Move here' }).click();
  conflictDialog = page.getByRole('dialog', { name: 'Name conflict' });
  assert.match(await conflictDialog.textContent(), /Completed moves are kept/);
  await conflictDialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '1 succeeded' }).waitFor();
  assert.equal(fs.existsSync(join(workspace, 'alpha.txt')), false);
  assert.equal(fs.existsSync(join(workspace, 'beta.txt')), true);
  assert.equal(await page.locator(`[data-file-path=${JSON.stringify(join(workspace, 'beta.txt'))}]`).getByRole('checkbox').isChecked(), true);
  await page.getByRole('button', { name: 'Undo last move', exact: true }).click();
  await page.getByRole('button', { name: 'Undo last move', exact: true }).waitFor({ state: 'hidden' });
  assert.equal(fs.existsSync(join(workspace, 'alpha.txt')), true);

  page = await fresh({ width: 390, height: 844 });
  await checkbox(page, 'alpha.txt').click();
  await page.getByRole('button', { name: 'Move to…' }).click();
  const mobilePicker = page.getByRole('dialog', { name: 'Choose folder' });
  await mobilePicker.getByRole('button', { name: '📁 Destination', exact: true }).click();
  await mobilePicker.getByRole('button', { name: 'Move here' }).click();
  await page.getByRole('status').filter({ hasText: '1 succeeded' }).waitFor();
  assert.equal(fs.existsSync(join(workspace, 'alpha.txt')), false);
  assert.equal(fs.readFileSync(join(workspace, 'Destination', 'alpha.txt'), 'utf8'), 'alpha content');
  await page.screenshot({path:join(output,'mobile-success.png')});
  await page.locator('[data-file-path]').filter({ hasText: /^Folder$/ }).click();
  await checkbox(page, 'nested.txt').waitFor();
  await checkbox(page, 'Folder').click();
  await checkbox(page, 'nested.txt').click();
  await page.getByRole('button', { name: 'Delete file', exact: true }).first().click();
  let dialog = page.getByRole('dialog', { name: 'Delete file' });
  assert.equal(await dialog.getByRole('listitem').count(), 1);
  assert.match(await dialog.textContent(), /cannot be undone/);
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  assert.equal(fs.existsSync(join(workspace, 'Folder', 'nested.txt')), true);
  await page.getByRole('button', { name: 'Delete file', exact: true }).first().click();
  dialog = page.getByRole('dialog', { name: 'Delete file' });
  await dialog.getByRole('button', { name: 'Delete file', exact: true }).first().click();
  await page.getByRole('status').filter({ hasText: '1 succeeded' }).waitFor();
  assert.equal(fs.existsSync(join(workspace, 'Folder')), false);
  page = await fresh();
  await checkbox(page, 'alpha.txt').check();
  await checkbox(page, 'beta.txt').check();
  await page.locator('[data-file-path]').filter({ hasText: 'alpha.txt' }).dragTo(page.locator('[data-file-path]').filter({ hasText: /^Destination$/ }), {timeout:5000});
  await page.getByRole('status').filter({ hasText: '2 succeeded' }).waitFor();
  assert.equal(fs.existsSync(join(workspace, 'alpha.txt')), false);
  assert.equal(fs.existsSync(join(workspace, 'beta.txt')), false);
  assert.equal(fs.readFileSync(join(workspace, 'Destination', 'alpha.txt'), 'utf8'), 'alpha content');
  assert.equal(fs.readFileSync(join(workspace, 'Destination', 'beta.txt'), 'utf8'), 'beta content');
  // An unselected drag leaves the existing selection alone and moves only itself.
  page = await fresh();
  await checkbox(page, 'beta.txt').check();
  await row(page, 'alpha.txt').dragTo(row(page, 'Destination'));
  await page.getByRole('status').filter({hasText:'1 succeeded'}).waitFor();
  assert.equal(fs.existsSync(join(workspace,'beta.txt')),true);
  assert.equal(await row(page,'beta.txt').getByRole('checkbox').isChecked(),true);
  assert.equal(await row(page,'Destination/alpha.txt').getAttribute('data-file-highlighted'),'true');
  await page.screenshot({path:join(output,'desktop-success.png')});

  // Files and blank areas are invalid internal destinations; the explicit root accepts a nested file.
  page = await fresh();
  await row(page,'alpha.txt').dragTo(row(page,'beta.txt'));
  assert.equal(fs.existsSync(join(workspace,'alpha.txt')),true);
  await row(page,'alpha.txt').dragTo(page.locator('[data-file-explorer]'),{targetPosition:{x:400,y:460}});
  assert.equal(fs.existsSync(join(workspace,'alpha.txt')),true);
  await row(page,'Folder').click();
  await row(page,'Folder/nested.txt').dragTo(page.locator('[data-file-drop-root]'));
  await page.getByRole('status').filter({hasText:'1 succeeded'}).waitFor();
  assert.equal(fs.readFileSync(join(workspace,'nested.txt'),'utf8'),'nested content');
  assert.equal(fs.existsSync(join(workspace,'Folder/nested.txt')),false);

  // External drops use actual multipart uploads and never move internal paths.
  page = await fresh();
  await externalDrop(page,row(page,'Destination'),[{name:'external.txt',content:'external content'}]);
  await row(page,'Destination/external.txt').waitFor();
  assert.equal(fs.readFileSync(join(workspace,'Destination/external.txt'),'utf8'),'external content');
  await externalDrop(page,row(page,'alpha.txt'),[{name:'invalid.txt',content:'invalid'}]);
  assert.equal(fs.existsSync(join(workspace,'invalid.txt')),false);
  const blank = page.locator('[data-file-explorer]');
  const transfer = await externalData(page,[{name:'root.txt',content:'root upload'}]);
  await blank.dispatchEvent('dragenter',{dataTransfer:transfer});
  await blank.dispatchEvent('dragover',{dataTransfer:transfer});
  assert.equal(await page.locator('[data-file-drop-root]').getAttribute('data-file-drop-active'),'true');
  assert.match(await page.locator('[data-file-drag-feedback]').textContent(),/Upload 1 items/);
  assert.match(await page.locator('[data-file-drag-feedback]').textContent(),new RegExp(workspace));
  await blank.dispatchEvent('drop',{dataTransfer:transfer});
  await row(page,'root.txt').waitFor();
  assert.equal(fs.readFileSync(join(workspace,'root.txt'),'utf8'),'root upload');
  await transfer.dispose();
  // Hover opens a directory; Escape prevents a subsequent valid drop.
  page = await fresh();
  const external = await externalData(page,[{name:'hover.txt',content:'hovered upload'}]);
  await row(page,'Folder').dispatchEvent('dragenter',{dataTransfer:external});
  await row(page,'Folder').dispatchEvent('dragover',{dataTransfer:external});
  await row(page,'Folder/nested.txt').waitFor();
  assert.match(await page.locator('[data-file-drag-feedback]').textContent(),/Upload 1 items/);
  await page.keyboard.press('Escape');
  await row(page,'Folder').dispatchEvent('drop',{dataTransfer:external});
  assert.equal(fs.existsSync(join(workspace,'Folder/hover.txt')),false);
  await external.dispose();

  page = await fresh();
  const sourceBox = await row(page,'alpha.txt').boundingBox();
  const folderBox = await row(page,'Folder').boundingBox();
  await page.mouse.move(sourceBox.x+200,sourceBox.y+12);await page.mouse.down();
  await page.mouse.move(sourceBox.x+220,sourceBox.y+12,{steps:3});
  await page.mouse.move(folderBox.x+180,folderBox.y+12,{steps:8});
  await page.mouse.move(folderBox.x+182,folderBox.y+12);
  await row(page,'Folder/nested.txt').waitFor();
  assert.match(await page.locator('[data-file-drag-feedback]').textContent(),/Move 1 selected items/);
  await page.keyboard.press('Escape');await page.mouse.up();
  assert.equal(fs.existsSync(join(workspace,'alpha.txt')),true);

  // Scroll long panels at their edge while holding an external drag.
  page = await fresh(undefined,()=>{for(let i=0;i<60;i++) fs.mkdirSync(join(workspace,'Long '+String(i).padStart(2,'0')));});
  const scrolling = await externalData(page,[{name:'scroll.txt',content:'scroll'}]);
  const panelBox = await page.locator('#panel').boundingBox();
  await page.locator('[data-file-explorer]').dispatchEvent('dragenter',{dataTransfer:scrolling});
  await page.locator('[data-file-explorer]').dispatchEvent('dragover',{dataTransfer:scrolling,clientY:panelBox.y+panelBox.height-4});
  await page.waitForFunction(()=>document.getElementById('panel').scrollTop>100);
  await page.keyboard.press('Escape');await scrolling.dispose();

  // File chooser opens only after the platform directory is confirmed.
  page = await fresh();
  let chooserCount=0;page.on('filechooser',()=>chooserCount++);
  await page.getByRole('button',{name:'Upload files',exact:true}).click();
  const uploadPicker=page.getByRole('dialog',{name:'Choose folder'});
  assert.equal(chooserCount,0);
  await uploadPicker.getByRole('button',{name:'📁 Destination',exact:true}).click();
  const chooserReady=page.waitForEvent('filechooser');
  await uploadPicker.getByRole('button',{name:'Upload here',exact:true}).click();
  const chooser=await chooserReady;
  await chooser.setFiles({name:'chosen.txt',mimeType:'text/plain',buffer:Buffer.from('chosen target')});
  await row(page,'Destination/chosen.txt').waitFor();
  assert.equal(fs.readFileSync(join(workspace,'Destination/chosen.txt'),'utf8'),'chosen target');
  assert.equal(fs.existsSync(join(workspace,'chosen.txt')),false);

  // Upload conflicts keep their captured target, including explicit overwrite and skip.
  await externalDrop(page,row(page,'Destination'),[{name:'chosen.txt',content:'renamed upload'}]);
  await page.getByRole('button',{name:'Keep both (rename)',exact:true}).click();
  await row(page,'Destination/chosen (1).txt').waitFor();
  assert.equal(fs.readFileSync(join(workspace,'Destination/chosen.txt'),'utf8'),'chosen target');
  assert.equal(fs.readFileSync(join(workspace,'Destination/chosen (1).txt'),'utf8'),'renamed upload');
  await externalDrop(page,row(page,'Destination'),[{name:'chosen.txt',content:'replacement'}]);
  await page.getByRole('button',{name:'Replace',exact:true}).click();
  await page.waitForFunction(()=>!document.querySelector('[role="alert"]'));
  assert.equal(fs.readFileSync(join(workspace,'Destination/chosen.txt'),'utf8'),'replacement');
  await externalDrop(page,row(page,'Destination'),[{name:'chosen.txt',content:'skipped content'}]);
  await page.getByRole('button',{name:'Skip existing',exact:true}).click();
  await page.waitForFunction(()=>!document.querySelector('[role="alert"]'));
  assert.equal(fs.readFileSync(join(workspace,'Destination/chosen.txt'),'utf8'),'replacement');
  await externalDrop(page,row(page,'Destination'),[{name:'chosen.txt',content:'canceled content'}]);
  await page.getByRole('button',{name:'Cancel',exact:true}).click();
  assert.equal(fs.readFileSync(join(workspace,'Destination/chosen.txt'),'utf8'),'replacement');

  // Directory chooser keeps its top-level hierarchy and renames an existing folder as a whole.
  const uploadFolder=join(fixture,'Uploads');fs.mkdirSync(join(uploadFolder,'inside'),{recursive:true});
  fs.writeFileSync(join(uploadFolder,'inside','note.txt'),'folder upload');
  for(let attempt=0;attempt<2;attempt++) {
    await page.getByRole('button',{name:'Upload folder',exact:true}).click();
    const folderPicker=page.getByRole('dialog',{name:'Choose folder'});
    await folderPicker.getByRole('button',{name:'📁 Destination',exact:true}).click();
    const folderChooserReady=page.waitForEvent('filechooser');
    await folderPicker.getByRole('button',{name:'Upload here'}).click();
    await (await folderChooserReady).setFiles(uploadFolder);
    if(attempt) await page.getByRole('button',{name:'Keep both (rename)',exact:true}).click();
    await page.waitForFunction(()=>!document.querySelector('[role="alert"]')&&!!document.querySelector('[aria-label="Add uploaded file to chat"], [aria-label="Add all uploaded files to chat"]'));
    const name=attempt?'Uploads (1)':'Uploads';
    assert.equal(fs.readFileSync(join(workspace,'Destination',name,'inside/note.txt'),'utf8'),'folder upload');
  }

  // OS directory-entry drops preserve the top directory and drain every reader batch.
  const directoryTransfer=await page.evaluateHandle(()=>{
    const data=new DataTransfer();data.items.add(new File([''],'Dropped folder'));
    const file=(name,content)=>({name,isFile:true,isDirectory:false,file:success=>queueMicrotask(()=>success(new File([content],name)))});
    const directory=(name,children)=>({name,isFile:false,isDirectory:true,createReader:()=>{let index=0;return {readEntries:success=>queueMicrotask(()=>success(index<children.length?[children[index++]]:[]))};}});
    const entry=directory('Dropped folder',[file('one.txt','one'),directory('inner',[file('two.txt','two')])]);
    const original=DataTransferItem.prototype.webkitGetAsEntry;
    DataTransferItem.prototype.webkitGetAsEntry=function(){return this.getAsFile()?.name==='Dropped folder'?entry:original.call(this);};return data;
  });
  await row(page,'Destination').dispatchEvent('dragenter',{dataTransfer:directoryTransfer});
  await row(page,'Destination').dispatchEvent('dragover',{dataTransfer:directoryTransfer});
  await row(page,'Destination').dispatchEvent('drop',{dataTransfer:directoryTransfer});
  await row(page,'Destination/Dropped folder').waitFor();
  assert.equal(fs.readFileSync(join(workspace,'Destination/Dropped folder/one.txt'),'utf8'),'one');
  assert.equal(fs.readFileSync(join(workspace,'Destination/Dropped folder/inner/two.txt'),'utf8'),'two');
  await directoryTransfer.dispose();

  // Production tab mapping and real Viewer follow folder moves and renamed undo paths.
  page = await fresh();await row(page,'Folder').click();await row(page,'Folder/nested.txt').click();
  await page.getByLabel('Preview content').getByText('nested content',{exact:true}).waitFor();
  await moveWithPicker(page,['Folder']);
  await page.waitForFunction(path=>document.querySelector('[aria-label="Opened preview"]').textContent===path,join(workspace,'Destination/Folder/nested.txt'));
  await page.getByLabel('Preview content').getByText('nested content',{exact:true}).waitFor();
  fs.mkdirSync(join(workspace,'Folder'));fs.writeFileSync(join(workspace,'Folder/new.txt'),'new folder');
  await page.getByRole('button',{name:'Undo last move',exact:true}).click();
  await page.getByRole('dialog',{name:'Name conflict'}).getByRole('button',{name:'Keep both',exact:true}).click();
  await page.waitForFunction(path=>document.querySelector('[aria-label="Opened preview"]').textContent===path,join(workspace,'Folder (1)/nested.txt'));
  await page.getByLabel('Preview content').getByText('nested content',{exact:true}).waitFor();
  assert.equal(fs.readFileSync(join(workspace,'Folder/new.txt'),'utf8'),'new folder');

  // Leaving the Workspace invalidates its page undo record and any suspended conflict.
  page = await fresh();await moveWithPicker(page,['alpha.txt']);
  await page.getByRole('button',{name:'Undo last move',exact:true}).waitFor();
  await page.getByRole('button',{name:'Other workspace',exact:true}).click();
  await page.getByRole('button',{name:'Original workspace',exact:true}).click();
  await row(page,'beta.txt').waitFor();
  assert.equal(await page.getByRole('button',{name:'Undo last move',exact:true}).count(),0);
  page = await fresh();
  fs.writeFileSync(join(workspace,'Destination/alpha.txt'),'existing');
  await moveWithPicker(page,['alpha.txt']);
  await page.getByRole('dialog',{name:'Name conflict'}).waitFor();
  // Simulate the owner's navigation changing the public Workspace prop during a modal.
  await page.getByRole('button',{name:'Other workspace',exact:true}).dispatchEvent('click');
  await page.getByRole('dialog',{name:'Name conflict'}).waitFor({state:'hidden'});
  await page.getByRole('button',{name:'Original workspace',exact:true}).click();
  await row(page,'alpha.txt').waitFor();
  assert.equal(fs.readFileSync(join(workspace,'alpha.txt'),'utf8'),'alpha content');
  assert.equal(fs.readFileSync(join(workspace,'Destination/alpha.txt'),'utf8'),'existing');
  assert.equal(await page.getByRole('button',{name:'Undo last move',exact:true}).count(),0);

  // A canceled response in flight still reports its committed move and provides undo.
  page = await fresh();
  let committed,release;
  const started=new Promise(resolve=>committed=resolve);
  const released=new Promise(resolve=>release=resolve);
  heldResponse={started:committed,released};
  await moveWithPicker(page,['alpha.txt','beta.txt']);
  await started;
  await page.getByRole('button',{name:'Cancel remaining',exact:false}).click();
  release();
  await page.getByRole('status').filter({hasText:'1 succeeded'}).waitFor();
  assert.equal(fs.readFileSync(join(workspace,'Destination/alpha.txt'),'utf8'),'alpha content');
  assert.equal(fs.existsSync(join(workspace,'beta.txt')),true);
  await page.getByRole('button',{name:'Undo last move',exact:true}).click();
  await page.getByRole('button',{name:'Undo last move',exact:true}).waitFor({state:'hidden'});
  assert.equal(fs.readFileSync(join(workspace,'alpha.txt'),'utf8'),'alpha content');
  // A missing item fails independently; later selected items still move.
  page = await fresh(undefined,()=>fs.writeFileSync(join(workspace,'gamma.txt'),'gamma content'));
  await page.getByRole('textbox',{name:'Search files',exact:true}).fill('.txt');
  for(const name of ['alpha.txt','beta.txt','gamma.txt']) await row(page,name).first().getByRole('checkbox').check();
  fs.unlinkSync(join(workspace,'beta.txt'));
  await page.getByRole('button',{name:'Move to…'}).click();
  const partialPicker=page.getByRole('dialog',{name:'Choose folder'});
  await partialPicker.getByRole('button',{name:'📁 Destination',exact:true}).click();
  await partialPicker.getByRole('button',{name:'Move here'}).click();
  await page.getByRole('status').filter({hasText:'2 succeeded, 0 skipped, 1 failed'}).waitFor();
  assert.equal(fs.readFileSync(join(workspace,'Destination/gamma.txt'),'utf8'),'gamma content');
  assert.match(await page.locator('[data-file-drop-controls]').first().textContent(),/1 selected/);
  // A move may leave skipped entries selected even when it reveals destinations from search.
  page = await fresh(undefined, () => fs.writeFileSync(join(workspace,'Destination/beta.txt'),'existing'));
  await page.getByRole('textbox',{name:'Search files',exact:true}).fill('.txt');
  await row(page,'alpha.txt').first().getByRole('checkbox').check();
  await row(page,'beta.txt').first().getByRole('checkbox').check();
  await page.getByRole('button',{name:'Move to…'}).click();
  let searchPicker = page.getByRole('dialog',{name:'Choose folder'});
  await searchPicker.getByRole('button',{name:'📁 Destination',exact:true}).click();
  await searchPicker.getByRole('button',{name:'Move here'}).click();
  await page.getByRole('dialog',{name:'Name conflict'}).getByRole('button',{name:'Skip',exact:true}).click();
  await page.getByRole('status').filter({hasText:'1 succeeded, 1 skipped, 0 failed'}).waitFor();
  assert.equal(await row(page,'beta.txt').getByRole('checkbox').isChecked(),true);
  assert.match(await page.locator('[data-file-drop-controls]').first().textContent(),/1 selected/);
  await row(page,'Destination/alpha.txt').waitFor();
  await page.getByRole('textbox',{name:'Search files',exact:true}).fill('beta');
  assert.equal(await page.getByRole('checkbox',{checked:true}).count(),0);

  // Directory selection keeps its type when its parent is collapsed.
  page = await fresh(undefined, () => fs.mkdirSync(join(workspace,'Folder/Child/Descendant'),{recursive:true}));
  await row(page,'Folder').click();
  await row(page,'Folder/Child').getByRole('checkbox').check();
  await row(page,'alpha.txt').getByRole('checkbox').check();
  await row(page,'Folder').click();
  await row(page,'Folder/Child').waitFor({state:'hidden'});
  await page.getByRole('button',{name:'Move to…'}).click();
  let hiddenPicker = page.getByRole('dialog',{name:'Choose folder'});
  await hiddenPicker.getByRole('button',{name:'📁 Folder',exact:true}).click();
  assert.equal(await hiddenPicker.getByRole('button',{name:'📁 Child',exact:true}).isDisabled(),true);
  await hiddenPicker.getByRole('button',{name:'Cancel',exact:true}).click();
  // Expand the parent while hovering: the hidden selected child is still an invalid target.
  const hiddenDrag = await page.evaluateHandle(() => new DataTransfer());
  await row(page,'alpha.txt').dispatchEvent('dragstart',{dataTransfer:hiddenDrag});
  await row(page,'Folder').dispatchEvent('dragover',{dataTransfer:hiddenDrag});
  await row(page,'Folder/Child').waitFor();
  await row(page,'Folder/Child').dispatchEvent('dragover',{dataTransfer:hiddenDrag});
  assert.match(await page.locator('[data-file-drag-feedback]').textContent(),/Cannot drop here/);
  await row(page,'Folder/Child').dispatchEvent('drop',{dataTransfer:hiddenDrag});
  await hiddenDrag.dispose();
  assert.equal(fs.existsSync(join(workspace,'alpha.txt')),true);
  assert.deepEqual(serverErrors, []);
  assert.deepEqual(browserErrors, []);
  assert.equal(requests.some(request => request.path.startsWith('/api/agent')), false);
  console.log('File explorer browser acceptance passed (selection, references, button/drag move, valid/invalid targets, hover/scroll/Escape, uploads/conflicts/folders, preview-follow/undo, cancellation, Workspace isolation, mobile deletion).');
} catch (error) {
  console.error(error);
  await activePage?.screenshot({ path: join(output, 'failure.png'), fullPage: true });
  await context?.tracing.stop({ path: join(output, 'failure-trace.zip') });
  fs.writeFileSync(join(output, 'errors.json'), JSON.stringify({ serverErrors, browserErrors, requests }, null, 2));
  throw error;
} finally {
  await context?.close();
  await browser.close();
  await new Promise(resolve => server.close(resolve));
  closeTenantStore();
  if (previousDatabase === undefined) delete process.env.PI_WEB_DATABASE_PATH;
  else process.env.PI_WEB_DATABASE_PATH = previousDatabase;
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  fs.rmSync(fixture, { recursive: true, force: true });
}
