import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const agentEventsSource = await readFile(new URL("./[id]/events/route.ts", import.meta.url), "utf8");
const agentEventStreamSource = await readFile(new URL("../../../lib/agent-event-stream.ts", import.meta.url), "utf8");

test("agent SSE starts sessions asynchronously and disables response buffering", () => {
  assert.match(agentEventsSource, /createAgentEventStream\(req, id, sessionPromise\)/);
  assert.match(agentEventsSource, /sessionPromise = startRpcSession\([\s\S]*?\.then\(\(result\) => \{[\s\S]*?result\.session\.isTenantIsolated\(\)[\s\S]*?return result\.session;/);
  assert.doesNotMatch(agentEventsSource, /await startRpcSession\(/);
  assert.match(agentEventsSource, /if \(req\.signal\.aborted\) return new Response\(null, \{ status: 204 \}\)/);
  assert.match(agentEventsSource, /if \(session\.isRunning\(\)\) \{[\s\S]*?status: 403[\s\S]*?\}/);
  assert.match(agentEventsSource, /await session\.shutdown\(\);[\s\S]*?session = undefined/);
  assert.match(agentEventsSource, /!session\.isChatOnly\(\) && !session\.isTenantIsolated\(\)/);
  assert.match(agentEventsSource, /getAgentSessionExecution\(id\)/);
  assert.match(agentEventsSource, /initialSessionId: id/);
  assert.match(agentEventsSource, /isPersistedTenantSession\(filePath\)/);
  assert.doesNotMatch(agentEventsSource, /isPersistedChatOnlySession\(filePath\)/);
  assert.match(agentEventsSource, /tenantSkillPaths: publishedTenantSkillPaths\(auth\)/);
  assert.match(agentEventsSource, /tenantWorkspaceRoot: tenantManagedWorkspaceRoot\(auth\)/);
  assert.match(agentEventsSource, /"Cache-Control": "no-cache, no-transform"/);
  assert.match(agentEventsSource, /"X-Accel-Buffering": "no"/);
});

test("agent SSE reuses one TextEncoder per stream", () => {
  assert.equal((agentEventStreamSource.match(/new TextEncoder\(\)/g) ?? []).length, 1);
  assert.match(agentEventStreamSource, /controller\.enqueue\(encoder\.encode\(/);
});
