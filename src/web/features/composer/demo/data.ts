import { LIMITS } from '@shared/common';
import { makeError } from '@shared/errors';
import type { BlobRef, ModelOption, SlashCommandInfo } from '@shared/model';
import { sampleModelOption } from '@shared/samples';
import { ClientCommandError } from '@web/state/connection';
import type { DemoData } from '../../decisions/lib/demo-data';
import type { ProjectFilesLoader } from '../lib/project-files';
import type { AttachmentUploader } from '../lib/upload';
import { UploadError } from '../lib/upload';

/**
 * Data of the composer demos (dev only): a slash catalog like `supportedCommands()` reports it
 * (F.12, shortened), a fake uploader, generated sample screenshots and documents, the 14 models
 * of CLI 2.1.322, a project file list for the @ picker and synthetic paste/drop events.
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

/** Uploads after 1.2 s (images, PDFs, files); names containing "fail" get 413, "type" 415. */
export const demoUploader: AttachmentUploader = (upload, signal) =>
  new Promise<BlobRef>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (upload.name.includes('fail')) reject(new UploadError(makeError('PAYLOAD_TOO_LARGE')));
      else if (upload.name.includes('type')) reject(new UploadError(makeError('UNSUPPORTED_MEDIA_TYPE')));
      else {
        resolve({
          blobId: fakeBlobId(),
          mediaType: upload.type,
          bytes: upload.blob.size,
          width: upload.width ?? null,
          height: upload.height ?? null,
          name: upload.name,
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

/** A small PDF (only the header matters for the fake uploader). */
export function samplePdf(name: string, bytes = 184_320): File {
  const body = new Uint8Array(bytes);
  body.set(new TextEncoder().encode('%PDF-1.7\n'));
  return new File([body], name, { type: 'application/pdf' });
}

/** Any other file (zip, log …). */
export function sampleFile(name: string, type: string, bytes: number): File {
  return new File([new Uint8Array(bytes)], name, { type });
}

/** A PDF over `LIMITS.pdfBytes`: an error chip without an upload. */
export function oversizedPdf(): File {
  return samplePdf('Scan 600 dpi.pdf', LIMITS.pdfBytes + 1);
}

// ---- models (WP-57: the picker with 14 rows, like FAKE_MODELS of WP-52 / CLI 2.1.322) ----

const EVERYDAY = 'Best for everyday, complex tasks';
const HARDEST = 'Most capable for your hardest and longest-running tasks';
const FULL_EFFORT: ModelOption['supportedEffortLevels'] = ['low', 'medium', 'high', 'xhigh', 'max'];

function demoModel(value: string, displayName: string, description: string, fast = false): ModelOption {
  return sampleModelOption({
    value,
    displayName,
    description,
    supportedEffortLevels: FULL_EFFORT,
    supportsFastMode: fast,
  });
}

export const DEMO_MODELS_14: ModelOption[] = [
  demoModel('default', 'Default (recommended)', `Opus 5.5 · ${EVERYDAY}`, true),
  demoModel('opus', 'Opus 5.5', 'For complex work and everyday tasks', true),
  demoModel('fable', 'Fable 5.2', 'For your toughest challenges', true),
  demoModel('sonnet', 'Sonnet 5.5', 'Most efficient for simpler tasks'),
  demoModel('haiku', 'Haiku 5.5', 'Fastest for quick answers'),
  demoModel('claude-fable-5-1', 'Fable 5.1', HARDEST),
  demoModel('claude-haiku-4-5-20251001', 'Haiku 4.5', 'Fastest for quick answers'),
  demoModel('claude-sonnet-5', 'Sonnet 5', 'Efficient for routine tasks'),
  demoModel('claude-opus-5', 'Opus 5', EVERYDAY, true),
  demoModel('claude-fable-5', 'Fable 5', HARDEST),
  demoModel('claude-opus-4-8', 'Opus 4.8', EVERYDAY, true),
  demoModel('claude-opus-4-7', 'Opus 4.7', EVERYDAY),
  demoModel('claude-opus-4-6', 'Opus 4.6', EVERYDAY),
  demoModel('claude-sonnet-4-6', 'Sonnet 4.6', 'Efficient for routine tasks'),
];

// ---- @ picker (ADR-151): a project list and a loader with selectable behaviour ----

export const DEMO_PROJECT_FILES: readonly string[] = [
  '.gitignore',
  'CLAUDE.md',
  'README.md',
  'package.json',
  'pnpm-workspace.yaml',
  'tsconfig.json',
  'vite.config.ts',
  'docs/architecture.md',
  'docs/decisions.md',
  'docs/plan.md',
  'docs/progress.md',
  'docs/Meeting Notes/2026-10 Planung.md',
  'docs/Meeting Notes/Review Phase 3.md',
  'docs/wp/WP-57.md',
  'scripts/preflight.ts',
  'src/server/main.ts',
  'src/server/files/service.ts',
  'src/server/http/uploads.ts',
  'src/server/sessions/engine.ts',
  'src/shared/common.ts',
  'src/shared/errors.ts',
  'src/shared/protocol.ts',
  'src/web/App.tsx',
  'src/web/features/composer/Composer.tsx',
  'src/web/features/composer/FileMentionMenu.tsx',
  'src/web/features/composer/PasteChips.tsx',
  'src/web/features/composer/lib/mentions.ts',
  'src/web/features/composer/lib/pastes.ts',
  'src/web/features/composer/state/drafts.ts',
  'src/web/features/files/FileViewer.tsx',
  'src/web/shell/SessionPane.tsx',
  'src/web/ui/command-list.tsx',
  'test/setup.ts',
];

export type DemoFilesMode = 'ready' | 'slow' | 'truncated' | 'error';

let filesMode: DemoFilesMode = 'ready';

/** Behaviour of the next opening of the picker (each opening asks the loader once). */
export function setDemoFilesMode(mode: DemoFilesMode): void {
  filesMode = mode;
}

/** 20 000 generated paths – the server's cut (`LIMITS.projectFilesMax`). */
function truncatedList(): string[] {
  const paths = [...DEMO_PROJECT_FILES];
  for (let index = 0; paths.length < LIMITS.projectFilesMax; index += 1) {
    paths.push(`node_modules/.cache/module-${String(index).padStart(5, '0')}/index.js`);
  }
  return paths;
}

/** `files.project` without a server: fast, slow (4 s loading), cut at 20 000 or failing. */
export const demoProjectFiles: ProjectFilesLoader = () => {
  const mode = filesMode;
  return new Promise((resolve, reject) => {
    setTimeout(
      () => {
        if (mode === 'error') reject(new ClientCommandError(makeError('FOLDER_NOT_READABLE')));
        else if (mode === 'truncated') resolve({ files: truncatedList(), truncated: true });
        else resolve({ files: DEMO_PROJECT_FILES, truncated: false });
      },
      mode === 'slow' ? 4000 : 250,
    );
  });
};

// ---- synthetic paste and drop (the real handlers of the field run) ----

/** A log of `lines` lines – from 30 lines (or 2 000 characters) on it becomes a paste chip. */
export function sampleLog(lines: number): string {
  return Array.from(
    { length: lines },
    (_, index) =>
      `2026-11-12T09:${String(Math.floor(index / 60) % 60).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}Z ` +
      `${index % 7 === 0 ? 'WARN' : 'INFO'} sync hub: applied op ${String(index + 1)} (entry en_demo)`,
  ).join('\n');
}

function composerField(): HTMLTextAreaElement | null {
  return document.querySelector<HTMLTextAreaElement>('[data-slot="composer"] textarea');
}

/** Pastes `text` into the composer field like Ctrl+V. */
export function pasteIntoComposer(text: string): void {
  const field = composerField();
  if (field === null) return;
  field.focus();
  const data = new DataTransfer();
  data.setData('text/plain', text);
  field.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
}

/** Drops a folder and a file on the composer: the folder is left out with a hint. */
export function dropFolderOnComposer(): void {
  const target = document.querySelector('[data-slot="composer"]');
  if (target === null) return;
  const file = new File(['# Notes\n'], 'notes.md', { type: 'text/markdown' });
  const items = [
    { kind: 'file', type: '', getAsFile: () => null, webkitGetAsEntry: () => ({ isDirectory: true }) },
    {
      kind: 'file',
      type: file.type,
      getAsFile: () => file,
      webkitGetAsEntry: () => ({ isDirectory: false }),
    },
  ];
  const event = new Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', {
    value: { types: ['Files'], items, files: [file], dropEffect: 'none' },
  });
  target.dispatchEvent(event);
}
