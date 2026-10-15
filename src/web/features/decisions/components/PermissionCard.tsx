import { ChevronRightIcon, TriangleAlertIcon } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { LIMITS, type RuleDestination } from '@shared/common';
import type { PermissionDecision } from '@shared/model';
import { useT } from '@web/i18n';
import { useFeatureSlots } from '@web/shell/slots';
import { Badge } from '@web/ui/badge';
import { Button } from '@web/ui/button';
import { Disclosure } from '@web/ui/disclosure';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@web/ui/dropdown-menu';
import { Label } from '@web/ui/label';
import { Textarea } from '@web/ui/textarea';
import { respondToDecision } from '../lib/respond';
import { isFileChangeTool, ruleLabel, summarizeToolInput } from '../lib/tool-input';
import { ChoiceMenu, type Choice } from './ChoiceMenu';
import { DecisionAction, DecisionCardShell, useCardDisabled, useCardRespond } from './card-shell';

/** Which denial form is open: with a reason, or with a reason (optional) + stop the turn. */
type DenyFormMode = 'reason' | 'stop';

/** UI default is `session` (ADR-012); otherwise the first offered destination. */
export function defaultDestination(destinations: readonly RuleDestination[]): RuleDestination | null {
  if (destinations.includes('session')) return 'session';
  return destinations[0] ?? null;
}

function DestinationBadge({ destination }: { destination: RuleDestination }) {
  const t = useT();
  if (destination === 'projectSettings') {
    return (
      <Badge variant="warning" data-slot="destination-warning">
        <TriangleAlertIcon aria-hidden />
        {t('decisions.permission.writesToRepo')}
      </Badge>
    );
  }
  if (destination === 'userSettings') {
    return (
      <Badge variant="warning" data-slot="destination-warning">
        <TriangleAlertIcon aria-hidden />
        {t('decisions.permission.global')}
      </Badge>
    );
  }
  return null;
}

function DenyForm({
  sessionKey,
  decision,
  mode,
  inputRef: ref,
  onCancel,
}: {
  sessionKey: string;
  decision: PermissionDecision;
  mode: DenyFormMode;
  /** The reason field (the "▾" menu focuses it again once it has closed). */
  inputRef: RefObject<HTMLTextAreaElement | null>;
  onCancel: () => void;
}) {
  const t = useT();
  const [reason, setReason] = useState('');
  const respond = useCardRespond();
  const disabled = useCardDisabled();
  const stop = mode === 'stop';
  useEffect(() => {
    // Opened by the user (a "▾" entry): moving the focus here is no focus theft.
    ref.current?.focus();
  }, [mode, ref]);
  const deny = () =>
    respondToDecision(sessionKey, decision, {
      kind: 'permission',
      response: { behavior: 'deny', message: reason.trim(), interrupt: stop },
    });
  const id = `deny-reason-${decision.id}`;
  const hintId = `${id}-stop`;
  return (
    <div data-slot="deny-form" data-mode={mode} className="mt-2 grid gap-1.5">
      <Label htmlFor={id}>
        {stop ? t('decisions.permission.reasonOptional') : t('decisions.permission.reasonLabel')}
      </Label>
      <Textarea
        id={id}
        ref={ref}
        value={reason}
        maxLength={LIMITS.decisionMessageChars}
        placeholder={t('decisions.permission.reasonPlaceholder')}
        aria-describedby={stop ? hintId : undefined}
        className="max-h-32 min-h-10"
        disabled={disabled}
        onChange={(event) => {
          setReason(event.target.value);
        }}
        onKeyDown={(event) => {
          // Mod+Enter here sends THIS denial (never the card's main action "allow").
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.altKey) {
            event.preventDefault();
            respond(deny);
          }
        }}
      />
      {stop ? (
        <p id={hintId} className="text-warning flex items-center gap-1 text-2xs">
          <TriangleAlertIcon aria-hidden className="size-3" />
          {t('decisions.permission.stopHint')}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-1.5">
        <DecisionAction
          variant="destructive"
          data-action={stop ? 'deny-stop' : 'deny-reason'}
          onAnswer={deny}
        >
          {stop ? t('decisions.permission.sendDenialAndStop') : t('decisions.permission.sendDenial')}
        </DecisionAction>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
      </div>
    </div>
  );
}

/**
 * "▾" of the deny button: both entries only OPEN a denial form (R2W-05) – a menu item reacts to
 * Enter/Space (and typeahead), so it must never answer itself; the answer is the form's
 * `DecisionAction` (pointer or Mod+Enter only).
 */
function DenyMenu({
  onOpenForm,
  focusForm,
}: {
  onOpenForm: (mode: DenyFormMode) => void;
  /** Focuses the opened form's reason field. */
  focusForm: () => void;
}) {
  const t = useT();
  const disabled = useCardDisabled();
  /** An entry opened a form: the form gets the focus, the menu must not return it to "▾". */
  const openedForm = useRef(false);
  const open = (mode: DenyFormMode) => {
    openedForm.current = true;
    onOpenForm(mode);
  };
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="icon-sm"
          aria-label={t('decisions.permission.denyMenu')}
          title={t('decisions.permission.denyMenu')}
          disabled={disabled}
        >
          <ChevronRightIcon aria-hidden className="rotate-90" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        onCloseAutoFocus={(event) => {
          // WP-20c: in Edge the closing menu (exit animation) took the focus from the reason
          // field – the item under the pointer moved away as the form appeared, Radix focused the
          // content on `pointerleave` – and then returned it to "▾": the user typed into nothing.
          // Once the menu is gone, the focus goes (back) to the form.
          if (!openedForm.current) return;
          openedForm.current = false;
          event.preventDefault();
          focusForm();
        }}
      >
        <DropdownMenuItem
          onSelect={() => {
            open('reason');
          }}
        >
          {t('decisions.permission.denyWithReason')}
        </DropdownMenuItem>
        <DropdownMenuItem
          variant="destructive"
          onSelect={() => {
            open('stop');
          }}
        >
          {t('decisions.permission.denyAndStop')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Permission card (Plan "Permission-Karten", ADR-012, F.3): tool, input summary, diff preview for
 * Edit/Write (slot `ToolInputPreview`, WP-15), "allow once", "always allow" with a destination
 * (session default; project/user marked), "allow + accept edits" as its own explicit option, deny
 * (with reason / and stop). `offer.ruleDestinations = []` (suppressAlwaysAllowRule) hides
 * "always"; `defaultToNo` makes "deny" the main action.
 */
export function PermissionCard({
  sessionKey,
  decision,
  headerExtra,
}: {
  sessionKey: string;
  decision: PermissionDecision;
  headerExtra?: ReactNode;
}) {
  const t = useT();
  const { ToolInputPreview } = useFeatureSlots();
  const { offer } = decision;
  const canRemember =
    offer.ruleDestinations.length > 0 && (offer.rules.length > 0 || offer.directories.length > 0);
  const [destination, setDestination] = useState<RuleDestination | null>(() =>
    defaultDestination(offer.ruleDestinations),
  );
  const [denyForm, setDenyForm] = useState<DenyFormMode | null>(null);
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  const tool = decision.displayName ?? decision.toolName;
  const summary = summarizeToolInput(decision.toolName, decision.input);
  const fileChange = isFileChangeTool(decision.toolName);

  const allow = (remember: RuleDestination | null, acceptEdits: boolean) => () =>
    respondToDecision(sessionKey, decision, {
      kind: 'permission',
      response: { behavior: 'allow', remember, acceptEdits },
    });
  const deny = () =>
    respondToDecision(sessionKey, decision, {
      kind: 'permission',
      response: { behavior: 'deny', message: '', interrupt: false },
    });

  const rules = offer.rules.map(ruleLabel).join(', ');
  const destinationChoices: Choice<RuleDestination>[] = offer.ruleDestinations.map((value) => ({
    value,
    label: t(`decisions.permission.destinations.${value}`),
    hint: t(`decisions.permission.destinationHints.${value}`),
    badge: <DestinationBadge destination={value} />,
  }));

  const allowOnce = (
    <DecisionAction
      key="allow-once"
      variant={offer.defaultToNo ? 'outline' : 'default'}
      data-action="allow-once"
      onAnswer={allow(null, false)}
    >
      {t('decisions.permission.allowOnce')}
    </DecisionAction>
  );
  const denyButton = (
    <span key="deny" className="inline-flex items-center gap-px">
      <DecisionAction variant={offer.defaultToNo ? 'default' : 'outline'} data-action="deny" onAnswer={deny}>
        {t('decisions.permission.deny')}
      </DecisionAction>
      <DenyMenu
        onOpenForm={setDenyForm}
        focusForm={() => {
          reasonRef.current?.focus();
        }}
      />
    </span>
  );

  const actions = (
    <>
      {offer.defaultToNo ? denyButton : allowOnce}
      {canRemember && destination !== null ? (
        <span className="inline-flex items-center gap-px">
          <DecisionAction variant="outline" data-action="allow-always" onAnswer={allow(destination, false)}>
            {t('decisions.permission.allowAlways', {
              destination: t(`decisions.permission.destinations.${destination}`),
            })}
          </DecisionAction>
          <ChoiceMenu
            label={t('decisions.permission.destinationMenu')}
            heading={t('decisions.permission.destinationMenu')}
            value={destination}
            choices={destinationChoices}
            onChange={setDestination}
            footer={
              <>
                {rules === '' ? null : (
                  <span className="block">{t('decisions.permission.remembers', { rules })}</span>
                )}
                {offer.directories.length === 0 ? null : (
                  <span className="block">
                    {t('decisions.permission.folders', { folders: offer.directories.join(', ') })}
                  </span>
                )}
                <span className="block">{t('decisions.permission.noGuarantee')}</span>
              </>
            }
          />
          <DestinationBadge destination={destination} />
        </span>
      ) : null}
      {offer.acceptEdits ? (
        <DecisionAction
          variant="outline"
          data-action="accept-edits"
          title={t('decisions.permission.acceptEditsHint')}
          onAnswer={allow(null, true)}
        >
          {t('decisions.permission.acceptEdits')}
        </DecisionAction>
      ) : null}
      <span className="flex-1" />
      {offer.defaultToNo ? allowOnce : denyButton}
    </>
  );

  return (
    <DecisionCardShell
      sessionKey={sessionKey}
      decision={decision}
      title={decision.title ?? t('decisions.permission.title', { tool })}
      headerExtra={headerExtra}
      primary={offer.defaultToNo ? deny : allow(null, false)}
      actions={actions}
    >
      {decision.description === null || decision.description === decision.title ? null : (
        <p className="text-muted-foreground text-xs">{decision.description}</p>
      )}
      <pre
        data-slot="tool-input-summary"
        data-kind={summary.kind}
        className="bg-muted/60 mt-1 max-h-24 overflow-auto rounded-md px-2 py-1 font-mono text-2xs break-all whitespace-pre-wrap"
      >
        {summary.text}
      </pre>
      <div className="text-muted-foreground mt-1 grid gap-0.5 text-2xs">
        {decision.decisionReason === null ? null : (
          <span>{t('decisions.permission.reason', { reason: decision.decisionReason })}</span>
        )}
        {decision.blockedPath === null ? null : (
          <span className="font-mono break-all">
            {t('decisions.permission.blockedPath', { path: decision.blockedPath })}
          </span>
        )}
        {decision.mcpServer === null ? null : (
          <span>{t('decisions.permission.mcpServer', { name: decision.mcpServer.name })}</span>
        )}
        {decision.inputTruncated === null ? null : <span>{t('decisions.permission.inputTruncated')}</span>}
      </div>
      {offer.defaultToNo ? (
        <p className="text-warning mt-1 flex items-center gap-1 text-xs">
          <TriangleAlertIcon aria-hidden className="size-3.5" />
          {t('decisions.permission.defaultToNo')}
        </p>
      ) : null}
      <Disclosure
        defaultOpen={fileChange}
        className="mt-1"
        triggerClassName="text-muted-foreground flex-none text-xs"
        contentClassName="mt-1"
        header={fileChange ? t('decisions.permission.showChange') : t('decisions.permission.showInput')}
      >
        <div data-slot="tool-input-preview" className="max-h-64 overflow-auto">
          <ToolInputPreview toolName={decision.toolName} input={decision.input} sessionKey={sessionKey} />
        </div>
      </Disclosure>
      {denyForm === null ? null : (
        <DenyForm
          sessionKey={sessionKey}
          decision={decision}
          mode={denyForm}
          inputRef={reasonRef}
          onCancel={() => {
            setDenyForm(null);
          }}
        />
      )}
    </DecisionCardShell>
  );
}
