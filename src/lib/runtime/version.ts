/**
 * The BARRY runtime version every turn trace records. Bump when the
 * operator loop, planner or grounding semantics change in a way HQ should
 * be able to tell apart. The deploy commit (when the platform provides
 * one) pins the exact code.
 */
export const BARRY_RUNTIME_VERSION = "0.3.0-operator";

export function runtimeCommit(): string | null {
  return process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.BARRY_COMMIT_SHA ?? null;
}
