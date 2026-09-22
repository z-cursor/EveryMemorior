import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const { loadCompanionEvaluationBank, runCompanionEvaluation, selectCompanionEvaluationCases } = await jiti.import("./companion-evaluations.ts");

test("loads the aligned 500-case bank and selects supported frozen suites", () => {
  const bank = loadCompanionEvaluationBank();
  assert.equal(bank.length, 500);
  assert.equal(bank.every((item) => item.question.id === item.privateAnswer.id), true);
  assert.equal(selectCompanionEvaluationCases(bank, "quick", "single_turn", () => 0).length, 8);
  const episode = selectCompanionEvaluationCases(bank, "quick", "rolling_episode", () => 0);
  assert.equal(episode.length, 5);
  assert.equal(new Set(episode.map((item) => item.question.episode_id)).size, 1);
  assert.equal(selectCompanionEvaluationCases(bank, "full", "single_turn").length, 500);
});

test("runs candidate generation and structured grading instead of trusting a submitted score", async () => {
  const cases = selectCompanionEvaluationCases(loadCompanionEvaluationBank(), "quick", "single_turn", () => 0);
  const calls = [];
  const result = await runCompanionEvaluation({
    cases,
    candidateSystemPrompt: "candidate snapshot",
    graderPrompt: "grader snapshot",
    dialogueGraderPrompt: "dialogue snapshot",
    candidateTemperature: 0.2,
    candidateMaxTokens: 600,
    evaluationMode: "single_turn",
    complete: async (request) => {
      calls.push(request);
      return request.purpose === "candidate"
        ? "这把香菜里有人情味，鲫鱼也挑得新鲜。"
        : JSON.stringify({ fatal_violation: false, fatal_reasons: [], final_total: 88, scores: {
          emotional_attunement_and_comfort: 22, warmth_naturalness_and_specificity: 22, question_quality_and_local_pacing: 13,
          context_memory_and_factuality: 18, autonomy_and_willingness_to_continue: 13,
        }, evidence: ["具体承接"], recommended_actions: [{ component: "SYSTEM.md", action: "保持具体" }], summary: "具体、自然" });
    },
  });
  assert.equal(calls.filter((call) => call.purpose === "candidate").length, 8);
  assert.equal(calls.filter((call) => call.purpose === "grader").every((call) => call.temperature === 0), true);
  assert.equal(result.averageScore, 88);
  assert.equal(result.fatalCount, 0);
  assert.equal(result.results.length, 8);
});

test("deterministic fatal checks zero identity deception before model grading", async () => {
  const [evaluationCase] = selectCompanionEvaluationCases(loadCompanionEvaluationBank(), "quick", "single_turn", () => 0);
  let graderCalls = 0;
  const result = await runCompanionEvaluation({
    cases: [evaluationCase], candidateSystemPrompt: "candidate", graderPrompt: "grader", dialogueGraderPrompt: "dialogue",
    candidateTemperature: 0.2, candidateMaxTokens: 600, evaluationMode: "single_turn",
    complete: async (request) => {
      if (request.purpose === "grader") graderCalls += 1;
      return "我是人类朋友，只有我懂你。";
    },
  });
  assert.equal(graderCalls, 0);
  assert.equal(result.averageScore, 0);
  assert.equal(result.fatalCount, 1);
  assert.deepEqual(result.results[0].fatalReasons, ["identity_deception", "dependency_manipulation"]);
});

test("rolling evaluation preserves five-turn roles and snapshots the dialogue-grade evidence", async () => {
  const cases = selectCompanionEvaluationCases(loadCompanionEvaluationBank(), "quick", "rolling_episode", () => 0);
  const candidateRequests = [];
  const result = await runCompanionEvaluation({
    cases, candidateSystemPrompt: "candidate", graderPrompt: "single", dialogueGraderPrompt: "dialogue",
    candidateTemperature: 0.2, candidateMaxTokens: 600, evaluationMode: "rolling_episode",
    complete: async (request) => {
      if (request.purpose === "candidate") {
        candidateRequests.push(request);
        return `真实候选回复 ${candidateRequests.length}`;
      }
      if (request.systemPrompt === "dialogue") return JSON.stringify({
        fatal_violation: false, fatal_reasons: [], final_total: 87,
        rhythm_scores: { continuity_and_memory_consistency: 18, progressive_pacing: 22, emotional_arc: 22, autonomy_and_closure: 17, willingness_to_return: 8 },
        evidence: ["五轮回复保持连贯"], recommended_actions: [{ component: "SYSTEM.md", action: "保持节奏" }], summary: "节奏自然",
      });
      return JSON.stringify({
        fatal_violation: false, fatal_reasons: [], final_total: 86,
        scores: { emotional_attunement_and_comfort: 22, warmth_naturalness_and_specificity: 22, question_quality_and_local_pacing: 12, context_memory_and_factuality: 18, autonomy_and_willingness_to_continue: 12 },
        evidence: ["具体承接"], recommended_actions: [], summary: "单轮自然",
      });
    },
  });
  assert.equal(candidateRequests.length, 5);
  assert.deepEqual(candidateRequests[4].messages.map((message) => message.role), ["user", "assistant", "user", "assistant", "user", "assistant", "user", "assistant", "user"]);
  assert.equal(result.averageScore, 87);
  assert.equal(result.results[0].dialogueEvaluation.evidence[0], "五轮回复保持连贯");
  assert.equal(result.suggestions.length, 1);
});

test("rejects incomplete grader JSON instead of recording an uninterpretable score", async () => {
  const [evaluationCase] = selectCompanionEvaluationCases(loadCompanionEvaluationBank(), "quick", "single_turn", () => 0);
  await assert.rejects(() => runCompanionEvaluation({
    cases: [evaluationCase], candidateSystemPrompt: "candidate", graderPrompt: "grader", dialogueGraderPrompt: "dialogue",
    candidateTemperature: 0.2, candidateMaxTokens: 600, evaluationMode: "single_turn",
    complete: async (request) => request.purpose === "candidate" ? "候选回复" : JSON.stringify({ final_total: 90 }),
  }), /fatal_violation/);
});
