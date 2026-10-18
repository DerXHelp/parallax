import { PROFILE_ARG_INVALID_REASONS, type ErrorPayload } from '@shared/errors';
import type { ProfileIssue } from '@shared/model';
import type { TranslationKey, TranslationParams } from '@web/i18n';

/**
 * Details of a profile finding (ADR-102, WP-32 §2): the error text (`tError`) is generic, the
 * params name the culprit – `index`/`flag`/`reason` of an argument, `field`/`reason` of
 * PROFILE_INVALID, `name`/`key` of an environment variable. Never contains an env VALUE.
 */

export interface IssueDetail {
  key: TranslationKey;
  params: TranslationParams;
}

const EXECUTABLE_REASONS = ['not_absolute', 'not_exe', 'unsafe', 'not_found'] as const;
type ExecutableReason = (typeof EXECUTABLE_REASONS)[number];

function text(issue: ErrorPayload, name: string): string | null {
  const value = issue.params[name];
  return typeof value === 'string' ? value : null;
}

/** 0-based argument position of an argument finding (`params.index`), else null. */
export function issueArgIndex(issue: ErrorPayload): number | null {
  const value = issue.params.index;
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

/** `executable` | `configDir` for PROFILE_INVALID with a field, else null. */
export function issueField(issue: ErrorPayload): 'executable' | 'configDir' | null {
  if (issue.code !== 'PROFILE_INVALID') return null;
  const field = text(issue, 'field');
  return field === 'executable' || field === 'configDir' ? field : null;
}

/** Name of the env variable a finding is about (`params.key`), else null. */
export function issueEnvKey(issue: ErrorPayload): string | null {
  if (issue.code === 'PROFILE_ENV_REF_UNRESOLVED') return text(issue, 'key');
  if (issue.code === 'VALIDATION_FAILED' && text(issue, 'path') === 'profile.env') return text(issue, 'key');
  return null;
}

function isExecutableReason(value: string | null): value is ExecutableReason {
  return EXECUTABLE_REASONS.some((reason) => reason === value);
}

/** The second line of a finding, or null when the error text says it all. */
export function issueDetail(issue: ErrorPayload): IssueDetail | null {
  const flag = text(issue, 'flag') ?? '';
  switch (issue.code) {
    case 'PROFILE_ARG_INVALID': {
      const reason = PROFILE_ARG_INVALID_REASONS.find((known) => known === text(issue, 'reason'));
      return reason === undefined ? null : { key: `newSession.issues.argInvalid.${reason}`, params: { flag } };
    }
    case 'PROFILE_ARG_BLOCKED':
      return { key: 'newSession.issues.argBlocked', params: { flag } };
    case 'PROFILE_ARG_NOT_ALLOWED':
      return { key: 'newSession.issues.argNotAllowed', params: { flag } };
    case 'PROFILE_ARG_PASSED_RAW':
      return { key: 'newSession.issues.argPassedRaw', params: { flag } };
    case 'PROFILE_ARG_RESUME_NO_EFFECT':
      return { key: 'newSession.issues.argResumeNoEffect', params: { flag } };
    case 'PROFILE_BYPASS_ENABLED':
      return { key: 'newSession.issues.bypass', params: { flag } };
    case 'PROFILE_ARG_BROAD_ALLOWED_TOOLS':
      return { key: 'newSession.issues.broadTools', params: { value: text(issue, 'value') ?? '' } };
    case 'PROFILE_INVALID': {
      const field = issueField(issue);
      if (field === 'configDir') return { key: 'newSession.issues.configDir', params: {} };
      const reason = text(issue, 'reason');
      if (field === 'executable' && isExecutableReason(reason)) {
        return { key: `newSession.issues.executable.${reason}`, params: {} };
      }
      return null;
    }
    case 'PROFILE_ENV_REF_UNRESOLVED':
      return { key: 'newSession.issues.envRef', params: { name: text(issue, 'name') ?? '', key: text(issue, 'key') ?? '' } };
    case 'VALIDATION_FAILED': {
      const key = issueEnvKey(issue);
      return key === null ? null : { key: 'newSession.issues.envInvalid', params: { key } };
    }
    default:
      return null;
  }
}

/** Counts per level (list badges, editor summary). */
export function issueCounts(issues: readonly ProfileIssue[]): { error: number; warning: number; info: number } {
  const counts = { error: 0, warning: 0, info: 0 };
  for (const finding of issues) counts[finding.level] += 1;
  return counts;
}
