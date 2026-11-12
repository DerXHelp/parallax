/** Tab stops of the code view (`[tab-size:4]`). */
export const CODE_TAB_SIZE = 4;

/**
 * Visual offset (in `ch`) of the 1-based character column `col` of `line` in the code view (R5W-10):
 * a column counts characters like editors do, a tab advances to the next tab stop; a column past the
 * end marks the end of the line.
 */
export function columnOffset(line: string, col: number): number {
  const end = Math.min(Math.max(0, Math.floor(col) - 1), line.length);
  let offset = 0;
  for (let index = 0; index < end; index++) {
    offset =
      line.charAt(index) === '\t' ? (Math.floor(offset / CODE_TAB_SIZE) + 1) * CODE_TAB_SIZE : offset + 1;
  }
  return offset;
}
