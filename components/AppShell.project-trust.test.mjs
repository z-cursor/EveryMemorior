import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");

test("tenant users do not request installation-owner project trust status", () => {
  const effect = source.match(/useEffect\(\(\) => \{\s*setProjectTrust\(null\);[\s\S]*?\n  \}, \[[^\]]+\]\);/)?.[0];
  assert.ok(effect, "project trust initialization effect should exist");
  assert.match(effect, /if \(hostAccess !== true \|\| !projectTrustCwd\) return;/);
  assert.match(effect, /\}, \[hostAccess, projectTrustCwd\]\);/);
  assert.match(source, /const handleTrustProject = useCallback\(async \(\) => \{\s*if \(hostAccess !== true \|\| !projectTrustCwd \|\| projectTrustBusy\) return;/);
});
