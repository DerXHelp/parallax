import { ExternalLinkIcon, GlobeIcon } from 'lucide-react';
import { useId, useRef, useState, type ReactNode } from 'react';
import type { ErrorPayload } from '@shared/errors';
import type { ElicitationAction, ElicitationDecision } from '@shared/model';
import { useI18n, useT } from '@web/i18n';
import { onExternalLinkClick, openExternalLink } from '@web/lib/external-link';
import { Alert } from '@web/ui/alert';
import { Button } from '@web/ui/button';
import { CopyButton } from '@web/ui/copy-button';
import {
  checkElicitationDraft,
  elicitationServerName,
  elicitationTitle,
  elicitationUrlTarget,
  fieldKeyOfError,
  initialElicitationDraft,
  type ElicitationDraft,
  type ElicitationDraftValue,
  type ElicitationIssue,
  type ElicitationUrlTarget,
} from '../lib/elicitation';
import { respondInCard, respondToDecision } from '../lib/respond';
import { DecisionAction, DecisionCardShell } from './card-shell';
import { ElicitationFields } from './ElicitationFields';
import { ElicitationServerLabel } from './RequesterLabel';

interface CardProps {
  sessionKey: string;
  decision: ElicitationDecision;
  headerExtra?: ReactNode;
}

const REJECTED: ElicitationIssue = { code: 'rejected', params: {} };

/** Answer without content: decline, cancel, or "Done" of the url mode (accept). */
function answer(sessionKey: string, decision: ElicitationDecision, action: ElicitationAction) {
  return () =>
    respondToDecision(sessionKey, decision, { kind: 'elicitation', response: { action, content: null } });
}

/** The server's message (plain text, never HTML) and the request's description. */
function Intro({ decision }: { decision: ElicitationDecision }) {
  return (
    <>
      {decision.message.trim() === '' ? null : (
        <p data-slot="elicitation-message" className="break-words whitespace-pre-wrap">
          {decision.message}
        </p>
      )}
      {decision.description === null || decision.description === decision.message ? null : (
        <p data-slot="elicitation-description" className="text-muted-foreground mt-1 text-xs break-words">
          {decision.description}
        </p>
      )}
    </>
  );
}

/** Shell of every elicitation card: title, the MCP server as the asker. */
function ElicitationShell({
  sessionKey,
  decision,
  headerExtra,
  primary,
  actions,
  children,
}: CardProps & { primary: (() => Promise<boolean>) | null; actions: ReactNode; children: ReactNode }) {
  const t = useT();
  return (
    <DecisionCardShell
      sessionKey={sessionKey}
      decision={decision}
      title={elicitationTitle(decision, t)}
      headerExtra={headerExtra}
      requester={<ElicitationServerLabel decision={decision} />}
      primary={primary}
      actions={actions}
    >
      {children}
    </DecisionCardShell>
  );
}

/** Outside the supported subset (or a url mode without an http(s) target): the reason, "Decline" only. */
function UnsupportedCard({ reason, ...props }: CardProps & { reason: string }) {
  const t = useT();
  const decline = answer(props.sessionKey, props.decision, 'decline');
  return (
    <ElicitationShell
      {...props}
      primary={decline}
      actions={
        <DecisionAction data-action="decline" onAnswer={decline}>
          {t('decisions.elicitation.decline')}
        </DecisionAction>
      }
    >
      <Intro decision={props.decision} />
      <Alert
        tone="warning"
        data-slot="elicitation-unsupported"
        title={t('decisions.elicitation.unsupportedTitle')}
        className="mt-2"
      >
        {reason}
      </Alert>
    </ElicitationShell>
  );
}

/**
 * Url mode: the target in full (host on its own line), "Open in browser" through the one way for
 * external links (`openExternalLink`: the host opens the default browser), then "Done" (accept) or
 * "Cancel". Opening is no answer; "Done" becomes the main action once the page was opened here.
 * When the server finishes the request (`elicitation_complete`) the card goes away by itself.
 */
function UrlCard({ target, ...props }: CardProps & { target: ElicitationUrlTarget }) {
  const t = useT();
  const { sessionKey, decision } = props;
  const [opened, setOpened] = useState(false);
  const done = answer(sessionKey, decision, 'accept');
  const cancel = answer(sessionKey, decision, 'cancel');
  return (
    <ElicitationShell
      {...props}
      primary={opened ? done : null}
      actions={
        <>
          <Button
            size="sm"
            variant={opened ? 'outline' : 'default'}
            data-action="open-url"
            onClick={() => {
              if (openExternalLink(target.href)) setOpened(true);
            }}
          >
            <ExternalLinkIcon aria-hidden />
            {t('decisions.elicitation.openUrl')}
          </Button>
          <DecisionAction variant={opened ? 'default' : 'outline'} data-action="done" onAnswer={done}>
            {t('decisions.elicitation.done')}
          </DecisionAction>
          <span className="flex-1" />
          <DecisionAction
            variant="ghost"
            data-action="cancel"
            title={t('decisions.elicitation.cancelHint')}
            onAnswer={cancel}
          >
            {t('decisions.elicitation.cancel')}
          </DecisionAction>
        </>
      }
    >
      <Intro decision={decision} />
      <div
        data-slot="elicitation-url"
        className="bg-muted/60 mt-2 flex items-start gap-2 rounded-md px-2 py-1.5"
      >
        <GlobeIcon aria-hidden className="text-muted-foreground mt-0.5 size-3.5 shrink-0" />
        <div className="grid min-w-0 flex-1 gap-0.5">
          <span data-slot="elicitation-url-host" className="text-xs font-medium break-all">
            {target.host}
          </span>
          <a
            href={target.href}
            target="_blank"
            rel="noopener noreferrer"
            className="text-muted-foreground hover:text-foreground font-mono text-2xs break-all underline-offset-2 hover:underline"
            onClick={(event) => {
              onExternalLinkClick(event, target.href);
              setOpened(true);
            }}
          >
            {target.href}
          </a>
        </div>
        <CopyButton text={target.href} label={t('decisions.elicitation.copyUrl')} />
      </div>
      <p role="status" className="text-muted-foreground mt-1 text-2xs">
        {opened ? t('decisions.elicitation.urlOpened') : t('decisions.elicitation.urlHint')}
      </p>
    </ElicitationShell>
  );
}

/**
 * Form mode: the fields (ElicitationFields) checked with zod before sending. Errors show at a field
 * once it was left (except "required") and at every field after a send attempt; the first invalid
 * field then takes the focus. A value the server refuses (`content.<key>`) is marked at its field,
 * any other failure shows in the card. The fields stay editable while an answer is on its way, so
 * the focus can always move to the field that needs a fix.
 */
function FormCard(props: CardProps) {
  const { t, tError } = useI18n();
  const { sessionKey, decision } = props;
  const { fields } = decision;
  const idBase = useId();
  const formRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState<ElicitationDraft>(() => initialElicitationDraft(fields));
  const [touched, setTouched] = useState<ReadonlySet<string>>(() => new Set());
  const [badInput, setBadInput] = useState<ReadonlySet<string>>(() => new Set());
  const [attempted, setAttempted] = useState(false);
  const [rejected, setRejected] = useState<string | null>(null);
  const [failure, setFailure] = useState<ErrorPayload | null>(null);
  const check = checkElicitationDraft(fields, draft, badInput);

  const issueOf = (key: string): ElicitationIssue | null => {
    const issue = check.ok ? undefined : check.issues.get(key);
    if (issue === undefined) return rejected === key ? REJECTED : null;
    if (attempted) return issue;
    return touched.has(key) && issue.code !== 'required' ? issue : null;
  };

  const focusField = (key: string | undefined) => {
    const index = fields.findIndex((field) => field.key === key);
    const row = formRef.current?.querySelector(`[data-field-index="${String(index)}"]`);
    const target =
      row?.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]') ??
      row?.querySelector<HTMLElement>('input, textarea, button');
    target?.focus();
  };

  const send = async (): Promise<boolean> => {
    setAttempted(true);
    setFailure(null);
    setRejected(null);
    const result = checkElicitationDraft(fields, draft, badInput);
    if (!result.ok) {
      if (result.error !== null) setFailure(result.error);
      focusField(result.issues.keys().next().value);
      return false;
    }
    const sent = await respondInCard(sessionKey, decision, {
      kind: 'elicitation',
      response: result.response,
    });
    if (sent.ok) return true;
    // Answered elsewhere first: a notice says so and the card goes away.
    if (sent.error.code === 'DECISION_ALREADY_RESOLVED') return false;
    const key = fieldKeyOfError(sent.error, fields);
    if (key === null) {
      setFailure(sent.error);
    } else {
      setRejected(key);
      focusField(key);
    }
    return false;
  };
  const decline = answer(sessionKey, decision, 'decline');
  const cancel = answer(sessionKey, decision, 'cancel');
  const server = elicitationServerName(decision);

  return (
    <ElicitationShell
      {...props}
      primary={send}
      actions={
        <>
          <DecisionAction data-action="send" onAnswer={send}>
            {t('decisions.elicitation.send')}
          </DecisionAction>
          <DecisionAction
            variant="outline"
            data-action="decline"
            title={t('decisions.elicitation.declineHint', { server })}
            onAnswer={decline}
          >
            {t('decisions.elicitation.decline')}
          </DecisionAction>
          <span className="flex-1" />
          <DecisionAction
            variant="ghost"
            data-action="cancel"
            title={t('decisions.elicitation.cancelHint')}
            onAnswer={cancel}
          >
            {t('decisions.elicitation.cancel')}
          </DecisionAction>
        </>
      }
    >
      <Intro decision={decision} />
      <div ref={formRef}>
        <ElicitationFields
          idBase={idBase}
          fields={fields}
          draft={draft}
          issueOf={issueOf}
          onChange={(key: string, value: ElicitationDraftValue) => {
            setDraft((current) => new Map(current).set(key, value));
            if (rejected === key) setRejected(null);
            if (badInput.has(key)) {
              setBadInput((current) => {
                const next = new Set(current);
                next.delete(key);
                return next;
              });
            }
          }}
          onBlur={(key, bad) => {
            setTouched((current) => (current.has(key) ? current : new Set(current).add(key)));
            setBadInput((current) => {
              if (current.has(key) === bad) return current;
              const next = new Set(current);
              if (bad) next.add(key);
              else next.delete(key);
              return next;
            });
          }}
        />
      </div>
      {failure === null ? null : (
        <Alert
          tone="error"
          data-slot="elicitation-failure"
          title={t('decisions.elicitation.sendFailed')}
          className="mt-2"
        >
          {tError(failure)}
        </Alert>
      )}
    </ElicitationShell>
  );
}

/**
 * Elicitation card (WP-116, ADR-256): an MCP server asks for input – a form, a page to open (url
 * mode) or, outside the supported subset, only the reason and "Decline". Non-modal like every
 * decision: nothing takes the focus when it appears (the bar announces it, "Go to decision" focuses
 * it), answers only by click or Mod+Enter (card-shell), Esc does nothing here – "Cancel" is an
 * explicit answer only.
 */
export function ElicitationCard(props: CardProps) {
  const t = useT();
  const { decision } = props;
  if (decision.unsupported !== null) return <UnsupportedCard {...props} reason={decision.unsupported} />;
  if (decision.mode === 'url') {
    const target = elicitationUrlTarget(decision.url);
    return target === null ? (
      <UnsupportedCard {...props} reason={t('decisions.elicitation.invalidUrl')} />
    ) : (
      <UrlCard {...props} target={target} />
    );
  }
  return <FormCard {...props} />;
}
