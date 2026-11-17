import type { ReactNode } from 'react';
import type { ErrorPayload } from '@shared/errors';
import { useI18n } from '@web/i18n';
import { Alert, type AlertTone } from '@web/ui/alert';
import { updateErrorDetail } from '../lib/error-detail';

/**
 * An update error: the general text (`tError`) plus the translated line from its params
 * (lib/error-detail.ts). Tone `error` is announced as `role="alert"`.
 */
export function UpdateErrorAlert({
  title,
  error,
  tone = 'error',
  actions,
  className,
}: {
  title: string;
  error: ErrorPayload;
  tone?: AlertTone;
  actions?: ReactNode;
  className?: string;
}) {
  const { t, tError } = useI18n();
  const detail = updateErrorDetail(error, t);
  return (
    <Alert
      tone={tone}
      title={title}
      actions={actions}
      className={className}
      data-slot="update-error"
      data-code={error.code}
    >
      <span className="block">{tError(error)}</span>
      {detail === null ? null : (
        <span data-slot="update-error-detail" className="block">
          {detail}
        </span>
      )}
    </Alert>
  );
}
