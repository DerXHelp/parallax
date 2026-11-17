import { useEffect, useState, type ReactNode } from 'react';
import type { AppInfo, UpdateState } from '@shared/model';
import { SAMPLE_UPDATE_STATES, sampleTime, sampleUpdateState } from '@shared/samples';
import { startScenario } from '@web/playground/PlaygroundScenario';
import type { ScenarioId } from '@web/playground/scenarios';
import type { PlaygroundDemo } from '@web/playground/types';
import type { FeatureSlots } from '@web/shell/slots';
import type { FakeHost } from '@web/state/fake-host';
import { Button } from '@web/ui/button';
import { Card } from '@web/ui/card';
import { setUpdateHttp, type UpdateHttp } from './lib/api';
import { CHECKOUT_APP, PACKAGED_APP } from './testing';
import { UpdateBanner } from './UpdateBanner';
import { UpdateNotice } from './UpdateNotice';
import { UpdatesSettings } from './UpdatesSettings';

/**
 * Playground demos of the update UI (`#playground=updates/<id>`): the settings section in every
 * state of `SAMPLE_UPDATE_STATES` (the FakeHost answers `update.*`; "Restart now" lists the
 * sessions of the overview scenario), a checkout, the sidebar hint (wide and in the rail) and the
 * banners. There is no server behind Vite: "What's new", license and notices and "Install from
 * file" answer from `fakeRequests` (the upload then checks for a moment and offers 1.0.0-rc.4).
 * `slots` puts the real components into the shell demos; App.tsx wires the lazy ones (WP-89).
 */

const CHANGELOG_BODY = [
  '### Neu',
  '- Updates in der App: prüfen, vorbereiten, neu starten (WP-87).',
  '- „Was ist neu“ aus dem signierten Changelog.',
  '',
  '### Behoben',
  '- Das Fenster verbindet sich nach dem Neustart von selbst neu.',
].join('\n');

const LICENSE_TEXT = [
  'MIT License',
  '',
  'Copyright (c) 2026 The Parallax authors',
  '',
  'Permission is hereby granted, free of charge, to any person obtaining a copy of this software …',
].join('\n');

function fakeRequests(host: FakeHost): UpdateHttp {
  return {
    changelog: (query) =>
      Promise.resolve({
        version: query.for === 'available' ? (host.hostState.update.available?.version ?? '1.0.1') : '1.0.0',
        sections: [
          {
            version: query.for === 'available' ? '1.0.1' : '1.0.0',
            date: '2026-11-20',
            body: CHANGELOG_BODY,
          },
          ...(query.since === undefined ? [] : [{ version: null, date: null, body: '' }]),
        ],
      }),
    notices: (file) =>
      Promise.resolve({
        file,
        text:
          file === 'license'
            ? LICENSE_TEXT
            : Array.from({ length: 400 }, (_, i) => `component-${String(i)} – MIT`).join('\n'),
      }),
    upload: () => {
      host.setHostState({ ...host.hostState, update: sampleUpdateState({ status: 'preparing' }) });
      setTimeout(() => {
        host.setHostState({ ...host.hostState, update: SAMPLE_UPDATE_STATES.readyFromFile });
      }, 1500);
      return Promise.resolve();
    },
  };
}

/** Runs a scenario with `update` (and `app`) while mounted; the requests answer from the fake. */
function UpdatesScenario({
  update,
  app = PACKAGED_APP,
  scenario = 'empty',
  children,
}: {
  update: UpdateState;
  app?: AppInfo;
  scenario?: ScenarioId;
  children: ReactNode;
}) {
  useEffect(() => {
    const running = startScenario(scenario, { select: null });
    const { host } = running;
    host.setHostState({ ...host.hostState, serverVersion: app.version, app, update });
    setUpdateHttp(fakeRequests(host));
    return () => {
      setUpdateHttp(null);
      running.stop();
    };
  }, [update, app, scenario]);
  return children;
}

const STATE_NAMES = Object.keys(SAMPLE_UPDATE_STATES).filter(
  (name): name is Exclude<keyof typeof SAMPLE_UPDATE_STATES, 'unsupported'> => name !== 'unsupported',
);

/** The section with a picker over the sample states. */
function SettingsDemo() {
  const [name, setName] = useState<(typeof STATE_NAMES)[number]>('available');
  return (
    <UpdatesScenario update={SAMPLE_UPDATE_STATES[name]} scenario="overview">
      <div className="mx-auto grid max-w-2xl gap-4 p-6">
        <div className="flex flex-wrap gap-1.5">
          {STATE_NAMES.map((candidate) => (
            <Button
              key={candidate}
              size="sm"
              variant={candidate === name ? 'secondary' : 'ghost'}
              onClick={() => {
                setName(candidate);
              }}
            >
              {candidate}
            </Button>
          ))}
        </div>
        <Card className="p-5">
          <UpdatesSettings />
        </Card>
      </div>
    </UpdatesScenario>
  );
}

function CheckoutDemo() {
  return (
    <UpdatesScenario update={SAMPLE_UPDATE_STATES.unsupported} app={CHECKOUT_APP}>
      <div className="mx-auto max-w-2xl p-6">
        <Card className="p-5">
          <UpdatesSettings />
        </Card>
      </div>
    </UpdatesScenario>
  );
}

function NoticeDemo({ update }: { update: UpdateState }) {
  return (
    <UpdatesScenario update={update}>
      <div className="flex gap-6 p-6">
        <div className="bg-sidebar text-sidebar-foreground border-sidebar-border w-72 rounded-md border p-2">
          <UpdateNotice compact={false} />
        </div>
        <div className="bg-sidebar text-sidebar-foreground border-sidebar-border flex w-11 justify-center rounded-md border py-1.5">
          <UpdateNotice compact />
        </div>
      </div>
    </UpdatesScenario>
  );
}

/** Both banners at once (they never come together from a real server, but show the styles). */
const BOTH_BANNERS: UpdateState = sampleUpdateState({
  justUpdated: { from: '1.0.0-rc.4', to: '1.0.0', at: sampleTime() },
  failedUpdate: SAMPLE_UPDATE_STATES.failedUpdate.failedUpdate,
});

function BannerDemo({ update }: { update: UpdateState }) {
  return (
    <UpdatesScenario update={update}>
      <div className="bg-background m-6 overflow-hidden rounded-md border">
        <UpdateBanner />
      </div>
    </UpdatesScenario>
  );
}

const STEP_BACK: UpdateState = sampleUpdateState({
  justUpdated: { from: '1.0.1', to: '1.0.0', at: sampleTime() },
});

export const demos: PlaygroundDemo[] = [
  {
    id: 'settings',
    title: 'Updates – settings section (pick a sample state)',
    description: 'FakeHost answers update.*; restart lists the overview sessions.',
    render: () => <SettingsDemo />,
  },
  {
    id: 'checkout',
    title: 'Updates – settings of a checkout (updates via git)',
    render: () => <CheckoutDemo />,
  },
  {
    id: 'notice-available',
    title: 'Updates – sidebar hint "available" (wide and rail)',
    render: () => <NoticeDemo update={SAMPLE_UPDATE_STATES.available} />,
  },
  {
    id: 'notice-ready',
    title: 'Updates – sidebar hint "ready – restart" (wide and rail)',
    render: () => <NoticeDemo update={SAMPLE_UPDATE_STATES.ready} />,
  },
  {
    id: 'banners',
    title: 'Updates – banners "failed" and "updated"',
    render: () => <BannerDemo update={BOTH_BANNERS} />,
  },
  {
    id: 'banner-back',
    title: 'Updates – banner after a step back',
    render: () => <BannerDemo update={STEP_BACK} />,
  },
];

export const slots: Partial<FeatureSlots> = { UpdateNotice, UpdateBanner, UpdatesSettings };
