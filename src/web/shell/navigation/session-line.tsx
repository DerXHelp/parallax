import { HandIcon } from 'lucide-react';
import { useT } from '@web/i18n';
import { parseMcpName, type SessionLine } from '@web/lib/activity';
import { cn } from '@web/lib/cn';

/**
 * WP-65 §1.1: the words of a session's second line (`@web/lib/activity` decides which line):
 * CLI texts as sent (English), Parallax's live line through `navigation.activity.*`.
 */
export function useSessionLineText(line: SessionLine | null): string | null {
  const t = useT();
  if (line === null) return null;
  switch (line.kind) {
    case 'claude':
    case 'summary':
      return line.text;
    case 'thinking':
      return t('navigation.activity.thinking');
    case 'tool': {
      const mcp = parseMcpName(line.tool);
      // The transcript's wording of an MCP tool ("search · github").
      const tool = mcp === null ? line.tool : t('transcript.tool.mcp', { tool: mcp.tool, server: mcp.server });
      if (line.target === null) return t('navigation.activity.toolOnly', { tool });
      return line.verb === 'tool'
        ? t('navigation.activity.tool', { tool, target: line.target })
        : t(`navigation.activity.${line.verb}`, { target: line.target });
    }
  }
}

/**
 * The line itself: quiet (muted) while working or done; "needs you" (open decision, error, the
 * CLI's `needs_action`) in the waiting color with a hand symbol and a screen-reader prefix – never
 * color alone.
 */
export function SessionLineText({ line, className }: { line: SessionLine; className?: string }) {
  const t = useT();
  const text = useSessionLineText(line);
  return (
    <span
      data-slot="session-line"
      data-line={line.kind}
      data-attention={line.attention ? 'true' : undefined}
      className={cn('min-w-0 truncate', line.attention ? 'text-status-waiting' : 'text-muted-foreground', className)}
    >
      {line.attention ? (
        <>
          <HandIcon aria-hidden className="mr-1 inline size-3 align-[-2px]" />
          <span className="sr-only">{t('navigation.row.needsYou')}</span>
        </>
      ) : null}
      {text}
    </span>
  );
}
