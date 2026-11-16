import { CpuIcon } from 'lucide-react';
import { memo, useEffect, useEffectEvent, useState } from 'react';
import { EFFORT_LEVELS, parseSessionKey, type EffortLevel } from '@shared/common';
import type { ModelOption } from '@shared/model';
import type { Command } from '@shared/protocol';
import { useT } from '@web/i18n';
import { errorPayloadOf } from '@web/state/connection';
import {
  sendCommand,
  useSessionConnectionStatus,
  useSessionSelector,
  useSummarySelector,
} from '@web/state/hooks';
import { showErrorNotice } from '@web/state/notices';
import { Button } from '@web/ui/button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@web/ui/dropdown-menu';
import { Spinner } from '@web/ui/spinner';
import {
  currentModelOption,
  DEFAULT_MODEL_VALUE,
  effectiveModelOption,
  groupModels,
  OPUSPLAN_VALUE,
} from './lib/models';

const DEFAULT_EFFORT = 'default';

type LoadState = 'idle' | 'loading' | 'failed';

/** Runs `run` once when the menu content mounts (= the menu opened, however it was opened). */
function OnOpen({ run }: { run: () => void }) {
  const onOpen = useEffectEvent(run);
  useEffect(() => {
    onOpen();
  }, []);
  return null;
}

/** Part of the menu: everything, or only the effort levels (`/effort` without a level, WP-37). */
export type ModelPickerSection = 'all' | 'effort';

export interface ModelPickerProps {
  sessionKey: string;
  /** Controlled open state (the composer opens it for `/model` and `/effort`); else uncontrolled. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  section?: ModelPickerSection;
  /** Focus after closing (default: back to the trigger). */
  onCloseAutoFocus?: (event: Event) => void;
}

/**
 * Model picker (Plan "Kopfleiste": `supportedModels` + effort, fast toggle). Models come from the
 * session detail (`detail.models`, loaded with `session.refreshModels` on first open when
 * missing); effort only when the model supports it, fast mode only when the model offers it
 * (`session.setFastMode`). The label shows the model setting, else the last model seen (F.6).
 * `/model` and `/effort` open it from the composer (controlled `open`, `section`). WP-57: aliases
 * (`default`, `opus` …) first, the full model ids under "More models"; the model list scrolls.
 * WP-73: "Default" follows Claude's own settings (`summary.claudeModel`, e.g. 'opusplan') – the
 * trigger names that model, the Default row says so; the rows of Claude's `modelPicker` form "Your
 * models"; every opening reloads the list (an edited settings.json shows while the session runs).
 */
export const ModelPicker = memo(function ModelPicker({
  sessionKey,
  open: controlledOpen,
  onOpenChange,
  section = 'all',
  onCloseAutoFocus,
}: ModelPickerProps) {
  const t = useT();
  const [ownOpen, setOwnOpen] = useState(false);
  const open = controlledOpen ?? ownOpen;
  const models = useSessionSelector<readonly ModelOption[] | null>(
    sessionKey,
    (view) => view.detail.models,
    null,
  );
  const modelSetting = useSummarySelector<string | null>(sessionKey, (s) => s.modelSetting, null);
  const claudeModel = useSummarySelector<string | null>(sessionKey, (s) => s.claudeModel, null);
  const actualModel = useSummarySelector<string | null>(sessionKey, (s) => s.model, null);
  const effort = useSummarySelector<EffortLevel | null>(sessionKey, (s) => s.effort, null);
  const fastMode = useSummarySelector<boolean | null>(sessionKey, (s) => s.fastMode, null);
  const online = useSessionConnectionStatus(sessionKey) === 'open';
  const [load, setLoad] = useState<LoadState>('idle');
  const [pending, setPending] = useState(false);
  const current = currentModelOption(models, modelSetting);
  // WP-73: what the session runs on – effort and fast mode follow that row.
  const effective = effectiveModelOption(models, modelSetting, claudeModel);
  // WP-73: "Default" = Claude's own settings; the model they name (label of its row, else the value).
  // The Default row always says so (what choosing it means); the trigger only while it is chosen.
  const settingsLabel =
    claudeModel === null
      ? null
      : (models?.find((model) => model.value === claudeModel)?.displayName ??
        (claudeModel === OPUSPLAN_VALUE ? t('composer.model.opusPlan') : claudeModel));
  const follows = modelSetting === null ? settingsLabel : null;
  // WP22-12: "Default" follows the CLI/user settings (or ANTHROPIC_MODEL) – its description may
  // name another model than the one that answers; show the model actually seen next to it.
  const actualForDefault =
    modelSetting === null && current?.value === DEFAULT_MODEL_VALUE ? actualModel : null;
  const defaultLabel = follows ?? current?.displayName ?? null;
  const label =
    defaultLabel !== null && actualForDefault !== null
      ? t('composer.model.defaultActual', { label: defaultLabel, model: actualForDefault })
      : (follows ?? current?.displayName ?? modelSetting ?? actualModel ?? t('composer.model.default'));
  const efforts =
    effective?.supportsEffort === true
      ? EFFORT_LEVELS.filter((level) => effective.supportedEffortLevels.includes(level))
      : [];

  const run = async (build: (entryId: string) => Command) => {
    const parsed = parseSessionKey(sessionKey);
    if (parsed === null) return;
    setPending(true);
    try {
      await sendCommand(sessionKey, build(parsed.entryId));
    } catch (caught) {
      showErrorNotice(errorPayloadOf(caught), { sessionKey, id: `composer.model.${sessionKey}` });
    } finally {
      setPending(false);
    }
  };

  const refresh = async () => {
    const parsed = parseSessionKey(sessionKey);
    if (parsed === null) return;
    setLoad('loading');
    try {
      await sendCommand(sessionKey, { name: 'session.refreshModels', entryId: parsed.entryId });
      setLoad('idle');
    } catch {
      setLoad('failed');
    }
  };

  const groups = groupModels(models ?? []);
  const renderModel = (model: ModelOption) => {
    // WP-73: the CLI's text describes ITS default model – Parallax's Default follows the settings.
    const description =
      model.value === DEFAULT_MODEL_VALUE && settingsLabel !== null
        ? t('composer.model.follows', { model: settingsLabel })
        : model.description;
    return (
      <DropdownMenuRadioItem key={model.value} value={model.value} className="items-start">
        <span className="grid min-w-0 gap-0.5">
          <span>{model.displayName}</span>
          {description === '' ? null : (
            <span data-slot="model-description" className="text-muted-foreground text-2xs">
              {description}
            </span>
          )}
          {model.value === DEFAULT_MODEL_VALUE && actualForDefault !== null ? (
            <span data-slot="model-actual" className="text-muted-foreground text-2xs">
              {t('composer.model.actual', { model: actualForDefault })}
            </span>
          ) : null}
        </span>
      </DropdownMenuRadioItem>
    );
  };

  const effortOnly = section === 'effort';
  const effortGroup =
    efforts.length === 0 ? null : (
      <>
        {effortOnly ? null : <DropdownMenuSeparator />}
        <DropdownMenuLabel>{t('composer.model.effort')}</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={effort ?? DEFAULT_EFFORT}
          onValueChange={(value) => {
            const level: EffortLevel | null | undefined =
              value === DEFAULT_EFFORT ? null : efforts.find((candidate) => candidate === value);
            if (level === undefined || level === effort) return;
            void run((entryId) => ({ name: 'session.setEffort', entryId, effort: level }));
          }}
        >
          <DropdownMenuRadioItem value={DEFAULT_EFFORT}>
            {t('composer.model.effortDefault')}
          </DropdownMenuRadioItem>
          {efforts.map((level) => (
            <DropdownMenuRadioItem key={level} value={level}>
              {t(`composer.model.effortLevels.${level}`)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </>
    );

  return (
    <DropdownMenu
      modal={false}
      open={open}
      onOpenChange={(next) => {
        setOwnOpen(next);
        onOpenChange?.(next);
      }}
    >
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          data-slot="model-picker"
          disabled={!online}
          aria-label={t('composer.model.trigger', { model: label })}
          className="max-w-48"
        >
          <CpuIcon aria-hidden />
          <span className="truncate">{label}</span>
          {pending ? <Spinner className="size-3" /> : null}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="w-72"
        data-section={section}
        onCloseAutoFocus={onCloseAutoFocus}
      >
        <OnOpen
          run={() => {
            // Every way of opening (click, keyboard, `/model` from the composer) loads the list –
            // WP-73: also an existing one (Claude's settings may have changed); it stays meanwhile.
            if (load !== 'loading') void refresh();
          }}
        />
        {effortOnly ? (
          (effortGroup ?? (
            <DropdownMenuItem disabled>
              {models === null
                ? load === 'failed'
                  ? t('composer.model.unavailable')
                  : t('composer.model.loading')
                : t('composer.model.effortUnavailable')}
            </DropdownMenuItem>
          ))
        ) : (
          <DropdownMenuLabel>{t('composer.model.label')}</DropdownMenuLabel>
        )}
        {effortOnly ? null : models === null ? (
          <DropdownMenuItem disabled>
            {load === 'failed' ? t('composer.model.unavailable') : t('composer.model.loading')}
          </DropdownMenuItem>
        ) : (
          <DropdownMenuRadioGroup
            data-slot="model-list"
            // WP-57: 14 entries (CLI 2.1.322) – the list scrolls, effort and fast mode stay in view.
            className="max-h-[min(20rem,50vh)] overflow-y-auto"
            value={current?.value ?? ''}
            onValueChange={(value) => {
              const option = models.find((model) => model.value === value);
              if (option === undefined || option === current) return;
              const model = option.value === DEFAULT_MODEL_VALUE ? null : option.value;
              void run((entryId) => ({ name: 'session.setModel', entryId, model }));
            }}
          >
            {groups.aliases.map(renderModel)}
            {groups.curated.length > 0 ? (
              <>
                {groups.aliases.length > 0 ? <DropdownMenuSeparator /> : null}
                <DropdownMenuLabel data-slot="model-yours">{t('composer.model.yours')}</DropdownMenuLabel>
                {groups.curated.map(renderModel)}
              </>
            ) : null}
            {groups.aliases.length + groups.curated.length > 0 && groups.fullIds.length > 0 ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuLabel data-slot="model-more">{t('composer.model.more')}</DropdownMenuLabel>
              </>
            ) : null}
            {groups.fullIds.map(renderModel)}
          </DropdownMenuRadioGroup>
        )}
        {effortOnly ? null : effortGroup}
        {!effortOnly && effective?.supportsFastMode === true ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuCheckboxItem
              checked={fastMode === true}
              onCheckedChange={(checked) => {
                void run((entryId) => ({ name: 'session.setFastMode', entryId, enabled: checked }));
              }}
            >
              {t('composer.model.fast')}
            </DropdownMenuCheckboxItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
});
