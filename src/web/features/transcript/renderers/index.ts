import { BotIcon, ClipboardListIcon } from 'lucide-react';
import { AgentCard } from '../items/AgentCard';
import { PlanCard } from '../items/PlanCard';
import { readAgentInput } from '../lib/tool-input';
import { editRenderer, writeRenderer } from './edit';
import { genericToolRenderer, isMcpTool, mcpToolRenderer } from './generic';
import { questionRenderer, todoRenderer, webFetchRenderer, webSearchRenderer } from './misc';
import { readRenderer } from './read';
import { globRenderer, grepRenderer } from './search';
import { shellRenderer } from './shell';
import type { ToolRenderer } from './types';

export type { ToolBodyProps, ToolPreviewProps, ToolRenderer, Translate } from './types';
export { genericToolRenderer } from './generic';

const agentRenderer: ToolRenderer = {
  icon: BotIcon,
  summary: (item) => readAgentInput(item.input)?.description ?? null,
  Row: AgentCard,
};

/**
 * Renderer registry (WP-02 §10.3): tool name → renderer. Every other tool – future CLI tools and
 * all MCP tools (`mcp__server__tool`) – uses the generic renderer (input as JSON, result as
 * text/images, structured result on demand), so nothing is ever dropped.
 */
export const toolRenderers: Record<string, ToolRenderer> = {
  Bash: shellRenderer,
  PowerShell: shellRenderer,
  Edit: editRenderer,
  MultiEdit: editRenderer,
  Write: writeRenderer,
  Read: readRenderer,
  Grep: grepRenderer,
  Glob: globRenderer,
  Agent: agentRenderer,
  // Older CLIs called the Agent tool "Task".
  Task: agentRenderer,
  ExitPlanMode: { icon: ClipboardListIcon, Row: PlanCard },
  AskUserQuestion: questionRenderer,
  TodoWrite: todoRenderer,
  WebFetch: webFetchRenderer,
  WebSearch: webSearchRenderer,
};

/** Renderer of a tool; never undefined (generic fallback, MCP tools with a plug icon). */
export function getToolRenderer(toolName: string): ToolRenderer {
  if (Object.hasOwn(toolRenderers, toolName)) {
    const renderer = toolRenderers[toolName];
    if (renderer !== undefined) return renderer;
  }
  return isMcpTool(toolName) ? mcpToolRenderer : genericToolRenderer;
}
