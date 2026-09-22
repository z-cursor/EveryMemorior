export type TrialMetrics = {
  baselineViolations: number;
  specificResponsive: { numerator: number; denominator: number; percentage: number | null };
  interrogationFailures: { numerator: number; denominator: number; percentage: number | null };
  ignoredEndingFailures: { numerator: number; denominator: number; percentage: number | null };
  memoryErrors: { numerator: number; denominator: number; percentage: number | null };
  ordinaryFirstVisibleMs: { p50: number | null; p90: number | null };
  ordinaryCompletionMs: { p90: number | null };
  bufferedCompletionMs: { p90: number | null };
  willingnessToContinue: { numerator: number; denominator: number; missing: number; percentage: number | null };
};

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)] ?? null;
}

export function calculateCompanionTrialMetrics(input: {
  baselineViolations: number;
  sampledConversations: Array<{ specificallyResponsive: boolean; interrogation: boolean; ignoredEnding: boolean }>;
  memoryErrors: number;
  memoryChecks: number;
  ordinaryFirstVisibleMs: number[];
  ordinaryCompletionMs: number[];
  bufferedCompletionMs: number[];
  exitInterviews: Array<{ willingToContinue: boolean | null }>;
}): TrialMetrics {
  const responsive = input.sampledConversations.filter((item) => item.specificallyResponsive && !item.interrogation && !item.ignoredEnding).length;
  const completedExits = input.exitInterviews.filter((item) => item.willingToContinue !== null);
  const willing = completedExits.filter((item) => item.willingToContinue === true).length;
  const percentage = (numerator: number, denominator: number) => denominator ? Math.round((numerator / denominator) * 10000) / 100 : null;
  return {
    baselineViolations: input.baselineViolations,
    specificResponsive: { numerator: responsive, denominator: input.sampledConversations.length, percentage: percentage(responsive, input.sampledConversations.length) },
    interrogationFailures: { numerator: input.sampledConversations.filter((item) => item.interrogation).length, denominator: input.sampledConversations.length, percentage: percentage(input.sampledConversations.filter((item) => item.interrogation).length, input.sampledConversations.length) },
    ignoredEndingFailures: { numerator: input.sampledConversations.filter((item) => item.ignoredEnding).length, denominator: input.sampledConversations.length, percentage: percentage(input.sampledConversations.filter((item) => item.ignoredEnding).length, input.sampledConversations.length) },
    memoryErrors: { numerator: input.memoryErrors, denominator: input.memoryChecks, percentage: percentage(input.memoryErrors, input.memoryChecks) },
    ordinaryFirstVisibleMs: { p50: percentile(input.ordinaryFirstVisibleMs, 0.5), p90: percentile(input.ordinaryFirstVisibleMs, 0.9) },
    ordinaryCompletionMs: { p90: percentile(input.ordinaryCompletionMs, 0.9) },
    bufferedCompletionMs: { p90: percentile(input.bufferedCompletionMs, 0.9) },
    willingnessToContinue: {
      numerator: willing, denominator: completedExits.length, missing: input.exitInterviews.length - completedExits.length,
      percentage: percentage(willing, completedExits.length),
    },
  };
}

export function passesCompanionTrialGate(metrics: TrialMetrics): boolean {
  return metrics.baselineViolations === 0
    && (metrics.specificResponsive.percentage ?? 0) >= 80
    && (metrics.memoryErrors.percentage ?? 100) < 2
    && (metrics.ordinaryFirstVisibleMs.p90 ?? Infinity) <= 3_000
    && (metrics.ordinaryCompletionMs.p90 ?? Infinity) <= 10_000
    && (metrics.bufferedCompletionMs.p90 ?? Infinity) <= 15_000
    && (metrics.willingnessToContinue.percentage ?? 0) >= 70;
}

/** Stable 20% sampling avoids capturing every consented conversation and is retry-safe. */
export function shouldSampleCompanionTurn(turnId: string): boolean {
  return createHash("sha256").update(turnId).digest()[0] < 51;
}
import { createHash } from "node:crypto";
