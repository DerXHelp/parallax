/**
 * WP-70 output style per project in the web: the picker (styles from `detail.availableOutputStyles`,
 * the current one from `summary.outputStyle`; a click sends `session.setOutputStyle`; errors in the
 * picker; archived/external read only; no list on a dormant session → "Start session"), the dialog
 * of the header "…" menu (shell request `outputStyle`), the menu entries ("Output style…", "Sign in"
 * only while Remote Control failed for the sign-in) and the lazy namespace.
 */
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LOCAL_HOST_ID, makeSessionKey, parseSessionKey, STANDARD_PROFILE_ID } from '@shared/common';
import { makeError } from '@shared/errors';
import { DEFAULT_REMOTE_CONTROL_SUMMARY } from '@shared/model';
import { SAMPLE_IDS, SAMPLE_TIME, sampleSummary } from '@shared/samples';
import { setLanguage } from '@web/i18n';
import { PLAYGROUND_SESSION_KEYS } from '@web/playground/scenarios';
import { startScenario, type RunningScenario } from '@web/playground/PlaygroundScenario';
import { resetClientStore } from '@web/state/store';
import { TooltipProvider } from '@web/ui/tooltip';
import { NavigationLayer } from '../navigation/NavigationLayer';
import { HEADER_ACTIONS, SIDEBAR_ACTIONS, sessionActions } from '../navigation/session-actions';
import { registerShellRequestHandler, requestShell, type ShellRequest } from '../requests';
import { de } from './i18n/de';
import { en } from './i18n/en';
import { OutputStylePicker } from './OutputStylePicker';

vi.setConfig({ testTimeout: 30_000 });

const KEY = PLAYGROUND_SESSION_KEYS.main;
const ENTRY = parseSessionKey(KEY)?.entryId ?? '';
const STYLES = ['default', 'Explanatory', 'Learning'];

let running: RunningScenario | null = null;

afterEach(() => {
  cleanup();
  act(() => {
    setLanguage('en');
  });
  running?.stop();
  running = null;
  resetClientStore();
});

function start(styles: readonly string[] = STYLES): RunningScenario {
  const scenario = startScenario('overview');
  running = scenario;
  scenario.host.patchSummary(ENTRY, { outputStyle: 'default' });
  scenario.host.pushOps(ENTRY, [{ op: 'detail.patch', patch: { availableOutputStyles: [...styles] } }]);
  return scenario;
}

function styleButton(style: string): HTMLElement {
  return screen.getByRole('button', { name: `Use output style “${style}”` });
}

describe('OutputStylePicker (WP-70)', () => {
  it('lists the styles, marks the current one; a click writes it and the summary follows', async () => {
    const scenario = start();
    render(<OutputStylePicker sessionKey={KEY} heading />);
    await waitFor(() => {
      expect(styleButton('Explanatory')).toBeTruthy();
    });
    expect(screen.getByRole('heading', { name: 'Output style' })).toBeTruthy();
    expect(screen.getByText(/\.claude\\settings\.local\.json/)).toBeTruthy();
    expect(styleButton('default').getAttribute('aria-pressed')).toBe('true');
    const user = userEvent.setup();
    await user.click(styleButton('Explanatory'));
    await waitFor(() => {
      expect(styleButton('Explanatory').getAttribute('aria-pressed')).toBe('true');
    });
    expect(scenario.host.commands).toContainEqual({
      name: 'session.setOutputStyle',
      entryId: ENTRY,
      style: 'Explanatory',
    });
    // The current style again writes nothing.
    const sent = scenario.host.commands.length;
    await user.click(styleButton('Explanatory'));
    expect(scenario.host.commands).toHaveLength(sent);
  });

  it('a refusal shows in the picker (role alert) with its code text', async () => {
    const scenario = start();
    scenario.host.failNext(
      'session.setOutputStyle',
      makeError('CLAUDE_CONTROL_FAILED', { method: 'updateSettings' }),
    );
    render(<OutputStylePicker sessionKey={KEY} />);
    const user = userEvent.setup();
    await waitFor(() => {
      expect(styleButton('Learning')).toBeTruthy();
    });
    await user.click(styleButton('Learning'));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('The output style could not be changed');
    expect(styleButton('default').getAttribute('aria-pressed')).toBe('true');
  });

  it('archived and external sessions are read only', async () => {
    const scenario = start();
    scenario.host.patchSummary(ENTRY, { archived: true });
    render(<OutputStylePicker sessionKey={KEY} />);
    await waitFor(() => {
      expect(styleButton('Learning').hasAttribute('disabled')).toBe(true);
    });
    expect(screen.getByText('Archived sessions keep their output style.')).toBeTruthy();
  });

  it('no list on a dormant session → "Start session" (session.resume, no turn)', async () => {
    const scenario = start([]);
    scenario.host.patchSummary(ENTRY, {}, { runState: 'sleeping' });
    render(<OutputStylePicker sessionKey={KEY} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Start session' }));
    expect(scenario.host.commands).toContainEqual({ name: 'session.resume', entryId: ENTRY });
    await waitFor(() => {
      expect(screen.getByText('This Claude Code reports no output styles.')).toBeTruthy();
    });
  });
});

describe('"Output style…" in the header menu (WP-70)', () => {
  it('the request opens the dialog with the picker and the hint (German)', async () => {
    start();
    act(() => {
      setLanguage('de');
    });
    render(
      <TooltipProvider>
        <NavigationLayer />
      </TooltipProvider>,
    );
    act(() => {
      expect(requestShell({ kind: 'outputStyle', sessionKey: KEY })).toBe(true);
    });
    const dialog = await screen.findByRole('dialog', { name: 'Ausgabestil' });
    expect(within(dialog).getByText(/Gilt für alle Sessions in diesem Projekt/)).toBeTruthy();
    await waitFor(() => {
      expect(within(dialog).getByRole('button', { name: 'Ausgabestil „Learning“ verwenden' })).toBeTruthy();
    });
    expect(
      requestShell({ kind: 'outputStyle', sessionKey: makeSessionKey(LOCAL_HOST_ID, 'en_unknown') }),
    ).toBe(false);
  });

  it('header only, off for archived/external sessions; "Sign in" only for REMOTE_CONTROL_AUTH', () => {
    const key = makeSessionKey(LOCAL_HOST_ID, SAMPLE_IDS.entry);
    expect(HEADER_ACTIONS).toContain('outputStyle');
    expect(SIDEBAR_ACTIONS).not.toContain('outputStyle');
    const find = (summary = sampleSummary(), id = 'outputStyle') =>
      sessionActions(HEADER_ACTIONS, key, summary, 'header').find((action) => action?.id === id);
    expect(find()?.disabled).toBe(false);
    expect(find(sampleSummary({ archived: true }))?.disabled).toBe(true);
    expect(
      find(sampleSummary({ external: { running: true, pid: 4711, since: SAMPLE_TIME } }))?.disabled,
    ).toBe(true);
    expect(find(sampleSummary(), 'signIn')).toBeUndefined();
    const failed = sampleSummary({
      remoteControl: {
        ...DEFAULT_REMOTE_CONTROL_SUMMARY,
        state: 'failed',
        wanted: true,
        error: makeError('REMOTE_CONTROL_AUTH'),
      },
    });
    const signIn = find(failed, 'signIn');
    expect(signIn?.label).toBe('navigation.actions.signIn');
    const requests: ShellRequest[] = [];
    const remove = registerShellRequestHandler('login', (request) => {
      requests.push(request);
      return true;
    });
    signIn?.run();
    remove();
    expect(requests).toEqual([{ kind: 'login', profileId: STANDARD_PROFILE_ID, hostId: LOCAL_HOST_ID }]);
  });
});

describe('lazy namespace of the output style (WP-70)', () => {
  it('German has the keys and placeholders of English; nothing is empty', () => {
    expect(Object.keys(de).sort()).toEqual(Object.keys(en).sort());
    for (const key of Object.keys(en) as (keyof typeof en)[]) {
      expect(de[key].trim(), key).not.toBe('');
      expect(
        [...de[key].matchAll(/\{(\w+)\}/g)].map((m) => m[1]),
        key,
      ).toEqual([...en[key].matchAll(/\{(\w+)\}/g)].map((m) => m[1]));
    }
  });
});
