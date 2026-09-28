/** Mirrors the existing publication precondition for UI guidance only.
 * The server still authorizes and validates every publish request.
 */
export function publicationBlocker(configVersionId: string, evaluations: ReadonlyArray<{
  configVersionId: string;
  status: string;
  fatalCount: number;
  averageScore: number;
}>): string | null {
  const completed = evaluations.filter((run) => run.configVersionId === configVersionId && run.status === "completed");
  if (completed.some((run) => run.fatalCount === 0 && run.averageScore >= 85)) return null;
  if (completed.length === 0) return "请先为这个版本完成一次快速评测。";
  return "需要同一版本的已完成评测：致命问题为 0，且平均分不少于 85。";
}
