import {
  EFFORT_LEVELS,
  LIMITS,
  modelNameSchema,
  type EffortLevel,
  type EntryId,
  type PermissionMode,
} from '@shared/common';
import type { ModelOption } from '@shared/model';
import type { Command } from '@shared/protocol';
import type { TranslationKey, TranslationParams } from '@web/i18n';
import { requestShell } from '@web/shell/requests';
import { errorPayloadOf } from '@web/state/connection';
import { sendCommand } from '@web/state/hooks';
import { showErrorNotice } from '@web/state/notices';
import { currentModelOption } from './models';
import type { NativeCommand } from './slash';

/**
 * The slash commands Parallax handles itself (ADR-108, WP-37 §2): `/model`, `/effort`, `/fast`,
 * `/plan`, `/rename`, `/status`, `/resume`, `/help`. Invalid arguments give an inline error (the
 * draft stays); a failed server command shows a notice (architecture §2.3i) and also keeps it.
 */

/** Translated inline error under the field. */
export interface InlineError {
  key: TranslationKey;
  params?: TranslationParams;
}

export type NativeResult = { ok: true } | { ok: false; error: InlineError | null };

export interface NativeContext {
  sessionKey: string;
  entryId: EntryId;
  models: readonly ModelOption[] | null;
  modelSetting: string | null;
  fastMode: boolean | null;
  permissionMode: PermissionMode | null;
  /** Opens the model picker (`all`) or only its effort part. */
  openPicker(section: 'all' | 'effort'): void;
  openHelp(): void;
  /** Sends a prompt like the composer does (attachments included); false on failure. */
  sendText(text: string): Promise<boolean>;
}

const OK: NativeResult = { ok: true };

function inline(key: TranslationKey, params?: TranslationParams): NativeResult {
  return { ok: false, error: params === undefined ? { key } : { key, params } };
}

async function run(context: NativeContext, cmd: Command): Promise<NativeResult> {
  try {
    await sendCommand(context.sessionKey, cmd);
    return OK;
  } catch (caught) {
    showErrorNotice(errorPayloadOf(caught), {
      sessionKey: context.sessionKey,
      id: `composer.native.${context.sessionKey}`,
    });
    return { ok: false, error: null };
  }
}

function shell(handled: boolean, command: NativeCommand): NativeResult {
  return handled ? OK : inline('composer.slash.error.unavailable', { command });
}

/** `/effort` argument: a level, `default`/`auto` (= the model's default), else undefined. */
export function parseEffort(value: string): EffortLevel | null | undefined {
  const lower = value.toLowerCase();
  if (lower === 'default' || lower === 'auto') return null;
  return EFFORT_LEVELS.find((level) => level === lower);
}

/** `/fast` argument: on/off (also true/false, 1/0), else undefined. */
export function parseOnOff(value: string): boolean | undefined {
  const lower = value.toLowerCase();
  if (lower === 'on' || lower === 'true' || lower === '1') return true;
  if (lower === 'off' || lower === 'false' || lower === '0') return false;
  return undefined;
}

export async function runNativeCommand(
  context: NativeContext,
  command: NativeCommand,
  args: string,
): Promise<NativeResult> {
  const { entryId, sessionKey } = context;
  switch (command) {
    case 'model': {
      if (args === '') {
        context.openPicker('all');
        return OK;
      }
      if (args.toLowerCase() === 'default')
        return run(context, { name: 'session.setModel', entryId, model: null });
      const parsed = modelNameSchema.safeParse(args);
      if (!parsed.success) return inline('composer.slash.error.invalidModel', { name: args });
      return run(context, { name: 'session.setModel', entryId, model: parsed.data });
    }
    case 'effort': {
      if (args === '') {
        const model = currentModelOption(context.models, context.modelSetting);
        if (model !== null && !model.supportsEffort) return inline('composer.model.effortUnavailable');
        context.openPicker('effort');
        return OK;
      }
      const level = parseEffort(args);
      if (level === undefined) {
        return inline('composer.slash.error.invalidEffort', {
          value: args,
          levels: EFFORT_LEVELS.join(', '),
        });
      }
      return run(context, { name: 'session.setEffort', entryId, effort: level });
    }
    case 'fast': {
      if (currentModelOption(context.models, context.modelSetting)?.supportsFastMode !== true) {
        return inline('composer.slash.error.fastUnavailable');
      }
      const enabled = args === '' ? context.fastMode !== true : parseOnOff(args);
      if (enabled === undefined) return inline('composer.slash.error.invalidFast');
      return run(context, { name: 'session.setFastMode', entryId, enabled });
    }
    case 'plan': {
      if (context.permissionMode !== 'plan') {
        const result = await run(context, { name: 'session.setPermissionMode', entryId, mode: 'plan' });
        if (!result.ok) return result;
      }
      if (args === '') return OK;
      return (await context.sendText(args)) ? OK : { ok: false, error: null };
    }
    case 'rename': {
      if (args === '') return shell(requestShell({ kind: 'renameTitle', sessionKey }), command);
      if (args.length > LIMITS.titleChars) {
        return inline('composer.slash.error.titleTooLong', { max: LIMITS.titleChars });
      }
      return run(context, { name: 'session.rename', entryId, title: args });
    }
    case 'status':
      return shell(requestShell({ kind: 'sessionInfo', sessionKey }), command);
    case 'resume':
      return shell(requestShell({ kind: 'conversations', sessionKey }), command);
    case 'help':
      context.openHelp();
      return OK;
  }
}
