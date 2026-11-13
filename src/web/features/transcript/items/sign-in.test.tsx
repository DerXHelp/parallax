/**
 * WP-70 in the transcript: a sign-in error (CLAUDE_AUTH_FAILED, CLAUDE_NOT_LOGGED_IN) carries
 * "Sign in" for the session's profile; once the profile signed in after the error the button is
 * gone. Other errors have none.
 */
import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { LOCAL_HOST_ID, STANDARD_PROFILE_ID } from '@shared/common';
import { makeError } from '@shared/errors';
import { IDLE_PROFILE_LOGIN, type ProfileLogin } from '@shared/model';
import {
  SAMPLE_IDS,
  sampleHostState,
  sampleProfileSummary,
  sampleSummary,
  sampleSystemItems,
} from '@shared/samples';
import { setLanguage } from '@web/i18n';
import { clientStore, emptyHostRecord, resetClientStore } from '@web/state/store';
import { resetExpansion } from '../state/expansion';
import { SystemRow } from './SystemRow';

afterEach(() => {
  setLanguage('en');
  resetClientStore();
  resetExpansion();
});

const KEY = `${LOCAL_HOST_ID}:${SAMPLE_IDS.entry}`;

function seed(login: ProfileLogin = { ...IDLE_PROFILE_LOGIN }): void {
  clientStore.setState({
    hosts: {
      [LOCAL_HOST_ID]: {
        ...emptyHostRecord(LOCAL_HOST_ID),
        hostState: sampleHostState({ profiles: [sampleProfileSummary({ login })] }),
        summaries: { [SAMPLE_IDS.entry]: sampleSummary() },
      },
    },
  });
}

describe('"Sign in" at sign-in errors (WP-70)', () => {
  it('CLAUDE_AUTH_FAILED and CLAUDE_NOT_LOGGED_IN have it; other errors do not', () => {
    seed();
    const item = sampleSystemItems.error();
    const { unmount } = render(<SystemRow item={item} sessionKey={KEY} />);
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeTruthy();
    unmount();
    const notLoggedIn = render(
      <SystemRow
        item={sampleSystemItems.error({ error: makeError('CLAUDE_NOT_LOGGED_IN') })}
        sessionKey={KEY}
      />,
    );
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeTruthy();
    notLoggedIn.unmount();
    render(
      <SystemRow
        item={sampleSystemItems.error({ error: makeError('CLAUDE_PROCESS_CRASHED') })}
        sessionKey={KEY}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull();
  });

  it('gone once the profile signed in after the error; an earlier sign-in keeps it (German)', () => {
    setLanguage('de');
    const item = sampleSystemItems.error();
    const before = new Date(Date.parse(item.at) - 60_000).toISOString();
    seed({ ...IDLE_PROFILE_LOGIN, state: 'done', subscriptionType: 'max', at: before });
    render(<SystemRow item={item} sessionKey={KEY} />);
    expect(screen.getByRole('button', { name: 'Anmelden' })).toBeTruthy();
    const after = new Date(Date.parse(item.at) + 60_000).toISOString();
    act(() => {
      seed({ ...IDLE_PROFILE_LOGIN, state: 'done', subscriptionType: 'max', at: after });
    });
    expect(screen.queryByRole('button', { name: 'Anmelden' })).toBeNull();
    expect(STANDARD_PROFILE_ID).toBe(sampleSummary().profileId);
  });
});
