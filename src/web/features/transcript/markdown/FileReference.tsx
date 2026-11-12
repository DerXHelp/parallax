import { createContext, useContext, type ReactNode } from 'react';
import { findFileRefs, resolveFileRef, type FileTarget } from '@web/lib/file-refs';
import { useFeatureSlots } from '@web/shell/slots';

/**
 * File references in Markdown (WP-55, F1): a reference found in text becomes the `FileLink` slot
 * with `verify` – a link only once `file.statMany` found the file –, resolved against `baseDir`
 * (viewer of a Markdown file) or the session's cwd. UNC/device references stay plain text and never
 * reach the slot; without a session (or without a base for a relative one) the text stays text.
 */

export interface FileRefBase {
  sessionKey: string;
  /** Directory relative references resolve against (baseDir ?? cwd), null = none known. */
  base: string | null;
}

/** null: this Markdown links no file references (no session, or the live block while streaming). */
export const FileRefContext = createContext<FileRefBase | null>(null);

/** The absolute path a reference links to under `context`, else null (unsafe, no base, C.10). */
export function linkedPath(target: FileTarget, context: FileRefBase | null): string | null {
  if (context === null || target.unsafe) return null;
  return resolveFileRef(target, context.base);
}

export function FileReference({ target, children }: { target: FileTarget; children: ReactNode }) {
  const context = useContext(FileRefContext);
  const { FileLink } = useFeatureSlots();
  const path = linkedPath(target, context);
  if (context === null || path === null) {
    return <span data-file-ref={target.unsafe ? 'unsafe' : 'text'}>{children}</span>;
  }
  return (
    <FileLink sessionKey={context.sessionKey} path={path} line={target.line} col={target.col} verify>
      {children}
    </FileLink>
  );
}

/** Text with its file references as `FileReference` (inline code). */
export function LinkedText({ text }: { text: string }): ReactNode {
  const context = useContext(FileRefContext);
  const refs = context === null ? [] : findFileRefs(text);
  if (refs.length === 0) return text;
  const parts: ReactNode[] = [];
  let position = 0;
  for (const ref of refs) {
    if (ref.start > position) parts.push(text.slice(position, ref.start));
    parts.push(
      <FileReference key={ref.start} target={ref}>
        {ref.raw}
      </FileReference>,
    );
    position = ref.end;
  }
  if (position < text.length) parts.push(text.slice(position));
  return parts;
}
