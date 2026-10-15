import { SquareTerminalIcon } from 'lucide-react';
import { useT } from '@web/i18n';
import { CodeBlock } from '../components/CodeBlock';
import { firstLine } from '../lib/text';
import { readShellInput, readShellResult } from '../lib/tool-input';
import { InputCapNotice, Section, ToolResultText, useToolInput } from './parts';
import { GenericToolBody, GenericToolPreview } from './generic';
import type { ToolBodyProps, ToolPreviewProps, ToolRenderer } from './types';

/**
 * Bash / PowerShell (F.4): command + output (expandable), ANSI colors parsed safely, CRLF
 * normalized, capped output with "Load full text". Background commands (`backgroundTaskId`) and
 * interrupted runs get a note; an empty output shows "No output" instead of the CLI's
 * "(Bash completed with no output)".
 */

const NO_OUTPUT_TEXTS = new Set(['(Bash completed with no output)', '(PowerShell completed with no output)']);

function languageOf(toolName: string) {
  return toolName === 'PowerShell' ? 'powershell' : 'bash';
}

function ShellBody({ item, sessionKey }: ToolBodyProps) {
  const t = useT();
  const input = readShellInput(useToolInput(item));
  if (input === null) return <GenericToolBody item={item} sessionKey={sessionKey} />;
  const result = readShellResult(item.result?.structured ?? null);
  const backgroundId = result?.backgroundTaskId ?? item.task?.taskId ?? null;
  const onlyPlaceholder =
    item.result !== null &&
    item.result.content.length === 1 &&
    item.result.content[0]?.type === 'text' &&
    NO_OUTPUT_TEXTS.has(item.result.content[0].text.text.trim());
  return (
    <>
      <Section label={t('transcript.shell.command')}>
        <CodeBlock code={input.command} language={languageOf(item.toolName)} label={item.toolName} />
        <InputCapNotice item={item} sessionKey={sessionKey} />
      </Section>
      {onlyPlaceholder ? (
        <p className="text-muted-foreground text-xs italic">{t('transcript.shell.noOutput')}</p>
      ) : (
        <ToolResultText item={item} sessionKey={sessionKey} emptyLabel={t('transcript.shell.noOutput')} />
      )}
      {result?.interrupted === true ? (
        <p className="text-muted-foreground text-xs">{t('transcript.shell.interrupted')}</p>
      ) : null}
      {backgroundId !== null && (item.status === 'background' || item.task?.isBackgrounded === true) ? (
        <p className="text-muted-foreground text-xs">
          {t('transcript.shell.background', { id: backgroundId })}
        </p>
      ) : null}
    </>
  );
}

function ShellPreview({ toolName, input }: ToolPreviewProps) {
  const parsed = readShellInput(input);
  if (parsed === null) return <GenericToolPreview toolName={toolName} input={input} />;
  return <CodeBlock code={parsed.command} language={languageOf(toolName)} label={toolName} />;
}

export const shellRenderer: ToolRenderer = {
  icon: SquareTerminalIcon,
  summary: (item) => {
    const input = readShellInput(item.input);
    if (input === null) return null;
    return firstLine(input.description ?? input.command, 160);
  },
  meta: (item) => {
    const input = readShellInput(item.input);
    // The description is the summary – show the command's first line as meta then.
    return input?.description === undefined ? null : firstLine(input.command, 60);
  },
  Body: ShellBody,
  Preview: ShellPreview,
};
