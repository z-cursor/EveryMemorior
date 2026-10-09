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
const fileIndex = await jiti.import('../app/api/file-index/route.ts');
const auth = await setupTenantOwner({ tenantName: 'Browser', tenantSlug: 'browser', displayName: 'Owner', email: 'owner@browser.test', password: 'correct horse battery staple' });
const workspace = join(fixture, 'workspace');
fs.mkdirSync(workspace);
allowFileRoot(workspace);
getTenantStore().ensureWorkspace({ tenantId: auth.session.tenant.id, membershipId: auth.session.membership.id }, { name: 'Browser', rootPath: workspace });
const cwd = workspacePathToClient(auth.session, workspace);
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
    import React,{useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {FileExplorer} from './components/FileExplorer';
    import {I18nProvider} from './hooks/useI18n';
    function Harness(){const [draft,setDraft]=useState('');const [opened,setOpened]=useState('');return <I18nProvider>
      <div id="panel" style={{width:'min(500px,100vw)',height:500,overflow:'auto'}}><FileExplorer cwd={${JSON.stringify(cwd)}} changesCollapsed fileSearchOpen
        onOpenFile={path=>setOpened(path)} onAtMentions={paths=>setDraft(current=>current+'\\n'+paths.join('\\n'))}/></div>
      <output aria-label="Opened preview">{opened}</output><textarea aria-label="Chat draft" readOnly value={draft}/>
    </I18nProvider>;}createRoot(document.getElementById('root')).render(<Harness/>);` },
  absWorkingDir: repo, bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"development"' }, logLevel: 'silent',
});
const css = (await postcss([tailwind({ base: repo })]).process(fs.readFileSync(join(repo, 'app/globals.css'), 'utf8'), { from: join(repo, 'app/globals.css') })).css;
const requests = [];
const serverErrors = [];
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
    if (url.pathname === '/api/files/operations') response = await operations.POST(request);
    else if (url.pathname.startsWith('/api/files/')) {
      const params = { params: Promise.resolve({ path: url.pathname.slice('/api/files/'.length).split('/').map(decodeURIComponent) }) };
      response = await files[incoming.method](request, params);
    } else if (url.pathname === '/api/git/status') response = await gitStatus.GET(request);
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
async function fresh(viewport = { width: 1100, height: 800 }) {
  await context?.close();
  reset();
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

  page = await fresh({ width: 390, height: 844 });
  await checkbox(page, 'alpha.txt').click();
  await page.getByRole('button', { name: 'Move to…' }).click();
  const mobilePicker = page.getByRole('dialog', { name: 'Choose folder' });
  await mobilePicker.getByRole('button', { name: '📁 Destination', exact: true }).click();
  await mobilePicker.getByRole('button', { name: 'Move here' }).click();
  await page.getByRole('status').filter({ hasText: '1 succeeded' }).waitFor();
  assert.equal(fs.existsSync(join(workspace, 'alpha.txt')), false);
  assert.equal(fs.readFileSync(join(workspace, 'Destination', 'alpha.txt'), 'utf8'), 'alpha content');
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
  assert.deepEqual(serverErrors, []);
  assert.deepEqual(browserErrors, []);
  assert.equal(requests.some(request => request.path.startsWith('/api/agent')), false);
  console.log('File explorer browser acceptance passed (selection, references, mkdir, move, mobile deletion).');
} catch (error) {
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
