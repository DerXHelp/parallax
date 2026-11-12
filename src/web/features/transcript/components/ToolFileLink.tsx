import type { ReactNode } from 'react';
import { resolveFilePath } from '@web/lib/file-refs';
import { useFeatureSlots } from '@web/shell/slots';

/**
 * A path from a tool input or result (Write/Edit/Read/NotebookEdit, Grep/Glob hits, an agent's
 * output file) as the `FileLink` slot without `verify` – the tool named the file itself (WP-55).
 * Relative paths resolve against the cwd; a path that cannot be resolved or fails the C.10 filter
 * (UNC, device) stays plain text.
 */
export function ToolFileLink({
  sessionKey,
  path,
  line = null,
  cwd,
  children,
}: {
  sessionKey: string;
  path: string;
  line?: number | null;
  cwd: string | null;
  children: ReactNode;
}) {
  const { FileLink } = useFeatureSlots();
  const resolved = resolveFilePath(path, cwd);
  if (resolved === null) return <span data-file-ref="text">{children}</span>;
  return (
    <FileLink sessionKey={sessionKey} path={resolved} line={line} verify={false}>
      {children}
    </FileLink>
  );
}
