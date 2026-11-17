import { describe, expect, it } from 'vitest';
import { makeError, UPDATE_RESTART_FAILED_REASONS, type ErrorPayload } from '@shared/errors';
import { translate, type TranslationKey, type TranslationParams } from '@web/i18n';
import { updateErrorDetail } from './error-detail';

const en = (key: TranslationKey, params?: TranslationParams) => translate('en', key, params);
const de = (key: TranslationKey, params?: TranslationParams) => translate('de', key, params);

function detail(error: ErrorPayload, t = en): string | null {
  return updateErrorDetail(error, t);
}

describe('updateErrorDetail (one line from the params of an update error)', () => {
  it('tells the reason of a failed check and download, with the HTTP status', () => {
    expect(detail(makeError('UPDATE_CHECK_FAILED', { reason: 'network' }))).toBe('No connection to GitHub.');
    expect(detail(makeError('UPDATE_CHECK_FAILED', { reason: 'http', status: 503 }))).toBe(
      'GitHub answered with HTTP 503.',
    );
    expect(detail(makeError('UPDATE_DOWNLOAD_FAILED', { reason: 'hash' }))).toBe(
      'The file does not match its checksum.',
    );
    expect(detail(makeError('UPDATE_DOWNLOAD_FAILED', { reason: 'http', status: 404 }))).toBe(
      'The server answered with HTTP 404.',
    );
    // Without a status no raw placeholder shows.
    expect(detail(makeError('UPDATE_DOWNLOAD_FAILED', { reason: 'http' }))).toBe(
      'The server answered with an error.',
    );
  });

  it('names the file, the package reason, the running step and the Node versions', () => {
    expect(detail(makeError('UPDATE_INVALID_SIGNATURE', { file: 'latest.json' }))).toBe(
      'Affected file: latest.json',
    );
    expect(detail(makeError('UPDATE_INVALID_PACKAGE', { reason: 'same_version' }))).toBe(
      'This version is already installed.',
    );
    expect(detail(makeError('UPDATE_BUSY', { status: 'downloading' }))).toBe(
      'A download is running right now.',
    );
    expect(detail(makeError('UPDATE_NODE_TOO_OLD', { required: '24.5.0', actual: '22.11.0' }))).toBe(
      'Needs Node.js 24.5.0; installed is 22.11.0.',
    );
    expect(detail(makeError('UPDATE_DOWNGRADE_BLOCKED', { version: '1.0.0-rc.4' }))).toContain('1.0.0-rc.4');
  });

  it('has a text for every restart reason of the contract', () => {
    for (const reason of UPDATE_RESTART_FAILED_REASONS) {
      const line = detail(makeError('UPDATE_RESTART_FAILED', { version: '1.0.1', reason }));
      expect(line, reason).not.toBeNull();
      expect(line).not.toContain('updates.detail');
    }
  });

  it('explains the refusals of update.prepare/apply/rollback', () => {
    expect(detail(makeError('VALIDATION_FAILED', { reason: 'version' }))).toBe(
      'The offered version changed in the meantime – check again.',
    );
    expect(detail(makeError('VALIDATION_FAILED', { reason: 'data_loss_not_accepted' }))).toContain('backup');
    expect(detail(makeError('VALIDATION_FAILED', { path: 'version' }))).toBeNull();
  });

  it('gives no line for unknown reasons, missing params and other codes', () => {
    expect(detail(makeError('UPDATE_CHECK_FAILED', { reason: 'cosmic_rays' }))).toBeNull();
    expect(detail(makeError('UPDATE_CHECK_FAILED'))).toBeNull();
    expect(detail(makeError('UPDATE_BUSY', { status: 'idle' }))).toBeNull();
    expect(detail(makeError('UPDATE_NODE_TOO_OLD', { required: '24.5.0' }))).toBeNull();
    expect(detail(makeError('UPDATE_SDK_FAILED'))).toBeNull();
    expect(detail(makeError('CONNECTION_LOST'))).toBeNull();
  });

  it('is translated (German)', () => {
    expect(detail(makeError('UPDATE_CHECK_FAILED', { reason: 'timeout' }), de)).toBe(
      'GitHub hat nicht rechtzeitig geantwortet.',
    );
    expect(detail(makeError('UPDATE_RESTART_FAILED', { version: '1.0.1', reason: 'timeout' }), de)).toBe(
      'Die neue Version ist nicht rechtzeitig gestartet.',
    );
  });
});
