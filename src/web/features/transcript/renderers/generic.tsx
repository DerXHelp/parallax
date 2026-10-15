import { PlugIcon, WrenchIcon } from 'lucide-react';
import { useT } from '@web/i18n';
import { Disclosure } from '../components/Disclosure';
import { firstLine } from '../lib/text';
import { expansionKey } from '../state/expansion';
import {
  InputCapNotice,
  JsonBlock,
  Section,
  ToolResultText,
  firstStringValue,
  parseMcpName,
  useToolInput,
} from './parts';
import type { ToolBodyProps, ToolPreviewProps, ToolRenderer } from './types';

/** Input as JSON, result as text/images, structured result (MCP `structuredContent` …) on demand. */
export function GenericToolBody({ item, sessionKey }: ToolBodyProps) {
  const t = useT();
  const input = useToolInput(item);
  const hasInput = input !== null && !(typeof input === 'object' && Object.keys(input).length === 0);
  const structured = item.result?.structured ?? null;
  return (
    <>
      {hasInput ? (
        <Section label={t('transcript.generic.input')}>
          <JsonBlock value={input} />
          <InputCapNotice item={item} sessionKey={sessionKey} />
        </Section>
      ) : null}
      <ToolResultText item={item} sessionKey={sessionKey} />
      {structured === null ? null : (
        <Disclosure
          stateKey={expansionKey(sessionKey, item.id, 'structured')}
          header={<span className="text-muted-foreground text-xs">{t('transcript.generic.structured')}</span>}
        >
          <div className="mt-1">
            <JsonBlock value={structured} />
          </div>
        </Disclosure>
      )}
      {(item.result?.structuredTruncated ?? null) === null ? null : (
        <p className="text-muted-foreground text-2xs">{t('transcript.capped.structured')}</p>
      )}
    </>
  );
}

export function GenericToolPreview({ input }: ToolPreviewProps) {
  return <JsonBlock value={input} />;
}

/** Fallback for every tool without an own renderer – including future and MCP tools. */
export const genericToolRenderer: ToolRenderer = {
  icon: WrenchIcon,
  summary: (item) => {
    const value = firstStringValue(item.input);
    return value === null ? null : firstLine(value, 120);
  },
  Body: GenericToolBody,
  Preview: GenericToolPreview,
};

/** MCP tools (`mcp__server__tool`): generic body with a plug icon. */
export const mcpToolRenderer: ToolRenderer = { ...genericToolRenderer, icon: PlugIcon };

export function isMcpTool(toolName: string): boolean {
  return parseMcpName(toolName) !== null;
}
