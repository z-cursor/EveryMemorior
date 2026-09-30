import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { connect } from "node:net";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const { ModelGateway } = await jiti.import("./model-gateway.ts");

function request(socketPath, value) {
  return new Promise((resolve, reject) => {
    let output = "";
    const socket = connect(socketPath);
    socket.once("connect", () => socket.end(`${JSON.stringify(value)}\n`));
    socket.on("data", (chunk) => { output += chunk.toString("utf8"); });
    socket.once("error", reject);
    socket.once("end", () => resolve(JSON.parse(output)));
  });
}

test("model gateway refuses a route different from the session route", async () => {
  const gateway = await ModelGateway.open({ provider: "configured", modelId: "model-a" });
  try {
    const workerConfig = JSON.parse(await readFile(join(gateway.directory, "models.json"), "utf8"));
    const hook = await readFile(join(gateway.directory, "sitecustomize.py"), "utf8");
    assert.deepEqual(workerConfig.providers.configured.models, [{ id: "model-a" }]);
    assert.equal(workerConfig.providers.configured.apiKey, undefined);
    assert.match(hook, /BIOGRAPHY_STAGE_TIMEOUT_SECONDS/u);
    assert.match(hook, /BIOGRAPHY_EXECUTION_TIMEOUT_SECONDS/u);
    assert.match(hook, /_run_with_execution_budget/u);
    assert.match(hook, /stage_minimum/u);
    assert.match(hook, /request_timeout_seconds/u);
    assert.match(hook, /self\._offset = 0/u);
    assert.match(hook, /self\._offset = end/u);
    const response = await request(gateway.socketPath, {
      provider: "other",
      model: "model-a",
      body: {},
    });
    assert.equal(response.ok, false);
    assert.equal(response.status, 502);
    assert.match(response.error, /route does not match/u);
  } finally {
    await gateway.close();
  }
});
