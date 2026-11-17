import type { ErrorPayload } from '@shared/errors';
import type { TranslationKey, TranslationParams } from '@web/i18n';

/**
 * One extra translated line from the params of an update error (WP-87 §1.5): the general texts
 * `errors.UPDATE_*` have no placeholders, the reason (`reason`, `status`, `file`, `required`,
 * `actual`, `version`) is told here. Unknown reasons give no line – never a raw value.
 */

type Translate = (key: TranslationKey, params?: TranslationParams) => string;

const CHECK_REASONS = ['network', 'timeout', 'http', 'too_large', 'schema', 'url'] as const;
const DOWNLOAD_REASONS = ['network', 'timeout', 'http', 'size', 'hash', 'disk'] as const;
const PACKAGE_REASONS = ['zip', 'layout', 'files', 'version', 'same_version', 'too_large'] as const;
// WP-87a: `locked` = the install lock of the installation folder is held elsewhere (installer, other server).
const BUSY_STATUSES = ['checking', 'downloading', 'preparing', 'restarting', 'locked'] as const;
const RESTART_REASONS = [
  'spawn',
  'handshake',
  'lock',
  'package',
  'backup',
  'port',
  'timeout',
  'exited',
  'store_too_new',
] as const;

function oneOf<T extends string>(value: unknown, values: readonly T[]): T | null {
  return values.find((candidate) => candidate === value) ?? null;
}

/** A param as display text (numbers and strings only), else null. */
function text(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'string' && value.length > 0) return value;
  return null;
}

function httpLine(
  t: Translate,
  key: 'updates.detail.check.http' | 'updates.detail.download.http',
  status: unknown,
): string {
  const code = text(status);
  return code === null ? t('updates.detail.httpError') : t(key, { status: code });
}

export function updateErrorDetail(error: ErrorPayload, t: Translate): string | null {
  const { params } = error;
  switch (error.code) {
    case 'UPDATE_CHECK_FAILED': {
      const reason = oneOf(params.reason, CHECK_REASONS);
      if (reason === 'http') return httpLine(t, 'updates.detail.check.http', params.status);
      return reason === null ? null : t(`updates.detail.check.${reason}`);
    }
    case 'UPDATE_DOWNLOAD_FAILED': {
      const reason = oneOf(params.reason, DOWNLOAD_REASONS);
      if (reason === 'http') return httpLine(t, 'updates.detail.download.http', params.status);
      return reason === null ? null : t(`updates.detail.download.${reason}`);
    }
    case 'UPDATE_INVALID_SIGNATURE': {
      const file = text(params.file);
      return file === null ? null : t('updates.detail.signature', { file });
    }
    case 'UPDATE_INVALID_PACKAGE': {
      const reason = oneOf(params.reason, PACKAGE_REASONS);
      return reason === null ? null : t(`updates.detail.package.${reason}`);
    }
    case 'UPDATE_BUSY': {
      const status = oneOf(params.status, BUSY_STATUSES);
      return status === null ? null : t(`updates.detail.busy.${status}`);
    }
    case 'UPDATE_NODE_TOO_OLD': {
      const required = text(params.required);
      const actual = text(params.actual);
      return required === null || actual === null
        ? null
        : t('updates.detail.nodeTooOld', { required, actual });
    }
    case 'UPDATE_DOWNGRADE_BLOCKED': {
      const version = text(params.version);
      return version === null ? null : t('updates.detail.downgradeBlocked', { version });
    }
    case 'UPDATE_RESTART_FAILED': {
      const reason = oneOf(params.reason, RESTART_REASONS);
      return reason === null ? null : t(`updates.detail.restart.${reason}`);
    }
    case 'VALIDATION_FAILED': {
      // update.prepare/apply/rollback (WP-87 §1.3): only what the user saw goes on.
      if (params.reason === 'version') return t('updates.detail.version');
      if (params.reason === 'data_loss_not_accepted') return t('updates.detail.dataLoss');
      return null;
    }
    default:
      return null;
  }
}
