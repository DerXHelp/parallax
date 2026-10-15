import { memo } from 'react';
import type { JsonValue } from '@shared/common';
import { getToolRenderer } from './renderers';
import { GenericToolPreview } from './renderers/generic';

/**
 * Slot `ToolInputPreview` (WP-15 → WP-16, permission cards): the input of a tool before it runs –
 * Edit/MultiEdit as a diff (jsdiff of `old_string`/`new_string`), Write as new content,
 * Bash/PowerShell as the command, everything else as JSON.
 */
export const ToolInputPreview = memo(function ToolInputPreview({
  toolName,
  input,
  sessionKey,
}: {
  toolName: string;
  input: JsonValue;
  sessionKey?: string;
}) {
  const Preview = getToolRenderer(toolName).Preview ?? GenericToolPreview;
  return (
    <div data-slot="tool-input-preview" data-tool={toolName} className="min-w-0">
      <Preview toolName={toolName} input={input} sessionKey={sessionKey} />
    </div>
  );
});
