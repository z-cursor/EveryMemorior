import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

/** Resolve legacy companion provider aliases when a model ID maps uniquely. */
export async function resolveCompanionModel(runtime: ModelRuntime, provider: string, modelId: string) {
  const available = await runtime.getAvailable();
  const exact = available.find((model) => model.provider === provider && model.id === modelId);
  if (exact) return exact;

  const matches = available.filter((model) => model.id === modelId);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) throw new Error(`Companion model ${modelId} matches multiple configured providers`);
  throw new Error(`Companion model ${provider}/${modelId} is not available. Check the model entry and enabled model scope.`);
}
