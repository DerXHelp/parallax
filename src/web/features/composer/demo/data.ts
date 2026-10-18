import { makeError } from '@shared/errors';
import type { BlobRef, SlashCommandInfo } from '@shared/model';
import type { DemoData } from '../../decisions/lib/demo-data';
import type { AttachmentUploader } from '../lib/upload';
import { UploadError } from '../lib/upload';

/**
 * Data of the composer demos (dev only): a slash catalog like `supportedCommands()` reports it
 * (F.12, shortened), a fake uploader and generated sample screenshots.
 */

const builtin = (name: string, description: string, argumentHint = '', aliases: string[] = []) => ({
  name,
  description,
  argumentHint,
  aliases,
  builtin: true,
});

export const DEMO_COMMANDS: SlashCommandInfo[] = [
  builtin('clear', 'Clear conversation history and free up context', '[name]', ['reset', 'new']),
  builtin(
    'compact',
    'Clear conversation history but keep a summary in context',
    '<optional custom summarization instructions>',
  ),
  builtin('context', 'Visualize current context usage as a colored grid'),
  builtin('cost', 'Show the total cost and duration of the current session'),
  builtin('init', 'Initialize a new CLAUDE.md file with codebase documentation'),
  builtin('model', 'Set the AI model for Claude Code', '[model]'),
  builtin('review', 'Review a pull request', '[pr]'),
  builtin('security-review', 'Complete a security review of the pending changes on the current branch'),
  builtin('usage', 'Show plan usage limits'),
  builtin('vim', 'Toggle between Vim and Normal editing modes'),
  builtin('theme', 'Change the theme'),
  builtin('config', 'Open config panel', '[key=value]', ['settings']),
  {
    name: 'simplify',
    description: 'Review the changed code for reuse, simplification and efficiency (skill)',
    argumentHint: '',
    aliases: [],
    builtin: false,
  },
  {
    name: 'deploy-preview',
    description: 'Deploy the branch to a preview environment (.claude/commands)',
    argumentHint: '<environment>',
    aliases: [],
    builtin: false,
  },
  {
    name: 'mcp__github__create_issue',
    description: 'Create a GitHub issue from the conversation (MCP prompt)',
    argumentHint: '<title>',
    aliases: [],
    builtin: false,
  },
];

/** Changes the detail of every demo session (catalog, suggestion …). */
export function withDetail(data: DemoData, patch: Partial<DemoData['sessions'][number]['detail']>): DemoData {
  return { ...data, sessions: data.sessions.map((s) => ({ ...s, detail: { ...s.detail, ...patch } })) };
}

/** Changes every demo summary. */
export function withSummary(data: DemoData, patch: Partial<DemoData['summaries'][number]>): DemoData {
  return { ...data, summaries: data.summaries.map((s) => ({ ...s, ...patch })) };
}

let uploadCounter = 0;

function fakeBlobId(): string {
  uploadCounter += 1;
  return uploadCounter.toString(16).padStart(64, 'a');
}

/** Uploads after 1.2 s; files whose name contains "fail" get 413, "type" 415. */
export const demoUploader: AttachmentUploader = (image, signal) =>
  new Promise<BlobRef>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (image.name.includes('fail')) reject(new UploadError(makeError('PAYLOAD_TOO_LARGE')));
      else if (image.name.includes('type')) reject(new UploadError(makeError('UNSUPPORTED_MEDIA_TYPE')));
      else {
        resolve({
          blobId: fakeBlobId(),
          mediaType: image.type,
          bytes: image.blob.size,
          width: image.width,
          height: image.height,
          name: image.name,
        });
      }
    }, 1200);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
    });
  });

/** A generated screenshot (canvas → PNG) as a picked file. */
export async function sampleScreenshot(name: string, width = 2560, height = 1440): Promise<File> {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (context !== null) {
    const gradient = context.createLinearGradient(0, 0, width, height);
    gradient.addColorStop(0, '#3b82f6');
    gradient.addColorStop(1, '#8b5cf6');
    context.fillStyle = gradient;
    context.fillRect(0, 0, width, height);
    context.fillStyle = 'rgba(255,255,255,0.85)';
    context.font = `${String(Math.round(height / 12))}px sans-serif`;
    context.fillText(name, width / 20, height / 2);
  }
  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, 'image/png');
  });
  return new File([blob ?? new Blob()], name, { type: 'image/png' });
}
