import type { PlaygroundDemo } from '@web/playground/types';
import type { FeatureSlots } from '@web/shell/slots';
import { Markdown } from './markdown/Markdown';
import { demoSessionKey, SECURITY_MARKDOWN, type DemoEntry } from './playground/data';
import { TranscriptDemo } from './playground/TranscriptDemo';
import { TRANSCRIPT_SLOTS } from './slots';
import { ToolInputPreview } from './ToolInputPreview';
import { TranscriptView } from './TranscriptView';

/**
 * Playground demos of the transcript (architecture §2.3c, `#playground=transcript/<id>`): every
 * renderer with sample data over the FakeHost. `slots` lets the shell demos show the real
 * transcript (and the Markdown/ToolInputPreview slots used by WP-16).
 */

function transcriptDemo(
  id: string,
  entry: DemoEntry,
  title: string,
  description: string,
  live = false,
): PlaygroundDemo {
  return {
    id,
    title,
    description,
    render: () => (
      <TranscriptDemo live={live}>
        <TranscriptView sessionKey={demoSessionKey(entry)} />
      </TranscriptDemo>
    ),
  };
}

const EDIT_INPUT = {
  file_path: 'D:\\work\\parallax\\src\\shared\\sync.ts',
  old_string: 'const fresh = ops;\nreturn apply(fresh);',
  new_string: 'const fresh = ops.filter((o) => o.seq > state.seq);\nreturn apply(fresh);',
};

function SlotsDemo() {
  return (
    <div className="mx-auto grid max-w-3xl gap-4 p-4">
      <Markdown text={SECURITY_MARKDOWN} />
      <ToolInputPreview toolName="Edit" input={EDIT_INPUT} />
      <ToolInputPreview
        toolName="Write"
        input={{ file_path: 'D:\\work\\notes.txt', content: 'alpha\nbeta\n' }}
      />
      <ToolInputPreview
        toolName="PowerShell"
        input={{ command: 'Get-ChildItem -Name', description: 'List files' }}
      />
      <ToolInputPreview
        toolName="mcp__browser__navigate"
        input={{ url: 'https://example.com', wait: true }}
      />
    </div>
  );
}

export const demos: PlaygroundDemo[] = [
  transcriptDemo(
    'overview',
    'overview',
    'All renderers in one turn',
    'Read, Edit (patch + jsdiff fallback), Write, Bash (ANSI), PowerShell (CRLF), Grep, Glob, MCP, TodoWrite, AskUserQuestion, model badge, costs (API-key profile)',
  ),
  transcriptDemo(
    'streaming',
    'streaming',
    'Streaming deltas',
    'Thinking, tool input and Markdown stream via item.delta; code is highlighted once the fence closes',
    true,
  ),
  transcriptDemo(
    'large-output',
    'large',
    'Capped output',
    '48 Ki cap with "Load full text" (generated blob)',
  ),
  transcriptDemo(
    'system',
    'system',
    'System items',
    'Every system event, turn footers incl. synthetic and errors',
  ),
  transcriptDemo(
    'plan',
    'plan',
    'Plan cards',
    'Open/expired via the DecisionCard slot, approved/revised drawn from tool_call.decision',
  ),
  transcriptDemo(
    'subagent',
    'subagent',
    'Subagents',
    'Agent cards with grouped (collapsed) child items, live runtime',
  ),
  transcriptDemo(
    'long',
    'long',
    'Long transcript (virtualized)',
    '1200 items, trimmed snapshot; scroll up to load earlier',
  ),
  transcriptDemo(
    'security',
    'security',
    'Markdown security',
    'Raw HTML, javascript:/data: links, images, ANSI/OSC escapes',
  ),
  transcriptDemo('queue', 'queue', 'Queued prompts', 'detail.queue shown grey until taken over'),
  transcriptDemo(
    'media',
    'media',
    'Images, lightbox, console handoff, Windows paths (WP-37)',
    'Click a thumbnail: lightbox with zoom (buttons, wheel, + − 0 1), "Save as", Esc; handoff rows; V2-12 paths keep their backslashes',
  ),
  {
    id: 'slots',
    title: 'Markdown and ToolInputPreview slots',
    description: 'Components used by WP-16 (plan text, permission previews)',
    render: () => <SlotsDemo />,
  },
];

export const slots: Partial<FeatureSlots> = TRANSCRIPT_SLOTS;
