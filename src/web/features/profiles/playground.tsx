import { useEffect, useEffectEvent, useState, type ReactNode } from 'react';
import { STANDARD_PROFILE_ID } from '@shared/common';
import { sampleId, sampleSummary } from '@shared/samples';
import { useI18n } from '@web/i18n';
import type { PlaygroundDemo, PlaygroundModule } from '@web/playground/types';
import { FolderBrowser } from '@web/shell/new-session/FolderBrowser';
import { NewSessionDialog, type NewSessionPrefill } from '@web/shell/NewSessionDialog';
import { requestShell } from '@web/shell/requests';
import { useConnectionStatus } from '@web/state/hooks';
import { useSettings } from '@web/state/settings';
import { Button } from '@web/ui/button';
import type { ProfileSelection } from './components/ProfileList';
import { DEMO_PROFILE_IDS, startProfilesDemo, type ProfilesDemoOptions } from './lib/demo-host';
import { ProfilesSettings } from './ProfilesSettings';

/**
 * WP-36 demos (playground point 5): "New session" with and without prefill, the folder browser
 * (roots, a folder, an unreadable start folder) and the profile editor (new, the default profile,
 * findings, in use) – all over the FakeHost with the in-memory profile server (lib/demo-host.ts).
 */

const MINUTE = 60_000;

/** Sessions of the demo host: recent projects (one archived, one with a different case). */
function demoSummaries() {
  const now = Date.now();
  const rows: [number, string, number, boolean][] = [
    [1, 'D:\\work\\parallax', 2, false],
    [2, 'D:\\work\\api\\tests', 15, false],
    [3, 'd:\\WORK\\parallax', 30, false],
    [4, 'D:\\work\\web\\landing', 60, true],
    [5, 'C:\\Users\\user\\Documents', 300, false],
  ];
  return rows.map(([n, cwd, minutesAgo, archived]) =>
    sampleSummary({
      entryId: sampleId('en', 600 + n),
      cwd,
      title: cwd,
      archived,
      lastActivityAt: new Date(now - minutesAgo * MINUTE).toISOString(),
    }),
  );
}

/**
 * Runs the demo host while mounted; the window's language/theme stay (host state settings). The
 * children mount only once the connection is open: child effects run before this one, and a
 * folder browser that is open from the start would otherwise list before the host exists.
 */
function DemoHost({ options, children }: { options?: ProfilesDemoOptions; children: ReactNode }) {
  const settings = useSettings();
  const online = useConnectionStatus() === 'open';
  const [started] = useState(() => ({ settings }));
  const start = useEffectEvent(() =>
    startProfilesDemo({
      summaries: demoSummaries(),
      ...options,
      hostState: { settings: started.settings, ...options?.hostState },
    }),
  );
  useEffect(() => {
    const running = start();
    return () => {
      running.stop();
    };
  }, []);
  return online ? children : null;
}

/** Opens "New session" through the request channel once the dialog's handler is mounted. */
function OpenNewSession({ prefill }: { prefill: NewSessionPrefill }) {
  const open = useEffectEvent(() => requestShell({ kind: 'newSession', ...prefill }));
  useEffect(() => {
    let tries = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const run = () => {
      if (open() || ++tries > 50) return;
      timer = setTimeout(run, 100);
    };
    timer = setTimeout(run, 50);
    return () => {
      if (timer !== null) clearTimeout(timer);
    };
  }, []);
  return null;
}

function BrowserDemo({ initialPath }: { initialPath: string | null }) {
  const { t } = useI18n();
  const [chosen, setChosen] = useState<string | null>(null);
  return (
    <div className="grid justify-items-start gap-3 p-6">
      <FolderBrowser initialPath={initialPath} defaultOpen onSelect={setChosen}>
        <Button variant="outline">{t('newSession.cwd.browse')}</Button>
      </FolderBrowser>
      {chosen === null ? null : <code className="font-mono text-xs">{chosen}</code>}
    </div>
  );
}

function EditorDemo({ selection }: { selection?: ProfileSelection }) {
  return (
    <div className="mx-auto max-w-4xl p-6">
      <ProfilesSettings initialSelection={selection} />
    </div>
  );
}

function dialog(id: string, title: string, prefill: NewSessionPrefill, description?: string): PlaygroundDemo {
  return {
    id,
    title,
    description,
    render: () => (
      <DemoHost>
        <NewSessionDialog />
        <OpenNewSession prefill={prefill} />
      </DemoHost>
    ),
  };
}

export const demos: PlaygroundDemo[] = [
  dialog('new-session', 'New session – default profile pre-selected, recent projects', {}, 'The profile “Broken” has errors and cannot be picked (tooltip).'),
  dialog('new-session-prefilled', 'New session – “New session in this project…” (folder + profile)', {
    cwd: 'D:\\work\\parallax',
    profileId: DEMO_PROFILE_IDS.work,
  }),
  dialog('new-session-broken', 'New session – pre-selected profile with errors', {
    cwd: 'D:\\work\\api',
    profileId: DEMO_PROFILE_IDS.broken,
  }),
  {
    id: 'folder-browser-roots',
    title: 'Folder browser – roots (drives + user folder)',
    render: () => (
      <DemoHost>
        <BrowserDemo initialPath={null} />
      </DemoHost>
    ),
  },
  {
    id: 'folder-browser-folder',
    title: 'Folder browser – a folder with subfolders, a link and hidden ones',
    description: 'Toggle “Show hidden folders”; D:\\archive is truncated; Backspace goes up.',
    render: () => (
      <DemoHost>
        <BrowserDemo initialPath="D:\work" />
      </DemoHost>
    ),
  },
  {
    id: 'folder-browser-error',
    title: 'Folder browser – unreadable start folder (FOLDER_NOT_READABLE → roots)',
    render: () => (
      <DemoHost>
        <BrowserDemo initialPath="D:\work\locked" />
      </DemoHost>
    ),
  },
  {
    id: 'editor-default',
    title: 'Profile editor – the built-in default profile (in use, not deletable)',
    render: () => (
      <DemoHost>
        <EditorDemo selection={{ kind: 'profile', id: STANDARD_PROFILE_ID }} />
      </DemoHost>
    ),
  },
  {
    id: 'editor-new',
    title: 'Profile editor – new profile',
    render: () => (
      <DemoHost>
        <EditorDemo selection={{ kind: 'new' }} />
      </DemoHost>
    ),
  },
  {
    id: 'editor-findings',
    title: 'Profile editor – findings per line (bypass, raw, missing value, unresolved ${env:…})',
    render: () => (
      <DemoHost>
        <EditorDemo selection={{ kind: 'profile', id: DEMO_PROFILE_IDS.gateway }} />
      </DemoHost>
    ),
  },
  {
    id: 'editor-in-use',
    title: 'Profile editor – in use: masked secrets, config folder warning on change',
    description: 'Change the config folder to see the warning; the eye button reveals a secret.',
    render: () => (
      <DemoHost>
        <EditorDemo selection={{ kind: 'profile', id: DEMO_PROFILE_IDS.work }} />
      </DemoHost>
    ),
  },
];

/** The settings page of the playground (WP-38) shows the real editor. */
export const slots: PlaygroundModule['slots'] = { ProfilesSettings };
