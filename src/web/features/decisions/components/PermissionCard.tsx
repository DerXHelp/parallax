import { ChevronRightIcon, TriangleAlertIcon } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { RuleDestination } from '@shared/common';
import type { PermissionDecision } from '@shared/model';
import { useT } from '@web/i18n';
import { cn } from '@web/lib/cn';
import { useFeatureSlots } from '@web/shell/slots';
import { Badge } from '@web/ui/badge';
import { Button } from '@web/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@web/ui/collapsible';
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

/** Max length of a denial message (contract `permissionResponse.deny.message`). */
const DENY_MESSAGE_MAX = 10_000;

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

function Disclosure({
  label,
  defaultOpen,
  children,
}: {
  label: string;
  defaultOpen: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="mt-1">
      <CollapsibleTrigger asChild>
        <Button variant="ghost" size="sm" className="text-muted-foreground -ml-1 px-1">
          <ChevronRightIcon aria-hidden className={cn('transition-transform', open && 'rotate-90')} />
          {label}
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-1">{children}</CollapsibleContent>
    </Collapsible>
  );
}

function DenyForm({
  sessionKey,
  decision,
  onCancel,
}: {
  sessionKey: string;
  decision: PermissionDecision;
  onCancel: () => void;
}) {
  const t = useT();
  const [reason, setReason] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  const respond = useCardRespond();
  const disabled = useCardDisabled();
  useEffect(() => {
    // Opened by the user ("Deny with a reason…"): moving the focus here is no focus theft.
    ref.current?.focus();
  }, []);
  const deny = () =>
    respondToDecision(sessionKey, decision, {
      kind: 'permission',
      response: { behavior: 'deny', message: reason.trim(), interrupt: false },
    });
  const id = `deny-reason-${decision.id}`;
  return (
    <div data-slot="deny-form" className="mt-2 grid gap-1.5">
      <Label htmlFor={id}>{t('decisions.permission.reasonLabel')}</Label>
      <Textarea
        id={id}
        ref={ref}
        value={reason}
        maxLength={DENY_MESSAGE_MAX}
        placeholder={t('decisions.permission.reasonPlaceholder')}
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
      <div className="flex flex-wrap gap-1.5">
        <DecisionAction variant="destructive" onAnswer={deny}>
          {t('decisions.permission.sendDenial')}
        </DecisionAction>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
      </div>
    </div>
  );
}

function DenyMenu({
  sessionKey,
  decision,
  onReason,
}: {
  sessionKey: string;
  decision: PermissionDecision;
  onReason: () => void;
}) {
  const t = useT();
  const respond = useCardRespond();
  const disabled = useCardDisabled();
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
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={onReason}>{t('decisions.permission.denyWithReason')}</DropdownMenuItem>
        <DropdownMenuItem
          variant="destructive"
          onSelect={() => {
            respond(() =>
              respondToDecision(sessionKey, decision, {
                kind: 'permission',
                response: { behavior: 'deny', message: '', interrupt: true },
              }),
            );
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
  const [denyOpen, setDenyOpen] = useState(false);
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
        sessionKey={sessionKey}
        decision={decision}
        onReason={() => {
          setDenyOpen(true);
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
        label={fileChange ? t('decisions.permission.showChange') : t('decisions.permission.showInput')}
        defaultOpen={fileChange}
      >
        <div data-slot="tool-input-preview" className="max-h-64 overflow-auto">
          <ToolInputPreview toolName={decision.toolName} input={decision.input} sessionKey={sessionKey} />
        </div>
      </Disclosure>
      {denyOpen ? (
        <DenyForm
          sessionKey={sessionKey}
          decision={decision}
          onCancel={() => {
            setDenyOpen(false);
          }}
        />
      ) : null}
    </DecisionCardShell>
  );
}
