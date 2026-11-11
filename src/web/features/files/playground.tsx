import { useEffect } from 'react';
import { makeSessionKey } from '@shared/common';
import { SAMPLE_IDS } from '@shared/samples';
import type { PlaygroundDemo } from '@web/playground/types';
import { requestShell, type SidePanelTab } from '@web/shell/requests';
import { SidePanelHost } from '@web/shell/side-panel/SidePanelHost';
import { closeSidePanel, openSidePanel, setSidePanelFile } from '@web/shell/side-panel/state';
import { FeatureSlotsProvider, type FeatureSlots } from '@web/shell/slots';
import { FAKE_FILE_PATHS, type FakeHost } from '@web/state/fake-host';
import { FileLink } from './FileLink';
import { FilePanel } from './FilePanel';
import { FilesPanel } from './FilesPanel';
import { setFileSource } from './state/file-source';
import { DemoButton, DemoNote, FilesDemo, staticDemoSource } from './playground/FilesDemo';
import { FILES_SESSION_KEY } from './testing';

/**
 * Playground demos of the files feature (architecture §2.3c, `#playground=files/<id>`): the side
 * panel host with every tab (wide and narrow window), the viewer per kind (incl. error, cut text,
 * line jump, live reload), the FileLink variants and "Files of this session" – all over the FakeHost
 * file table (state/fake-host.ts) with generated media. `slots` puts the real panels and links into
 * the shell demos (their content comes from `staticDemoSource`).
 */

// The playground has no GET /api/file: demos outside a FilesDemo read the fake table.
setFileSource(staticDemoSource);

/** The real (non-lazy) components; App.tsx wires the lazy ones from index.ts (WP-60). */
const DEMO_SLOTS: Partial<FeatureSlots> = { FileLink, FilePanel, FilesPanel };

const REMOTE_KEY = makeSessionKey('remote-1', SAMPLE_IDS.entry);

interface HostSetup {
  tab: SidePanelTab;
  file?: { path: string; line: number | null };
}

function changeOnDisk(host: FakeHost, path: string): void {
  const text = host.fileText(path);
  host.touchFile(
    path,
    text === null ? {} : { text: `${text}\n// changed ${new Date().toLocaleTimeString()}` },
  );
}

/** Transcript stand-in on the left, the real side panel host on the right. */
function HostLayout({ host, width, setup }: { host: FakeHost; width: number | null; setup: HostSetup }) {
  useEffect(() => {
    if (setup.file !== undefined) {
      setSidePanelFile(FILES_SESSION_KEY, { ...setup.file, col: null });
    }
    openSidePanel(FILES_SESSION_KEY, setup.tab);
    return () => {
      closeSidePanel(FILES_SESSION_KEY);
    };
  }, [setup]);
  const open = (tab: SidePanelTab) => () => {
    requestShell({ kind: 'sidePanel', sessionKey: FILES_SESSION_KEY, tab });
  };
  return (
    <div className="flex h-full min-h-0 flex-col gap-2 p-4">
      <div className="flex flex-wrap gap-2">
        <DemoButton label="Tab Plan" onClick={open('plan')} />
        <DemoButton label="Tab Files" onClick={open('files')} />
        <DemoButton label="Tab Tasks" onClick={open('tasks')} />
        <DemoButton
          label="Finish an Edit on main.ts"
          onClick={() => {
            host.emitFileToolCall(SAMPLE_IDS.entry, { toolName: 'Edit', path: FAKE_FILE_PATHS.main });
          }}
        />
        <DemoButton
          label="Write docs/new.md"
          onClick={() => {
            host.emitFileToolCall(SAMPLE_IDS.entry, {
              toolName: 'Write',
              path: 'D:\\work\\sample\\docs\\new.md',
            });
          }}
        />
      </div>
      <div
        style={width === null ? undefined : { width, maxWidth: '100%' }}
        className="bg-background flex min-h-[560px] flex-1 overflow-hidden rounded-md border"
      >
        <div className="flex min-w-0 flex-1 flex-col gap-3 overflow-auto p-4 text-sm">
          <DemoNote text="Transcript stand-in. Click opens the viewer, Ctrl+click or middle click the editor (FakeHost records file.open), right click shows the actions." />
          <p className="flex flex-wrap gap-x-4 gap-y-1">
            <FileLink sessionKey={FILES_SESSION_KEY} path={FAKE_FILE_PATHS.readme} verify />
            <FileLink sessionKey={FILES_SESSION_KEY} path={FAKE_FILE_PATHS.main} line={26} verify />
            <FileLink sessionKey={FILES_SESSION_KEY} path={FAKE_FILE_PATHS.log} verify />
            <FileLink sessionKey={FILES_SESSION_KEY} path={FAKE_FILE_PATHS.image} verify />
            <FileLink sessionKey={FILES_SESSION_KEY} path={FAKE_FILE_PATHS.pdf} verify />
            <FileLink sessionKey={FILES_SESSION_KEY} path={FAKE_FILE_PATHS.binary} verify />
          </p>
        </div>
        <SidePanelHost sessionKey={FILES_SESSION_KEY} />
      </div>
    </div>
  );
}

function HostDemo({ setup, width }: { setup: HostSetup; width: number | null }) {
  return (
    <FeatureSlotsProvider slots={DEMO_SLOTS}>
      <FilesDemo>{(host) => <HostLayout host={host} width={width} setup={setup} />}</FilesDemo>
    </FeatureSlotsProvider>
  );
}

function hostDemo(
  id: string,
  title: string,
  description: string,
  setup: HostSetup,
  width: number | null,
): PlaygroundDemo {
  return { id, title, description, render: () => <HostDemo setup={setup} width={width} /> };
}

function ViewerDemo({ path, line = null }: { path: string; line?: number | null }) {
  return (
    <FeatureSlotsProvider slots={DEMO_SLOTS}>
      <FilesDemo>
        {(host) => (
          <div className="flex h-full min-h-0 flex-col gap-2 p-4">
            <div className="flex flex-wrap gap-2">
              <DemoButton
                label="Change on disk (the 2 s poll picks it up)"
                onClick={() => {
                  changeOnDisk(host, path);
                }}
              />
              <DemoButton
                label="Finish an Edit tool call (reloads at once)"
                onClick={() => {
                  changeOnDisk(host, path);
                  host.emitFileToolCall(SAMPLE_IDS.entry, { toolName: 'Edit', path });
                }}
              />
            </div>
            <div className="bg-background flex h-[640px] w-[600px] max-w-full min-h-0 flex-col overflow-hidden rounded-md border">
              <FilePanel sessionKey={FILES_SESSION_KEY} path={path} line={line} col={null} />
            </div>
          </div>
        )}
      </FilesDemo>
    </FeatureSlotsProvider>
  );
}

function viewerDemo(
  id: string,
  title: string,
  path: string,
  line: number | null = null,
  description?: string,
): PlaygroundDemo {
  return { id, title, description, render: () => <ViewerDemo path={path} line={line} /> };
}

function LinksDemo() {
  return (
    <FeatureSlotsProvider slots={DEMO_SLOTS}>
      <FilesDemo>
        {() => (
          // The host measures its parent as the session area (like SessionPane): links and panel share it.
          <div className="bg-background m-4 flex min-h-[560px] flex-1 overflow-hidden rounded-md border">
            <div className="flex min-w-0 flex-1 flex-col gap-3 overflow-auto p-4 text-sm">
              <DemoNote text="inline + verify: README (ok) · missing (FILE_NOT_FOUND → text) · outside (PATH_NOT_ALLOWED → dotted, tooltip) · UNC and device paths (text, no command)" />
              <p className="flex flex-wrap gap-x-4 gap-y-1">
                <FileLink sessionKey={FILES_SESSION_KEY} path={FAKE_FILE_PATHS.readme} verify />
                <FileLink sessionKey={FILES_SESSION_KEY} path={FAKE_FILE_PATHS.missing} verify />
                <FileLink sessionKey={FILES_SESSION_KEY} path={FAKE_FILE_PATHS.outside} verify />
                <FileLink sessionKey={FILES_SESSION_KEY} path="\\server\share\notes.md" verify />
                <FileLink sessionKey={FILES_SESSION_KEY} path="\\?\C:\secret.txt" />
              </p>
              <DemoNote text="chip: icon by kind, name, path tail" />
              <div className="flex flex-wrap gap-2">
                <FileLink sessionKey={FILES_SESSION_KEY} path={FAKE_FILE_PATHS.main} variant="chip" verify />
                <FileLink sessionKey={FILES_SESSION_KEY} path={FAKE_FILE_PATHS.image} variant="chip" verify />
                <FileLink sessionKey={FILES_SESSION_KEY} path={FAKE_FILE_PATHS.pdf} variant="chip" verify />
                <FileLink sessionKey={FILES_SESSION_KEY} path={FAKE_FILE_PATHS.log} variant="chip" verify />
                <FileLink
                  sessionKey={FILES_SESSION_KEY}
                  path={FAKE_FILE_PATHS.folder}
                  variant="chip"
                  verify
                />
              </div>
              <DemoNote text="menu: the actions button only (README, main.ts, refused path → nothing)" />
              <div className="flex items-center gap-2">
                <FileLink sessionKey={FILES_SESSION_KEY} path={FAKE_FILE_PATHS.readme} variant="menu" />
                <FileLink sessionKey={FILES_SESSION_KEY} path={FAKE_FILE_PATHS.main} variant="menu" />
                <FileLink
                  sessionKey={FILES_SESSION_KEY}
                  path={FAKE_FILE_PATHS.outside}
                  variant="menu"
                  verify
                />
              </div>
              <DemoNote text="remote host: viewer and copy only (no editor, no Explorer)" />
              <p>
                <FileLink sessionKey={REMOTE_KEY} path={FAKE_FILE_PATHS.readme} />
              </p>
            </div>
            <SidePanelHost sessionKey={FILES_SESSION_KEY} />
          </div>
        )}
      </FilesDemo>
    </FeatureSlotsProvider>
  );
}

export const demos: PlaygroundDemo[] = [
  hostDemo(
    'host',
    'Files – Side panel host (all tabs)',
    'Plan · File · Files · Tasks, splitter (arrows ± 16 px, Home/End), back and history, Esc closes',
    { tab: 'file', file: { path: FAKE_FILE_PATHS.main, line: 11 } },
    1240,
  ),
  hostDemo(
    'narrow',
    'Files – Narrow window (overlay below 1100 px)',
    'The panel lies over the transcript, no focus trap, Esc closes',
    { tab: 'file', file: { path: FAKE_FILE_PATHS.readme, line: null } },
    900,
  ),
  hostDemo(
    'files-panel',
    'Files – Files of this session',
    'files.session, filter, op badges, relative paths; the buttons finish tool calls (refresh after 2 s)',
    { tab: 'files' },
    1240,
  ),
  viewerDemo(
    'viewer-markdown',
    'Files – Viewer: Markdown',
    FAKE_FILE_PATHS.readme,
    null,
    'Rendered (slot Markdown, baseDir) or source',
  ),
  viewerDemo(
    'viewer-code',
    'Files – Viewer: code with line jump',
    FAKE_FILE_PATHS.main,
    26,
    'Shiki, line numbers, line 26 marked and focused',
  ),
  viewerDemo(
    'viewer-truncated',
    'Files – Viewer: big log (cut)',
    FAKE_FILE_PATHS.log,
    3000,
    '6 000 lines virtualized, plain text, “shortened” hint',
  ),
  viewerDemo(
    'viewer-image',
    'Files – Viewer: image',
    FAKE_FILE_PATHS.image,
    null,
    'Fit / 100 %, click opens the lightbox',
  ),
  viewerDemo(
    'viewer-pdf',
    'Files – Viewer: PDF',
    FAKE_FILE_PATHS.pdf,
    null,
    'Chrome PDF viewer in an iframe, fallbacks below',
  ),
  viewerDemo('viewer-binary', 'Files – Viewer: binary file', FAKE_FILE_PATHS.binary),
  viewerDemo('viewer-folder', 'Files – Viewer: folder', FAKE_FILE_PATHS.folder),
  viewerDemo(
    'viewer-error',
    'Files – Viewer: error (not shared)',
    FAKE_FILE_PATHS.outside,
    null,
    'PATH_NOT_ALLOWED as Alert',
  ),
  {
    id: 'links',
    title: 'Files – FileLink variants',
    description: 'verified, refused, UNC; inline, chip, menu; remote host',
    render: () => <LinksDemo />,
  },
];

/** Real panels and links for the playground's shell demos. */
export const slots: Partial<FeatureSlots> = DEMO_SLOTS;
