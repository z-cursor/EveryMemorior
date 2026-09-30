/**
 * Timeout policy for execution based Tenant Skills.
 *
 * These are deliberately separate settings. The LLM timeout is applied to one
 * model request, the stage timeout to one named worker stage, and the
 * execution timeout is owned by the host and bounds the complete bridge
 * invocation (including planning, retries, checkpoints, and reports).
 */
export const DEFAULT_SKILL_LLM_TIMEOUT_SECONDS = 600;
export const DEFAULT_SKILL_STAGE_TIMEOUT_SECONDS = 600;
export const DEFAULT_SKILL_EXECUTION_TIMEOUT_SECONDS = 2_400;
export const MAX_SKILL_LLM_TIMEOUT_SECONDS = 3_600;
export const MAX_SKILL_STAGE_TIMEOUT_SECONDS = 3_600;
export const MAX_SKILL_EXECUTION_TIMEOUT_SECONDS = 2_400;

type Environment = Record<string, string | undefined>;

function timeoutSeconds(
  environment: Environment,
  name: string,
  fallback: number,
  maximum: number,
): number {
  const raw = environment[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0 || value > maximum) {
    throw new Error(`${name} is invalid; use an integer from 1 to ${maximum}`);
  }
  return value;
}

/** Timeout for one LLM request, in seconds. */
export function resolveSkillLlmTimeoutSeconds(environment: Environment = process.env): number {
  return timeoutSeconds(environment, "PI_WEB_SKILL_LLM_TIMEOUT_SECONDS", DEFAULT_SKILL_LLM_TIMEOUT_SECONDS, MAX_SKILL_LLM_TIMEOUT_SECONDS);
}

/** Minimum deadline for one named worker stage (for example chapter_plan). */
export function resolveSkillStageTimeoutSeconds(environment: Environment = process.env): number {
  return timeoutSeconds(environment, "PI_WEB_SKILL_STAGE_TIMEOUT_SECONDS", DEFAULT_SKILL_STAGE_TIMEOUT_SECONDS, MAX_SKILL_STAGE_TIMEOUT_SECONDS);
}

/** Timeout for one complete Skill bridge invocation, in milliseconds. */
export function resolveSkillExecutionTimeoutMs(environment: Environment = process.env): number {
  return timeoutSeconds(environment, "PI_WEB_SKILL_EXECUTION_TIMEOUT_SECONDS", DEFAULT_SKILL_EXECUTION_TIMEOUT_SECONDS, MAX_SKILL_EXECUTION_TIMEOUT_SECONDS) * 1_000;
}
