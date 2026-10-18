import {
  ArchiveIcon,
  ChevronDownIcon,
  CircleDotIcon,
  CornerDownRightIcon,
  ImageIcon,
  ImagePlusIcon,
  PaperclipIcon,
  ReplyIcon,
  SendHorizontalIcon,
  SquareIcon,
  SquareTerminalIcon,
  TerminalIcon,
  ZapIcon,
} from 'lucide-react';
import {
  memo,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
} from 'react';
import {
  LIMITS,
  LOCAL_HOST_ID,
  parseSessionKey,
  type DecisionId,
  type PermissionMode,
  type PromptPriority,
} from '@shared/common';
import { ATTACHMENT_MEDIA_TYPES } from '@shared/http';
import type { Decision, ModelOption, SlashCommandInfo } from '@shared/model';
import type { RunState } from '@shared/status';
import { useT, type t as translateFn } from '@web/i18n';
import { cn } from '@web/lib/cn';
import { useEscapeHandler } from '@web/shell/shortcuts';
import { followTranscript } from '@web/shell/transcript-follow';
import { errorPayloadOf } from '@web/state/connection';
import {
  sendCommand,
  useDecisions,
  useSessionConnectionStatus,
  useSessionSelector,
  useSummarySelector,
} from '@web/state/hooks';
import { showErrorNotice, showTextNotice } from '@web/state/notices';
import { reportTyping } from '@web/state/presence';
import { Alert } from '@web/ui/alert';
import { Button } from '@web/ui/button';
import { commandOptionId, handleCommandKey } from '@web/ui/command-list';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@web/ui/dropdown-menu';
import { IconButton } from '@web/ui/icon-button';
import { Kbd } from '@web/ui/kbd';
import { Spinner } from '@web/ui/spinner';
import { Textarea } from '@web/ui/textarea';
import { DecisionArmDelayContext } from '../decisions/components/card-shell';
import { requesterText } from '../decisions/components/RequesterLabel';
import { respondToDecision } from '../decisions/lib/respond';
import {
  markLocalResolution,
  pickDisplayedDecision,
  useSelectedDecisionId,
} from '../decisions/state/bar-store';
import { AttachmentChips } from './AttachmentChips';
import { ContextGauge } from './ContextGauge';
import { HelpDialog } from './HelpDialog';
import { answerFromText, interruptSession, isSingleQuestion, sendPrompt, textLimit } from './lib/commands';
import { runNativeCommand, type InlineError, type NativeContext } from './lib/native';
import {
  applyMenuEntry,
  buildMenuEntries,
  classifySlash,
  menuMatches,
  NATIVE_WITHOUT_ARGUMENT,
  resolveEntry,
  sendsPrompt,
  slashQuery,
  takesArgument,
  terminalCommands,
  type MenuEntry,
  type NativeCommand,
  type SlashCatalog,
} from './lib/slash';
import { ModelPicker, type ModelPickerSection } from './ModelPicker';
import { ModePicker } from './ModePicker';
import { RateLimitBanner } from './RateLimitBanner';
import { SlashMenu, slashMenuId } from './SlashMenu';
import {
  addAttachmentFiles,
  attachmentsOverTotal,
  getAttachments,
  releaseAttachments,
  restoreAttachments,
  takeAttachments,
  useAttachments,
} from './state/attachments';
import { clearDraft, getDraft, setDraft, useDraft } from './state/drafts';
import { useComposerFocusTarget } from './state/focus';

/** `primary` = Enter / main button, `answer` = explicit "Send as answer" (decision not the Enter target). */
type Via = 'primary' | 'answer' | 'message' | 'now';

type TargetKind = 'permission' | 'question' | 'questions' | 'plan';

/** The counter appears from this share of the limit on. */
const COUNTER_FROM = 0.8;

const EMPTY_NAMES: readonly string[] = Object.freeze([]);

/** Monotonic time of the arm delay; only read in effects and event handlers, never while rendering. */
function monotonicNow(): number {
  return performance.now();
}

function isWorking(runState: RunState | null): boolean {
  return runState === 'working' || runState === 'starting';
}

function targetKind(decision: Decision): TargetKind {
  if (decision.kind === 'question') return isSingleQuestion(decision) ? 'question' : 'questions';
  return decision.kind;
}

/** Hint above the field: `target` = Enter answers it, `pending` = it is open, Enter sends a message. */
function decisionHint(decision: Decision, variant: 'target' | 'pending', t: typeof translateFn): string {
  const requester = requesterText(decision.requester, t);
  switch (decision.kind) {
    case 'permission':
      return t(`composer.${variant}.permission`, {
        tool: decision.displayName ?? decision.toolName,
        requester,
      });
    case 'question':
      return isSingleQuestion(decision)
        ? t(`composer.${variant}.question`, { requester })
        : t(`composer.${variant}.questions`, { requester });
    case 'plan':
      return t(`composer.${variant}.plan`, { version: decision.version });
  }
}

/** Image files of a paste/drop (`getAsFile` of the file items). */
function clipboardFiles(data: DataTransfer): File[] {
  const files: File[] = [];
  for (const item of Array.from(data.items)) {
    if (item.kind !== 'file') continue;
    const file = item.getAsFile();
    if (file !== null) files.push(file);
  }
  return files;
}

function hasFiles(event: DragEvent): boolean {
  return Array.from(event.dataTransfer.types).includes('Files');
}

/**
 * Slot `Composer` (Plan "Chat-Ansicht → Interaktion", B "Tastatur", "Entwürfe"):
 * - Enter sends, Shift+Enter breaks the line (IME composition never sends).
 * - While Claude works, messages are queued (`priority: 'next'`; the transcript shows them grey,
 *   the header counts them – R2W-04); "Send now" sends with `priority: 'now'`; Stop (and Esc in
 *   an empty composer) interrupts.
 * - Open decision (the one the bar shows) – target lock (R2W-01, ADR-040): Enter answers it only
 *   if it was already shown (≥ arm delay) when the current draft began, and only for the main
 *   agent – permission deny + message, one question answered with the text, several questions
 *   declined + message, plan revise ("Keep planning with feedback"); it can never approve. A
 *   decision that appears while typing (or a subagent's, or a restored draft) leaves Enter as a
 *   normal send; the composer then offers "Send as answer" explicitly. "Keep planning" in the bar
 *   sets the target explicitly. With such a target there is no slash menu (the text is the answer).
 * - Slash commands (WP-37, ADR-108): menu while the caret is in the first word of a `/` draft
 *   (fuzzy, arrows, Tab/Enter, Esc); native commands run here, terminal-only ones offer the
 *   external console, all others go to Claude Code as a prompt.
 * - Images (ADR-103): paste, drop or the paper clip; chips above the field, uploads right away,
 *   sending waits for them. Prompt suggestion as placeholder, Tab takes it (ADR-117). Rate-limit
 *   banner (ADR-112). Archived / handed-off sessions get no field (the pane banner has the actions).
 * - Drafts per session survive remounts and reloads (state/drafts.ts); typing reports presence.
 * - Sending needs an open connection; failures restore the text and show a notice.
 */
export const Composer = memo(function Composer({ sessionKey }: { sessionKey: string }) {
  const archived = useSummarySelector<boolean>(sessionKey, (s) => s.archived, false);
  const external = useSummarySelector<boolean>(sessionKey, (s) => s.external !== null, false);
  if (archived) return <ComposerDisabled reason="archived" />;
  if (external) return <ComposerDisabled reason="external" />;
  return <ComposerEditor sessionKey={sessionKey} />;
});

/** WP-37 §7: no field while archived (ADR-106) or open in an external console (ADR-104). */
function ComposerDisabled({ reason }: { reason: 'archived' | 'external' }) {
  const t = useT();
  const Icon = reason === 'archived' ? ArchiveIcon : SquareTerminalIcon;
  return (
    <div data-slot="composer" data-mode="disabled" data-reason={reason} className="border-t px-3 py-2">
      <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
        <Icon aria-hidden className="size-3.5 shrink-0" />
        {t(`composer.disabled.${reason}`)}
      </p>
    </div>
  );
}

interface PickerState {
  open: boolean;
  section: ModelPickerSection;
}

const PICKER_CLOSED: PickerState = { open: false, section: 'all' };

const ComposerEditor = memo(function ComposerEditor({ sessionKey }: { sessionKey: string }) {
  const t = useT();
  const text = useDraft(sessionKey);
  const parsedKey = parseSessionKey(sessionKey);
  const entryId = parsedKey?.entryId ?? null;
  // Uploads go to the window's own server; a remote host could not resolve the blob (multi-host later).
  const canAttach = parsedKey?.hostId === LOCAL_HOST_ID;
  const runState = useSummarySelector<RunState | null>(sessionKey, (s) => s.status.runState, null);
  const modelSetting = useSummarySelector<string | null>(sessionKey, (s) => s.modelSetting, null);
  const fastMode = useSummarySelector<boolean | null>(sessionKey, (s) => s.fastMode, null);
  const permissionMode = useSummarySelector<PermissionMode | null>(sessionKey, (s) => s.permissionMode, null);
  const models = useSessionSelector<readonly ModelOption[] | null>(sessionKey, (v) => v.detail.models, null);
  const commands = useSessionSelector<readonly SlashCommandInfo[] | null>(
    sessionKey,
    (v) => v.detail.commands,
    null,
  );
  const slashCommands = useSessionSelector(
    sessionKey,
    (v) => v.detail.init?.slashCommands ?? EMPTY_NAMES,
    EMPTY_NAMES,
  );
  const terminalSlashCommands = useSessionSelector(
    sessionKey,
    (v) => v.detail.init?.terminalSlashCommands ?? EMPTY_NAMES,
    EMPTY_NAMES,
  );
  const promptSuggestion = useSessionSelector<string | null>(
    sessionKey,
    (v) => v.detail.promptSuggestion,
    null,
  );
  const attachments = useAttachments(sessionKey);
  const decisions = useDecisions(sessionKey);
  const selectedId = useSelectedDecisionId(sessionKey);
  const displayed = pickDisplayedDecision(decisions, selectedId);
  const target = displayed?.state === 'open' ? displayed : null;
  const targetId = target?.id ?? null;
  const online = useSessionConnectionStatus(sessionKey) === 'open';
  const armDelayMs = useContext(DecisionArmDelayContext);
  const rootRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  /** When the composer first saw the current target (arm delay, like the cards). */
  const shownRef = useRef<{ id: DecisionId; at: number } | null>(null);
  /** Caret to set after a programmatic draft change (menu pick, suggestion). */
  const pendingCaretRef = useRef<number | null>(null);
  /** The model picker was opened by `/model` or `/effort`: the focus returns to the field. */
  const pickerFromSlashRef = useRef(false);
  /** The decision Enter answers – fixed when the draft begins (R2W-01). */
  const [lockedId, setLockedId] = useState<DecisionId | null>(null);
  const [sending, setSending] = useState(0);
  const [caret, setCaret] = useState(0);
  const [menuQuery, setMenuQuery] = useState<string | null>(null);
  const [menuDismissed, setMenuDismissed] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [picker, setPicker] = useState<PickerState>(PICKER_CLOSED);
  const [helpOpen, setHelpOpen] = useState(false);
  const [terminalHint, setTerminalHint] = useState<string | null>(null);
  const [externalPending, setExternalPending] = useState(false);
  const [slashError, setSlashError] = useState<InlineError | null>(null);
  const [dragging, setDragging] = useState(false);
  const working = isWorking(runState);

  useEffect(() => {
    if (targetId !== null && shownRef.current?.id !== targetId) {
      shownRef.current = { id: targetId, at: monotonicNow() };
    }
  }, [targetId]);

  useLayoutEffect(() => {
    const position = pendingCaretRef.current;
    const field = textareaRef.current;
    if (position === null || field === null) return;
    pendingCaretRef.current = null;
    field.setSelectionRange(position, position);
  }, [text]);

  /** Shown for at least the arm delay – a decision appearing right before a key stroke is not taken. */
  const isArmed = (decision: Decision): boolean => {
    const shown = shownRef.current;
    return shown?.id === decision.id && monotonicNow() - shown.at >= armDelayMs;
  };

  // Enter answers the target only when the draft was begun for it. An empty field shows what the
  // first key stroke will fix (the main agent's decision), so placeholder and hint fit.
  const enterAnswers =
    target !== null && (lockedId === target.id || (text === '' && target.requester.kind === 'main'));
  const answerTarget = enterAnswers ? target : null;
  const pendingTarget = target !== null && !enterAnswers ? target : null;

  // ---- slash commands ----
  const describeNative = useCallback(
    (command: NativeCommand) => ({
      description: t(`composer.slash.native.${command}`),
      argumentHint: takesArgument(command) ? t(`composer.slash.nativeArguments.${command}`) : '',
    }),
    [t],
  );
  const entries = useMemo(() => {
    const catalog: SlashCatalog = { commands, slashCommands, terminalSlashCommands };
    return buildMenuEntries(catalog, describeNative);
  }, [commands, slashCommands, terminalSlashCommands, describeNative]);
  const terminal = useMemo(() => terminalCommands(terminalSlashCommands), [terminalSlashCommands]);
  const query = answerTarget === null ? slashQuery(text, caret) : null;
  if (query !== menuQuery) {
    // A new command word: the menu opens again with its first match active.
    setMenuQuery(query);
    setActiveIndex(0);
    setMenuDismissed(false);
  }
  // A fully typed terminal-only command closes the menu: Enter shows its hint (V3-02).
  const matches = useMemo(
    () => (query === null ? [] : menuMatches(entries, query, terminal)),
    [entries, query, terminal],
  );
  const menuOpen = query !== null && !menuDismissed && matches.length > 0;
  const menuIndex = Math.min(activeIndex, matches.length - 1);
  const activeEntry = menuOpen ? (matches[menuIndex] ?? null) : null;

  const value = text.trim();
  const draftAction =
    answerTarget === null && value.startsWith('/') ? classifySlash(value, entries, terminal) : null;
  const commandDraft = draftAction?.kind === 'native' || draftAction?.kind === 'terminal';
  // Argument hint after `/name ` (the menu took the command, nothing typed after it yet).
  const argumentMatch = menuOpen || answerTarget !== null ? null : /^\/(\S+) $/.exec(text);
  const argumentHint =
    argumentMatch?.[1] === undefined ? '' : (resolveEntry(entries, argumentMatch[1])?.argumentHint ?? '');

  // ---- attachments ----
  const busyUploads = attachments.some((a) => a.status === 'preparing' || a.status === 'uploading');
  const failedUploads = attachments.some((a) => a.status === 'error');
  const readyUploads = attachments.filter((a) => a.status === 'done').length;
  // ADR-125: together over `LIMITS.attachmentsTotalBytes` – the chips say which ones.
  const overTotal = useMemo(() => attachmentsOverTotal(attachments), [attachments]);
  const attachmentsBlocked = busyUploads || failedUploads || overTotal.size > 0;

  const limit = textLimit(answerTarget);
  const tooLong = value.length > limit;
  let canSend: boolean;
  if (answerTarget !== null) canSend = online && value !== '' && !tooLong;
  // `/plan text` sends the text with the images (R4W-26): it waits for them like a message.
  else if (commandDraft) canSend = online && !(sendsPrompt(draftAction) && attachmentsBlocked);
  else canSend = online && !tooLong && !attachmentsBlocked && (value !== '' || readyUploads > 0);
  const canAnswer =
    pendingTarget !== null && online && value !== '' && value.length <= textLimit(pendingTarget);
  const suggestion =
    answerTarget === null && text === '' && promptSuggestion !== null && promptSuggestion.trim() !== ''
      ? promptSuggestion.trim()
      : null;

  useComposerFocusTarget(sessionKey, (decisionId) => {
    // "Keep planning" chose the decision explicitly: Enter answers it.
    if (decisionId !== null) setLockedId(decisionId);
    textareaRef.current?.focus();
  });

  const stop = () => {
    // The interrupt cancels every open decision of the session (WP-13 §3.4): no "elsewhere" hints.
    markLocalResolution(decisions.filter((decision) => decision.state === 'open').map((d) => d.id));
    void interruptSession(sessionKey);
  };

  useEscapeHandler(
    () => {
      if (getDraft(sessionKey) !== '' || !online) return false;
      stop();
      return true;
    },
    working,
    { scopeRef: rootRef },
  );

  const changeText = (next: string, nextCaret?: number) => {
    if (getDraft(sessionKey) === '' && next !== '') {
      // The draft begins: fix its Enter target (an explicit choice for the same decision stays).
      let lock: DecisionId | null = null;
      if (
        target !== null &&
        (lockedId === target.id || (target.requester.kind === 'main' && isArmed(target)))
      ) {
        lock = target.id;
      }
      setLockedId(lock);
    } else if (next === '') {
      setLockedId(null);
    }
    if (nextCaret !== undefined) {
      pendingCaretRef.current = nextCaret;
      setCaret(nextCaret);
    }
    setSlashError(null);
    setTerminalHint(null);
    setDraft(sessionKey, next);
    reportTyping();
  };

  const restoreDraft = (previous: string, lock: DecisionId | null) => {
    if (getDraft(sessionKey) !== '') return;
    setDraft(sessionKey, previous);
    setLockedId(lock);
  };

  /** Images that keep a prompt from going out now (busy, failed, together too large – ADR-125). */
  const attachmentsHold = (): boolean => {
    const current = getAttachments(sessionKey);
    return current.some((a) => a.status !== 'done') || attachmentsOverTotal(current).size > 0;
  };

  /** Sends text (+ the finished images) as a prompt; restores both when it fails. */
  const sendMessage = (message: string, priority: PromptPriority): Promise<boolean> => {
    const ready = getAttachments(sessionKey).filter((a) => a.status === 'done');
    if (
      !online ||
      attachmentsHold() ||
      (message === '' && ready.length === 0) ||
      message.length > LIMITS.promptChars
    ) {
      return Promise.resolve(false);
    }
    const previous = getDraft(sessionKey).trim();
    clearDraft(sessionKey);
    setLockedId(null);
    // V2-06: the own message (and Claude's answer) must appear in view, even when scrolled up.
    followTranscript(sessionKey);
    const taken = takeAttachments(sessionKey);
    const blobIds = ready.flatMap((a) => (a.ref === null ? [] : [a.ref.blobId]));
    if (priority === 'now') {
      // "Send now" cancels the main agent's open decisions (WP-13 §3.4).
      markLocalResolution(
        decisions.filter((d) => d.state === 'open' && d.requester.kind === 'main').map((d) => d.id),
      );
    }
    setSending((count) => count + 1);
    return sendPrompt(sessionKey, message, priority, blobIds).then((ok) => {
      setSending((count) => count - 1);
      if (ok) {
        releaseAttachments(taken);
      } else {
        restoreDraft(previous, null);
        restoreAttachments(sessionKey, taken);
      }
      return ok;
    });
  };

  const openPicker = (section: ModelPickerSection) => {
    pickerFromSlashRef.current = true;
    setPicker({ open: true, section });
  };

  /** Runs a command Parallax handles itself; the draft goes only when it worked (WP-37 §2). */
  const runNative = (command: NativeCommand, args: string) => {
    if (entryId === null) return;
    const before = getDraft(sessionKey);
    const context: NativeContext = {
      sessionKey,
      entryId,
      models,
      modelSetting,
      fastMode,
      permissionMode,
      openPicker,
      openHelp: () => {
        setHelpOpen(true);
      },
      sendText: (message) => sendMessage(message, 'next'),
    };
    setSlashError(null);
    setTerminalHint(null);
    setSending((count) => count + 1);
    void runNativeCommand(context, command, args).then((result) => {
      setSending((count) => count - 1);
      if (result.ok) {
        if (getDraft(sessionKey) === before) {
          clearDraft(sessionKey);
          setLockedId(null);
        }
        return;
      }
      if (result.error !== null) setSlashError(result.error);
    });
  };

  const submit = (via: Via) => {
    const message = getDraft(sessionKey).trim();
    let answer: Decision | null = null;
    if (via === 'primary' && target !== null && lockedId === target.id) answer = target;
    if (via === 'answer') {
      if (target === null || !isArmed(target)) return;
      answer = target;
    }
    if (!online) return;
    if (answer !== null) {
      if (message === '' || message.length > textLimit(answer)) return;
      const decision = answer;
      clearDraft(sessionKey);
      setLockedId(null);
      followTranscript(sessionKey);
      setSending((count) => count + 1);
      void respondToDecision(sessionKey, decision, answerFromText(decision, message)).then((ok) => {
        setSending((count) => count - 1);
        if (!ok) restoreDraft(message, decision.id);
      });
      return;
    }
    const priority: PromptPriority = via === 'now' ? 'now' : 'next';
    const action = message.startsWith('/') ? classifySlash(message, entries, terminal) : null;
    if (action?.kind === 'native') {
      // `/plan text` waits for the images like a message – no mode switch with the text left behind.
      if (sendsPrompt(action) && attachmentsHold()) return;
      runNative(action.command, action.args);
      return;
    }
    if (action?.kind === 'terminal') {
      setSlashError(null);
      setTerminalHint(action.name);
      return;
    }
    void sendMessage(action?.kind === 'pass' ? action.text : message, priority);
  };

  /** Tab/Enter/click in the menu: native commands without argument run, others are inserted. */
  const pickEntry = (entry: MenuEntry) => {
    if (entry.native !== null && NATIVE_WITHOUT_ARGUMENT.has(entry.native)) {
      runNative(entry.native, '');
      return;
    }
    const next = applyMenuEntry(getDraft(sessionKey), entry.name);
    changeText(next.text, next.caret);
    textareaRef.current?.focus();
  };

  const openExternal = () => {
    if (entryId === null) return;
    const before = getDraft(sessionKey);
    setExternalPending(true);
    sendCommand(sessionKey, { name: 'session.openExternal', entryId })
      .then(() => {
        setTerminalHint(null);
        if (getDraft(sessionKey) === before) clearDraft(sessionKey);
      })
      .catch((caught: unknown) => {
        showErrorNotice(errorPayloadOf(caught), { sessionKey, id: `composer.external.${sessionKey}` });
      })
      .finally(() => {
        setExternalPending(false);
      });
  };

  const attachFiles = (files: readonly File[]) => {
    if (!canAttach || files.length === 0) return;
    const result = addAttachmentFiles(sessionKey, files);
    if (result.notImages > 0) {
      showTextNotice('composer.attachments.onlyImages', undefined, {
        sessionKey,
        tone: 'warning',
        id: `composer.attach.${sessionKey}`,
      });
    }
    if (result.overLimit > 0) {
      showTextNotice(
        'composer.attachments.tooMany',
        { max: LIMITS.attachmentsMax },
        { sessionKey, tone: 'warning', id: `composer.attach-limit.${sessionKey}` },
      );
    }
  };

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    if (!canAttach) return;
    const files = clipboardFiles(event.clipboardData);
    // Text wins: Word or Excel put a picture of the copied text next to it on the clipboard.
    if (files.length === 0 || event.clipboardData.getData('text/plain') !== '') return;
    event.preventDefault();
    attachFiles(files);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    const modified = event.shiftKey || event.ctrlKey || event.altKey || event.metaKey;
    if (menuOpen) {
      if (event.key === 'Escape') {
        // Closes only the menu (the Stop shortcut sees the handled event).
        event.preventDefault();
        setMenuDismissed(true);
        return;
      }
      if ((event.key === 'Tab' || event.key === 'Enter') && !modified && activeEntry !== null) {
        event.preventDefault();
        pickEntry(activeEntry);
        return;
      }
      if (event.key !== 'Enter') {
        const handled = handleCommandKey(event, {
          count: matches.length,
          activeIndex,
          onActiveIndexChange: setActiveIndex,
          onSelectActive: () => undefined,
        });
        if (handled) return;
      }
    }
    if (event.key === 'Tab' && !modified && suggestion !== null) {
      event.preventDefault();
      changeText(suggestion, suggestion.length);
      return;
    }
    if (event.key !== 'Enter' || modified) return;
    event.preventDefault();
    submit('primary');
  };

  const updateCaret = (field: HTMLTextAreaElement) => {
    setCaret(field.selectionStart);
  };

  let placeholder: string;
  if (answerTarget !== null) placeholder = t(`composer.placeholder.${targetKind(answerTarget)}`);
  else if (suggestion !== null) placeholder = suggestion;
  else placeholder = working ? t('composer.placeholder.working') : t('composer.placeholder.idle');

  const answerLabel = (decision: Decision) =>
    decision.kind === 'plan' ? t('composer.answerPlan') : t('composer.answer');
  let sendLabel: string;
  if (answerTarget !== null) sendLabel = answerLabel(answerTarget);
  else if (commandDraft) sendLabel = t('composer.run');
  else sendLabel = working ? t('composer.queue') : t('composer.send');

  let mode: string;
  if (answerTarget !== null) mode = `answer-${answerTarget.kind}`;
  else if (pendingTarget !== null) mode = `pending-${pendingTarget.kind}`;
  else mode = working ? 'queue' : 'idle';

  const inputId = `composer-${sessionKey}`;
  const hintId = `${inputId}-hint`;
  const menuId = slashMenuId(inputId);
  const menuHintId = `${inputId}-menu-hint`;
  const suggestionId = `${inputId}-suggestion`;
  const argumentId = `${inputId}-argument`;
  const imagesHintId = `${inputId}-images-later`;
  const hintTarget = answerTarget ?? pendingTarget;
  // An answer carries no images (contract): the chips stay for the next message (R4W-26).
  const imagesWaitForMessage = answerTarget !== null && attachments.length > 0;
  const describedBy = [
    hintTarget === null ? null : hintId,
    imagesWaitForMessage ? imagesHintId : null,
    menuOpen ? menuHintId : null,
    suggestion === null ? null : suggestionId,
    argumentHint === '' ? null : argumentId,
  ].filter((id): id is string => id !== null);

  return (
    <div
      ref={rootRef}
      data-slot="composer"
      data-shortcut-scope="composer"
      data-mode={mode}
      className="relative border-t px-3 pt-2 pb-2"
      onDragEnter={(event) => {
        if (!canAttach || !hasFiles(event)) return;
        event.preventDefault();
        setDragging(true);
      }}
      onDragOver={(event) => {
        if (!canAttach || !hasFiles(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
        setDragging(true);
      }}
      onDragLeave={(event) => {
        const related = event.relatedTarget;
        if (related instanceof Node && rootRef.current?.contains(related) === true) return;
        setDragging(false);
      }}
      onDrop={(event) => {
        if (!canAttach || !hasFiles(event)) return;
        event.preventDefault();
        setDragging(false);
        attachFiles(Array.from(event.dataTransfer.files));
      }}
    >
      <RateLimitBanner sessionKey={sessionKey} />
      {hintTarget === null ? null : (
        <p
          id={hintId}
          data-slot={answerTarget === null ? 'composer-pending' : 'composer-target'}
          className={cn(
            'mb-1 flex items-start gap-1.5 text-2xs',
            answerTarget === null ? 'text-status-waiting' : 'text-muted-foreground',
          )}
        >
          {answerTarget === null ? (
            <CircleDotIcon aria-hidden className="mt-px size-3 shrink-0" />
          ) : (
            <CornerDownRightIcon aria-hidden className="mt-px size-3 shrink-0" />
          )}
          {decisionHint(hintTarget, answerTarget === null ? 'pending' : 'target', t)}
        </p>
      )}
      {imagesWaitForMessage ? (
        <p
          id={imagesHintId}
          data-slot="composer-images-later"
          className="text-muted-foreground mb-1 flex items-start gap-1.5 text-2xs"
        >
          <ImageIcon aria-hidden className="mt-px size-3 shrink-0" />
          {t('composer.attachments.notWithAnswer')}
        </p>
      ) : null}
      {terminalHint === null ? null : (
        <Alert
          tone="warning"
          data-slot="terminal-hint"
          className="mb-1.5"
          title={t('composer.slash.terminal.title', { command: terminalHint })}
          actions={
            <>
              <Button
                size="sm"
                variant="outline"
                disabled={!online || externalPending}
                onClick={openExternal}
              >
                {externalPending ? <Spinner className="size-3" /> : <TerminalIcon aria-hidden />}
                {t('composer.slash.terminal.open')}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setTerminalHint(null);
                  textareaRef.current?.focus();
                }}
              >
                {t('composer.slash.terminal.dismiss')}
              </Button>
            </>
          }
        >
          {t('composer.slash.terminal.description')}
        </Alert>
      )}
      <AttachmentChips
        sessionKey={sessionKey}
        onFocusField={() => {
          textareaRef.current?.focus();
        }}
      />
      <div className="relative">
        {menuOpen ? (
          <SlashMenu
            id={menuId}
            entries={matches}
            activeIndex={menuIndex}
            onActiveIndexChange={setActiveIndex}
            onSelect={pickEntry}
          />
        ) : null}
        <Textarea
          id={inputId}
          ref={textareaRef}
          value={text}
          aria-label={t('composer.label')}
          aria-describedby={describedBy.length === 0 ? undefined : describedBy.join(' ')}
          aria-invalid={tooLong}
          aria-haspopup="listbox"
          aria-autocomplete="list"
          aria-controls={menuOpen ? menuId : undefined}
          aria-activedescendant={menuOpen ? commandOptionId(menuId, menuIndex) : undefined}
          placeholder={placeholder}
          rows={1}
          className={cn('max-h-60 min-h-9 resize-none', suggestion !== null && 'pr-12')}
          onChange={(event) => {
            changeText(event.target.value);
            updateCaret(event.target);
          }}
          onSelect={(event) => {
            updateCaret(event.currentTarget);
          }}
          onKeyUp={(event) => {
            updateCaret(event.currentTarget);
          }}
          onClick={(event) => {
            updateCaret(event.currentTarget);
          }}
          onBlur={() => {
            setMenuDismissed(true);
          }}
          onFocus={() => {
            setMenuDismissed(false);
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
        />
        {argumentHint === '' ? null : (
          <div
            aria-hidden
            data-slot="argument-hint"
            className="text-ui pointer-events-none absolute inset-0 overflow-hidden rounded-md border border-transparent px-2 py-1.5 break-words whitespace-pre-wrap"
          >
            <span className="invisible">{text}</span>
            <span className="text-muted-foreground/80">{argumentHint}</span>
          </div>
        )}
        {suggestion === null ? null : (
          <Kbd aria-hidden className="absolute top-1.5 right-2">
            {t('common.keys.tab')}
          </Kbd>
        )}
        {dragging ? (
          <div
            aria-hidden
            data-slot="drop-target"
            className="border-ring bg-background/85 text-muted-foreground pointer-events-none absolute inset-0 flex items-center justify-center gap-1.5 rounded-md border-2 border-dashed text-xs"
          >
            <ImagePlusIcon className="size-4" />
            {t('composer.attachments.drop')}
          </div>
        ) : null}
      </div>
      <span id={menuHintId} className="sr-only">
        {menuOpen ? t('composer.slash.menuHint') : null}
      </span>
      {suggestion === null ? null : (
        <span id={suggestionId} className="sr-only">
          {t('composer.suggestion.hint')}
        </span>
      )}
      {argumentHint === '' ? null : (
        <span id={argumentId} className="sr-only">
          {t('composer.slash.argumentHint', { hint: argumentHint })}
        </span>
      )}
      {tooLong ? (
        <p role="alert" className="text-destructive mt-1 text-2xs">
          {t('composer.tooLong', { max: limit })}
        </p>
      ) : null}
      {slashError === null ? null : (
        <p role="alert" data-slot="slash-error" className="text-destructive mt-1 text-2xs">
          {t(slashError.key, slashError.params)}
        </p>
      )}
      <div className="mt-1.5 flex flex-wrap items-center gap-1">
        <div
          role="group"
          aria-label={t('composer.toolbar')}
          className="flex min-w-0 flex-wrap items-center gap-0.5"
        >
          {canAttach ? (
            <>
              <IconButton
                label={t('composer.attachments.add')}
                data-action="attach"
                onClick={() => {
                  fileInputRef.current?.click();
                }}
              >
                <PaperclipIcon aria-hidden />
              </IconButton>
              <input
                ref={fileInputRef}
                // V3-12: a form field needs an id or a name (DevTools issue), even a hidden one.
                id={`${inputId}-files`}
                type="file"
                accept={ATTACHMENT_MEDIA_TYPES.join(',')}
                multiple
                hidden
                tabIndex={-1}
                aria-hidden
                data-slot="attach-input"
                onChange={(event) => {
                  attachFiles(Array.from(event.target.files ?? []));
                  event.target.value = '';
                }}
              />
            </>
          ) : null}
          <ModePicker sessionKey={sessionKey} />
          <ModelPicker
            sessionKey={sessionKey}
            open={picker.open}
            section={picker.section}
            onOpenChange={(open) => {
              setPicker(open ? { open, section: picker.open ? picker.section : 'all' } : PICKER_CLOSED);
            }}
            onCloseAutoFocus={(event) => {
              if (!pickerFromSlashRef.current) return;
              pickerFromSlashRef.current = false;
              event.preventDefault();
              textareaRef.current?.focus();
            }}
          />
          <ContextGauge sessionKey={sessionKey} />
        </div>
        {/* One right-aligned group: when the footer wraps (narrow window, V2-11) the send buttons
            stay on the right instead of starting the second line on the left. */}
        <div className="ml-auto flex flex-wrap items-center justify-end gap-1">
          {online ? null : <span className="text-warning text-2xs">{t('composer.notConnected')}</span>}
          {busyUploads ? (
            <span data-slot="composer-uploads" className="text-muted-foreground text-2xs">
              {t('composer.attachments.pending')}
            </span>
          ) : failedUploads ? (
            <span data-slot="composer-uploads" className="text-destructive text-2xs">
              {t('composer.attachments.removeFailed')}
            </span>
          ) : overTotal.size > 0 ? (
            <span data-slot="composer-uploads" className="text-destructive text-2xs">
              {t('composer.attachments.removeTooLarge')}
            </span>
          ) : null}
          {value.length > limit * COUNTER_FROM ? (
            <span
              data-slot="composer-counter"
              className={cn('text-2xs tabular-nums', tooLong ? 'text-destructive' : 'text-muted-foreground')}
            >
              {t('composer.counter', { count: value.length, max: limit })}
            </span>
          ) : null}
          {/* Left of the send buttons: appearing while the user types never moves them (R2W-01). */}
          {pendingTarget === null ? null : (
            <Button
              variant="outline"
              size="sm"
              data-action="answer"
              disabled={!canAnswer}
              onClick={() => {
                submit('answer');
              }}
            >
              <ReplyIcon aria-hidden />
              {answerLabel(pendingTarget)}
            </Button>
          )}
          {working ? (
            <Button
              variant="outline"
              size="sm"
              data-action="stop"
              title={t('composer.stopHint')}
              disabled={!online}
              onClick={stop}
            >
              <SquareIcon aria-hidden className="fill-current" />
              {t('composer.stop')}
            </Button>
          ) : null}
          {working && answerTarget === null && !commandDraft ? (
            <Button
              variant="outline"
              size="sm"
              data-action="send-now"
              title={t('composer.sendNowHint')}
              disabled={!canSend}
              onClick={() => {
                submit('now');
              }}
            >
              <ZapIcon aria-hidden />
              {t('composer.sendNow')}
            </Button>
          ) : null}
          <span className="inline-flex items-center gap-px">
            <Button
              size="sm"
              data-action="send"
              disabled={!canSend}
              className={cn(answerTarget !== null && 'rounded-r-none')}
              onClick={() => {
                submit('primary');
              }}
            >
              {sending > 0 ? <Spinner className="size-3" /> : <SendHorizontalIcon aria-hidden />}
              {sendLabel}
            </Button>
            {answerTarget === null ? null : (
              <DropdownMenu modal={false}>
                <DropdownMenuTrigger asChild>
                  <Button
                    size="icon-sm"
                    aria-label={t('composer.moreSend')}
                    title={t('composer.moreSend')}
                    disabled={!canSend}
                    className="rounded-l-none"
                  >
                    <ChevronDownIcon aria-hidden />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    onSelect={() => {
                      submit('message');
                    }}
                  >
                    {t('composer.sendAsMessage')}
                  </DropdownMenuItem>
                  {working ? (
                    <DropdownMenuItem
                      onSelect={() => {
                        submit('now');
                      }}
                    >
                      {t('composer.sendNow')}
                    </DropdownMenuItem>
                  ) : null}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </span>
        </div>
      </div>
      <HelpDialog
        open={helpOpen}
        onOpenChange={setHelpOpen}
        entries={entries}
        terminal={[...terminal].sort()}
        hasCatalog={commands !== null}
        returnFocus={() => {
          textareaRef.current?.focus();
        }}
      />
    </div>
  );
});
