import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("tenant Skill refresh requests rebuild the live session with current published paths", async () => {
  const route = await readFile(new URL("./[id]/route.ts", import.meta.url), "utf8");
  const settings = await readFile(new URL("../../../components/TenantSettings.tsx", import.meta.url), "utf8");
  assert.match(settings, /type: "reload", refreshTenantSkills: true/);
  assert.match(route, /refreshTenantSkills/);
  assert.match(route, /publishedTenantSkillPaths\(auth\)/);
  assert.match(route, /Cannot refresh Tenant Skills while the session is running/);
  assert.match(route, /if \(existing\?\.isAlive\(\)\) await existing\.shutdown\(\)/);
  assert.match(route, /if \(!existing\?\.isAlive\(\)\) \{[\s\S]*?refreshed: false/);
  assert.match(route, /initialSessionId: id/);
  assert.match(route, /const tenantSkillPaths = publishedTenantSkillPaths\(auth\)/);
  assert.match(route, /tenantSkillPaths,/);
  assert.match(route, /tenantWorkspaceRoot: tenantManagedWorkspaceRoot\(auth\)/);
});
