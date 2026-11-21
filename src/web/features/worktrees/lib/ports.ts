/** Ports of one worktree's block (ADR-251: 10 ports from `portBase`, the first in `PARALLAX_WORKTREE_PORT`). */
export const WORKTREE_PORT_BLOCK = 10;

/** First and last port of the block that starts at `portBase`. */
export function portRange(portBase: number): { from: number; to: number } {
  return { from: portBase, to: portBase + WORKTREE_PORT_BLOCK - 1 };
}
