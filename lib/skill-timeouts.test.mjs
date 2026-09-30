import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const {
  DEFAULT_SKILL_EXECUTION_TIMEOUT_SECONDS,
  DEFAULT_SKILL_LLM_TIMEOUT_SECONDS,
  DEFAULT_SKILL_STAGE_TIMEOUT_SECONDS,
  resolveSkillExecutionTimeoutMs,
  resolveSkillLlmTimeoutSeconds,
  resolveSkillStageTimeoutSeconds,
} = await createJiti(import.meta.url).import("./skill-timeouts.ts");

test("LLM and complete-execution timeouts have independent defaults", () => {
  const environment = {};
  assert.equal(resolveSkillLlmTimeoutSeconds(environment), DEFAULT_SKILL_LLM_TIMEOUT_SECONDS);
  assert.equal(resolveSkillStageTimeoutSeconds(environment), DEFAULT_SKILL_STAGE_TIMEOUT_SECONDS);
  assert.equal(resolveSkillExecutionTimeoutMs(environment), DEFAULT_SKILL_EXECUTION_TIMEOUT_SECONDS * 1_000);
});

test("changing the LLM timeout cannot shorten the complete bridge deadline", () => {
  const environment = { PI_WEB_SKILL_LLM_TIMEOUT_SECONDS: "60" };
  assert.equal(resolveSkillLlmTimeoutSeconds(environment), 60);
  assert.equal(resolveSkillStageTimeoutSeconds(environment), 600);
  assert.equal(resolveSkillExecutionTimeoutMs(environment), 2_400_000);
});

test("the execution timeout is configured by its own variable", () => {
  const environment = {
    PI_WEB_SKILL_LLM_TIMEOUT_SECONDS: "600",
    PI_WEB_SKILL_EXECUTION_TIMEOUT_SECONDS: "1800",
  };
  assert.equal(resolveSkillLlmTimeoutSeconds(environment), 600);
  assert.equal(resolveSkillExecutionTimeoutMs(environment), 1_800_000);
});

test("stage timeout is configured independently from request and execution timeouts", () => {
  const environment = {
    PI_WEB_SKILL_LLM_TIMEOUT_SECONDS: "120",
    PI_WEB_SKILL_STAGE_TIMEOUT_SECONDS: "900",
    PI_WEB_SKILL_EXECUTION_TIMEOUT_SECONDS: "1800",
  };
  assert.equal(resolveSkillLlmTimeoutSeconds(environment), 120);
  assert.equal(resolveSkillStageTimeoutSeconds(environment), 900);
  assert.equal(resolveSkillExecutionTimeoutMs(environment), 1_800_000);
});

test("invalid timeout configuration fails closed", () => {
  assert.throws(
    () => resolveSkillLlmTimeoutSeconds({ PI_WEB_SKILL_LLM_TIMEOUT_SECONDS: "600.5" }),
    /PI_WEB_SKILL_LLM_TIMEOUT_SECONDS is invalid/u,
  );
  assert.throws(
    () => resolveSkillExecutionTimeoutMs({ PI_WEB_SKILL_EXECUTION_TIMEOUT_SECONDS: "0" }),
    /PI_WEB_SKILL_EXECUTION_TIMEOUT_SECONDS is invalid/u,
  );
  assert.throws(
    () => resolveSkillExecutionTimeoutMs({ PI_WEB_SKILL_EXECUTION_TIMEOUT_SECONDS: "3600" }),
    /PI_WEB_SKILL_EXECUTION_TIMEOUT_SECONDS is invalid/u,
  );
});
