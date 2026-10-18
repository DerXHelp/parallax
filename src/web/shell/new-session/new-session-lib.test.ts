import { describe, expect, it } from 'vitest';
import { makeError } from '@shared/errors';
import { sampleClaudeInstallStatus } from '@shared/samples';
import { breadcrumbs } from './FolderBrowser';
import { listDemoFolder } from './demo-folders';
import { issueArgIndex, issueDetail, issueEnvKey, issueField } from './profile-issues';
import { profileStatusText } from './profile-status';
import { RECENT_PROJECTS_MAX, filterRecentProjects, recentProjects } from './recent-projects';

const at = (minute: number) => new Date(Date.UTC(2026, 9, 16, 10, minute)).toISOString();
const entry = (cwd: string, minute: number) => ({ summary: { cwd, lastActivityAt: at(minute) } });

describe('recentProjects', () => {
  it('lists distinct folders, newest activity first, case-insensitive (spelling of the newest wins)', () => {
    expect(
      recentProjects([
        entry('D:\\work\\a', 1),
        entry('d:\\WORK\\A\\', 5),
        entry('D:\\work\\b', 3),
        entry('D:/work/c', 4),
      ]),
    ).toEqual(['d:\\WORK\\A\\', 'D:/work/c', 'D:\\work\\b']);
  });

  it('keeps at most eight folders', () => {
    const many = Array.from({ length: 12 }, (_, n) => entry(`D:\\p${String(n)}`, n));
    const result = recentProjects(many);
    expect(RECENT_PROJECTS_MAX).toBe(8);
    expect(result).toHaveLength(8);
    expect(result[0]).toBe('D:\\p11');
  });

  it('filters by the typed path (fuzzy) unless the field names one of them', () => {
    const projects = ['D:\\work\\parallax', 'D:\\work\\api\\tests', 'C:\\Users\\user\\Documents'];
    expect(filterRecentProjects(projects, '')).toEqual(projects);
    expect(filterRecentProjects(projects, 'd:\\WORK\\Parallax')).toEqual(projects);
    expect(filterRecentProjects(projects, 'tests')).toEqual(['D:\\work\\api\\tests']);
    expect(filterRecentProjects(projects, 'para')[0]).toBe('D:\\work\\parallax');
    expect(filterRecentProjects(projects, 'E:\\nothing')).toEqual([]);
  });
});

describe('breadcrumbs', () => {
  it('splits a drive path; the last step is the path exactly', () => {
    expect(breadcrumbs('D:\\work\\parallax')).toEqual([
      { label: 'D:\\', path: 'D:\\' },
      { label: 'work', path: 'D:\\work' },
      { label: 'parallax', path: 'D:\\work\\parallax' },
    ]);
    expect(breadcrumbs('D:\\')).toEqual([{ label: 'D:\\', path: 'D:\\' }]);
    expect(breadcrumbs('d:/Work/x/')).toEqual([
      { label: 'd:/', path: 'd:/' },
      { label: 'Work', path: 'd:/Work' },
      { label: 'x', path: 'd:/Work/x/' },
    ]);
  });
});

describe('demo folders (fs.listDirectory stand-in)', () => {
  it('answers like the server: style of the input, parent, hidden, errors', () => {
    const work = listDemoFolder('d:/WORK', false);
    expect(work.ok && work.listing.parent).toBe('d:/');
    expect(work.ok && work.listing.entries.map((e) => e.path)).toContain('d:/WORK/parallax');
    expect(work.ok && work.listing.entries.some((e) => e.hidden)).toBe(false);
    const hidden = listDemoFolder('D:\\work', true);
    expect(hidden.ok && hidden.listing.entries.some((e) => e.name === '.git-hooks')).toBe(true);
    expect(listDemoFolder('D:\\work\\locked', false)).toMatchObject({ ok: false, error: { code: 'FOLDER_NOT_READABLE' } });
    expect(listDemoFolder('D:\\nope', false)).toMatchObject({ ok: false, error: { code: 'CWD_NOT_FOUND' } });
    expect(listDemoFolder('\\\\server\\share', false)).toMatchObject({ ok: false, error: { code: 'PATH_REJECTED' } });
  });
});

describe('profile findings', () => {
  it('names the culprit, never a value', () => {
    const blocked = makeError('PROFILE_ARG_BLOCKED', { index: 2, flag: '--resume' });
    expect(issueArgIndex(blocked)).toBe(2);
    expect(issueDetail(blocked)).toEqual({ key: 'newSession.issues.argBlocked', params: { flag: '--resume' } });
    expect(issueDetail(makeError('PROFILE_ARG_INVALID', { index: 0, flag: '--model', reason: 'missing_value' }))).toEqual({
      key: 'newSession.issues.argInvalid.missing_value',
      params: { flag: '--model' },
    });
    const executable = makeError('PROFILE_INVALID', { field: 'executable', reason: 'not_exe' });
    expect(issueField(executable)).toBe('executable');
    expect(issueDetail(executable)?.key).toBe('newSession.issues.executable.not_exe');
    expect(issueField(makeError('PROFILE_INVALID', { count: 2 }))).toBeNull();
    const envRef = makeError('PROFILE_ENV_REF_UNRESOLVED', { name: 'GATEWAY_TOKEN', key: 'API_TOKEN' });
    expect(issueEnvKey(envRef)).toBe('API_TOKEN');
    expect(issueDetail(envRef)?.params).toEqual({ name: 'GATEWAY_TOKEN', key: 'API_TOKEN' });
    expect(issueEnvKey(makeError('VALIDATION_FAILED', { path: 'profile.env', key: 'X' }))).toBe('X');
    expect(issueEnvKey(makeError('VALIDATION_FAILED', { path: 'other' }))).toBeNull();
    expect(issueDetail(makeError('PROFILE_IN_USE', { count: 1 }))).toBeNull();
  });

  it('describes the Claude Code state of a profile with a tone', () => {
    expect(profileStatusText(sampleClaudeInstallStatus())).toMatchObject({
      tone: 'ok',
      key: 'newSession.status.readyPlan',
    });
    expect(profileStatusText(sampleClaudeInstallStatus({ state: 'checking' })).tone).toBe('checking');
    expect(profileStatusText(sampleClaudeInstallStatus({ state: 'not_found' })).tone).toBe('error');
    expect(profileStatusText(sampleClaudeInstallStatus({ versionStatus: 'too_old' })).key).toBe(
      'newSession.status.tooOld',
    );
    expect(
      profileStatusText(
        sampleClaudeInstallStatus({
          auth: { state: 'logged_out', method: null, apiProvider: null, subscriptionType: null },
        }),
      ),
    ).toMatchObject({ tone: 'warning', key: 'newSession.status.loggedOut' });
  });
});
