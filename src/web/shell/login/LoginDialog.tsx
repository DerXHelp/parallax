import { CopyIcon, ExternalLinkIcon, LoaderCircleIcon } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState, type ReactNode, type SyntheticEvent } from 'react';
import type { HostId, ProfileId } from '@shared/common';
import type { ErrorPayload } from '@shared/errors';
import { IDLE_PROFILE_LOGIN, type ProfileLogin } from '@shared/model';
import { LOGIN_CODE_CHARS, type Command } from '@shared/protocol';
import { useI18n } from '@web/i18n';
import { copyText } from '@web/lib/clipboard';
import { openExternalLink } from '@web/lib/external-link';
import { useReturnFocus } from '@web/lib/return-focus';
import { errorPayloadOf, getConnection } from '@web/state/connection';
import { useHostState } from '@web/state/hooks';
import { Alert } from '@web/ui/alert';
import { Button } from '@web/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@web/ui/dialog';
import { Input } from '@web/ui/input';
import { Label } from '@web/ui/label';
import { useLoginT } from './i18n';

/** A sign-in that still runs (the dialog offers "Cancel" instead of "Close"). */
function isActive(login: ProfileLogin): boolean {
  return login.state === 'starting' || login.state === 'waiting' || login.state === 'verifying';
}

/** `max` → `Max` (the plan as `claude auth status` reports it, readable). */
function planName(plan: string): string {
  return plan.charAt(0).toUpperCase() + plan.slice(1);
}

/**
 * WP-70: sign in a profile from Parallax (a lazy chunk, mounted by the NavigationLayer for the shell
 * request `login`). Opening it starts the sign-in (`profile.login`): the server opens the sign-in
 * page in the default browser and reports the state in `ProfileSummary.login` – waiting (with "Open
 * link again", "Copy link" and a field for the code the browser may show), verifying, signed in
 * ("Signed in (Max)") or failed (its error in the dialog). Small and non-modal: the window stays
 * usable while the browser is open (modal only when asked from inside a modal dialog). "Cancel"
 * ends the sign-in; closing only hides the dialog (a redirect to the CLI may still finish it).
 * Refused commands show in the dialog itself (ADR-126).
 */
export function LoginDialog({
  hostId,
  profileId,
  modal,
  onClose,
}: {
  hostId: HostId;
  profileId: ProfileId;
  modal: boolean;
  onClose: () => void;
}) {
  const lt = useLoginT();
  const { tError } = useI18n();
  const profile = useHostState(hostId)?.profiles.find((candidate) => candidate.id === profileId) ?? null;
  const login = profile?.login ?? IDLE_PROFILE_LOGIN;
  // The state when this dialog (or "Try again") asked for a new sign-in: until the host reports a
  // newer one the dialog shows "starting" (never the old "signed in" or error).
  const [baseline, setBaseline] = useState<ProfileLogin | null>(() => (isActive(login) ? null : login));
  const [refusal, setRefusal] = useState<ErrorPayload | null>(null);
  const [code, setCode] = useState('');
  const [copied, setCopied] = useState<boolean | null>(null);
  const codeId = useId();
  const hintId = useId();
  const onCloseAutoFocus = useReturnFocus(true);
  const sent = useRef(false);

  const run = useCallback(
    (cmd: Command): Promise<boolean> =>
      getConnection(hostId)
        .send(cmd)
        .then(
          () => true,
          (caught: unknown) => {
            setRefusal(errorPayloadOf(caught));
            setBaseline(null);
            return false;
          },
        ),
    [hostId],
  );

  // Opening the dialog is the click on "Sign in": start once (StrictMode runs effects twice).
  useEffect(() => {
    if (sent.current) return;
    sent.current = true;
    void run({ name: 'profile.login', profileId });
  }, [profileId, run]);

  const awaiting = baseline !== null && login.state === baseline.state && login.at === baseline.at;
  const phase = awaiting ? 'starting' : login.state;
  const url = login.url;
  const copyUrl = login.manualUrl ?? url;

  const retry = () => {
    setRefusal(null);
    setBaseline(login);
    void run({ name: 'profile.login', profileId });
  };
  const cancel = () => {
    void run({ name: 'profile.loginCancel', profileId });
    onClose();
  };
  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    const value = code.trim();
    if (value === '') return;
    setRefusal(null);
    void run({ name: 'profile.loginCode', profileId, code: value }).then((ok) => {
      if (ok) setCode('');
    });
  };

  let body: ReactNode = null;
  if (phase === 'starting') {
    body = <Busy text={lt('starting')} />;
  } else if (phase === 'verifying') {
    body = <Busy text={lt('verifying')} />;
  } else if (phase === 'waiting') {
    body = (
      <div className="grid gap-3">
        <p className="text-xs">{lt('waiting')}</p>
        {url === null ? null : (
          <div className="flex flex-wrap items-center gap-1.5">
            <Button
              size="sm"
              variant="outline"
              data-action="login-open"
              onClick={() => openExternalLink(url)}
            >
              <ExternalLinkIcon aria-hidden />
              {lt('openAgain')}
            </Button>
            {copyUrl === null ? null : (
              <Button
                size="sm"
                variant="ghost"
                data-action="login-copy"
                onClick={() => {
                  void copyText(copyUrl).then(setCopied);
                }}
              >
                <CopyIcon aria-hidden />
                {lt('copy')}
              </Button>
            )}
            {copied === null ? null : (
              <span role="status" className="text-muted-foreground text-2xs">
                {copied ? lt('copied') : lt('copyFailed')}
              </span>
            )}
          </div>
        )}
        <form className="grid gap-1.5" onSubmit={submit}>
          <Label htmlFor={codeId}>{lt('codeLabel')}</Label>
          <div className="flex gap-1.5">
            <Input
              id={codeId}
              value={code}
              maxLength={LOGIN_CODE_CHARS}
              autoComplete="off"
              spellCheck={false}
              placeholder={lt('codePlaceholder')}
              aria-describedby={hintId}
              data-slot="login-code"
              onChange={(event) => {
                setCode(event.target.value);
              }}
            />
            <Button type="submit" size="default" disabled={code.trim() === ''} data-action="login-submit">
              {lt('submit')}
            </Button>
          </div>
          <p id={hintId} className="text-muted-foreground text-2xs">
            {lt('codeHint')}
          </p>
        </form>
      </div>
    );
  } else if (phase === 'done') {
    const plan = login.subscriptionType;
    body = (
      <Alert
        tone="success"
        data-slot="login-done"
        title={plan === null ? lt('doneNoPlan') : lt('done', { plan: planName(plan) })}
      >
        {lt('doneHint')}
      </Alert>
    );
  } else if (login.error !== null) {
    body = (
      <Alert tone="error" data-slot="login-failed" title={lt('failed')}>
        {tError(login.error)}
      </Alert>
    );
  }

  return (
    <Dialog
      open
      modal={modal}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        data-slot="login-dialog"
        data-login-state={phase}
        className={modal ? 'sm:max-w-md' : 'top-16 right-4 left-auto translate-x-0 translate-y-0 sm:max-w-md'}
        onCloseAutoFocus={onCloseAutoFocus}
        onInteractOutside={
          modal
            ? undefined
            : (event) => {
                // Non-modal: working in the window meanwhile never closes it.
                event.preventDefault();
              }
        }
      >
        <DialogHeader>
          <DialogTitle>{lt('title', { profile: profile?.name ?? profileId })}</DialogTitle>
          <DialogDescription>{lt('description')}</DialogDescription>
        </DialogHeader>
        {body}
        {refusal === null ? null : (
          <Alert tone="error" data-slot="login-refused" title={lt('refused')}>
            {tError(refusal)}
          </Alert>
        )}
        <DialogFooter>
          {isActive(login) || awaiting ? (
            <Button variant="ghost" data-action="login-cancel" onClick={cancel}>
              {lt('cancel')}
            </Button>
          ) : (
            <>
              {phase === 'failed' || phase === 'idle' || refusal !== null ? (
                <Button variant="outline" data-action="login-retry" onClick={retry}>
                  {lt('retry')}
                </Button>
              ) : null}
              <Button
                variant={phase === 'done' ? 'default' : 'ghost'}
                data-action="login-close"
                onClick={onClose}
              >
                {lt('close')}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Busy({ text }: { text: string }) {
  return (
    <p className="text-muted-foreground flex items-center gap-2 text-xs">
      <LoaderCircleIcon aria-hidden className="size-3.5 motion-safe:animate-spin" />
      <span role="status">{text}</span>
    </p>
  );
}
