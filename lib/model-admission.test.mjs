import assert from "node:assert/strict";
import test from "node:test";

const { acquireModelAdmission, getModelAdmissionStats } = await import("./model-admission.ts");

test("model admission allows the configured number of active turns and queues the rest", async () => {
  const previous = process.env.PI_MODEL_MAX_ACTIVE;
  process.env.PI_MODEL_MAX_ACTIVE = "2";
  try {
    const first = await acquireModelAdmission();
    const second = await acquireModelAdmission();
    let thirdStarted = false;
    const third = acquireModelAdmission().then((release) => {
      thirdStarted = true;
      return release;
    });

    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(thirdStarted, false);
    assert.deepEqual(getModelAdmissionStats(), { active: 2, queued: 1, limit: 2 });

    first();
    const thirdRelease = await third;
    assert.equal(thirdStarted, true);
    assert.deepEqual(getModelAdmissionStats(), { active: 2, queued: 0, limit: 2 });
    second();
    thirdRelease();
    assert.deepEqual(getModelAdmissionStats(), { active: 0, queued: 0, limit: 2 });
  } finally {
    if (previous === undefined) delete process.env.PI_MODEL_MAX_ACTIVE;
    else process.env.PI_MODEL_MAX_ACTIVE = previous;
  }
});

test("model admission release is idempotent", async () => {
  const previous = process.env.PI_MODEL_MAX_ACTIVE;
  process.env.PI_MODEL_MAX_ACTIVE = "1";
  try {
    const release = await acquireModelAdmission();
    release();
    release();
    assert.equal(getModelAdmissionStats().active, 0);
  } finally {
    if (previous === undefined) delete process.env.PI_MODEL_MAX_ACTIVE;
    else process.env.PI_MODEL_MAX_ACTIVE = previous;
  }
});
