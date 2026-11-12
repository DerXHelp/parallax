import type { ExtraProps } from 'react-markdown';
import { findFileRefs, type FileRef, type FileRefKind, type FileTarget } from '@web/lib/file-refs';

/**
 * rehype plugin of the Markdown renderer (WP-55): file references in running text (`findFileRefs`)
 * become `<span data-file-ref>` elements that the `span` renderer shows as `FileLink`. Text in links
 * (no link in a link), in code (inline code links itself, code blocks never) is left alone. The
 * plugin only marks – resolving against cwd/baseDir and the stat check happen when rendering. Raw
 * HTML is dropped before (`skipHtml`), so a `data-file-ref` span always comes from here.
 */

type HastElement = NonNullable<ExtraProps['node']>;
type HastContent = HastElement['children'][number];
type HastText = Extract<HastContent, { type: 'text' }>;

/** Elements whose text is never scanned. */
const SKIP = new Set(['a', 'code', 'pre', 'script', 'style']);
const KINDS: ReadonlySet<string> = new Set<FileRefKind>([
  'drive',
  'git_bash',
  'file_url',
  'relative',
  'unc',
  'device',
]);

function isKind(value: unknown): value is FileRefKind {
  return typeof value === 'string' && KINDS.has(value);
}

function refElement(ref: FileRef): HastElement {
  return {
    type: 'element',
    tagName: 'span',
    properties: {
      dataFileRef: ref.kind,
      dataRefPath: ref.path,
      dataRefLine: ref.line,
      dataRefCol: ref.col,
      dataRefUnsafe: ref.unsafe,
    },
    children: [{ type: 'text', value: ref.raw }],
  };
}

function splitText(node: HastText): HastContent[] | null {
  const refs = findFileRefs(node.value);
  if (refs.length === 0) return null;
  const parts: HastContent[] = [];
  let position = 0;
  for (const ref of refs) {
    if (ref.start > position) parts.push({ type: 'text', value: node.value.slice(position, ref.start) });
    parts.push(refElement(ref));
    position = ref.end;
  }
  if (position < node.value.length) parts.push({ type: 'text', value: node.value.slice(position) });
  return parts;
}

function visit(parent: { children: HastContent[] }): void {
  const children: HastContent[] = [];
  let changed = false;
  for (const child of parent.children) {
    if (child.type === 'text') {
      const parts = splitText(child);
      if (parts !== null) {
        children.push(...parts);
        changed = true;
        continue;
      }
    } else if (child.type === 'element' && !SKIP.has(child.tagName)) {
      visit(child);
    }
    children.push(child);
  }
  if (changed) parent.children = children;
}

export function rehypeFileRefs() {
  return (tree: { children: HastContent[] }): void => {
    visit(tree);
  };
}

function numberOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** The reference a `span` of this plugin carries, else null (any other span). */
export function fileRefOf(node: HastElement | undefined): FileTarget | null {
  const properties = node?.properties;
  if (properties === undefined) return null;
  const kind = properties.dataFileRef;
  const path = properties.dataRefPath;
  if (!isKind(kind) || typeof path !== 'string') return null;
  return {
    path,
    kind,
    line: numberOf(properties.dataRefLine),
    col: numberOf(properties.dataRefCol),
    endLine: null,
    unsafe: properties.dataRefUnsafe !== false,
  };
}
