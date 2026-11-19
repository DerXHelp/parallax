import {
  ChevronDownIcon,
  ChevronUpIcon,
  MessageSquareIcon,
  MessageSquarePlusIcon,
  PencilIcon,
  StrikethroughIcon,
  Trash2Icon,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { LIMITS } from '@shared/common';
import type { PlanAnnotation, PlanAnnotationKind } from '@shared/model';
import { useT } from '@web/i18n';
import { cn } from '@web/lib/cn';
import { newAnnotationId } from '@web/lib/ids';
import { splitPlanBlocks, type PlanBlock } from '@web/lib/plan-blocks';
import { sortAnnotations } from '@web/lib/plan-feedback';
import { findQuote, quoteAt, rangeOfSpan, spanOfRange, type TextQuote } from '@web/lib/text-anchor';
import { isEditable } from '@web/shell/shortcuts';
import { useFeatureSlots } from '@web/shell/slots';
import { Button } from '@web/ui/button';
import { Kbd } from '@web/ui/kbd';
import { Textarea } from '@web/ui/textarea';
import { setHighlights, supportsHighlights, type HighlightRanges } from '../lib/highlights';

/**
 * WP-93 (ADR-234): a plan version with annotations. The plan is rendered block by block
 * (`splitPlanBlocks`, list items on their own); selecting text in a block offers "Comment" (key C)
 * and "Strike", the + at a block's left edge comments on the whole block. Annotations stand right
 * below their block and are marked in the text (Custom Highlight API, lib/highlights.ts). A bar on
 * top counts them, jumps between them and carries `actions` (the plan tab's "Keep planning").
 * `onChange` null = read-only (an answered version: what was sent).
 */

interface Draft extends TextQuote {
  /** The annotation being edited; null = a new one. */
  id: string | null;
  kind: PlanAnnotationKind;
  block: number;
  text: string;
}

interface Selected extends TextQuote {
  block: number;
  /** Position of the selection toolbar inside the annotator (px). */
  top: number;
  left: number;
}

const TOOLBAR_WIDTH = 240;

/** The editor holds text the user would lose: a new comment with text, or a changed comment. */
function isDirty(draft: Draft, annotations: readonly PlanAnnotation[]): boolean {
  const text = draft.text.trim();
  if (draft.id === null) return text !== '';
  const saved = annotations.find((annotation) => annotation.id === draft.id)?.comment.trim() ?? '';
  return text !== saved;
}

function blockRoot(container: HTMLElement, block: number): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[data-plan-text="${String(block)}"]`);
}

function rangeOf(container: HTMLElement, anchor: TextQuote & { block: number }): Range | null {
  if (anchor.quote === '') return null;
  const root = blockRoot(container, anchor.block);
  if (root === null) return null;
  const span = findQuote(root.textContent, anchor);
  return span === null ? null : rangeOfSpan(root, span);
}

/** The current selection as a quote in one block of `container` (clipped to the block it starts in). */
function readSelection(container: HTMLElement): Selected | null {
  const selection = window.getSelection();
  if (selection === null || selection.isCollapsed || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  const start = range.startContainer;
  const element = start instanceof Element ? start : start.parentElement;
  const root = element?.closest<HTMLElement>('[data-plan-text]') ?? null;
  if (root === null || !container.contains(root)) return null;
  const block = Number(root.dataset.planText);
  const span = spanOfRange(root, range);
  if (!Number.isInteger(block) || span === null) return null;
  const text = root.textContent;
  let { start: from, end: to } = span;
  while (from < to && /\s/.test(text[from] ?? '')) from += 1;
  while (to > from && /\s/.test(text[to - 1] ?? '')) to -= 1;
  if (to <= from) return null;
  to = Math.min(to, from + LIMITS.planAnnotationQuoteChars);
  const rect = range.getBoundingClientRect();
  const box = container.getBoundingClientRect();
  const left = Math.max(0, Math.min(rect.left - box.left, box.width - TOOLBAR_WIDTH));
  return { block, ...quoteAt(text, { start: from, end: to }), top: rect.bottom - box.top + 6, left };
}

function blockSpacing(blocks: readonly PlanBlock[], index: number): string {
  if (index === 0) return '';
  const block = blocks[index];
  if (block?.kind === 'heading') return 'mt-4';
  if (block?.kind === 'item' && blocks[index - 1]?.kind === 'item') return 'mt-0.5';
  return 'mt-2';
}

function AnnotationEditor({
  draft,
  onText,
  onSave,
  onCancel,
}: {
  draft: Draft;
  onText: (text: string) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  const canSave = draft.kind === 'strike' || draft.text.trim() !== '';
  const onKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    } else if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      if (canSave) onSave();
    }
  };
  return (
    <div data-slot="plan-annotation-editor" className="bg-muted/40 mt-1.5 grid gap-1.5 rounded-md border p-2">
      {draft.quote === '' ? null : (
        <p className="text-muted-foreground line-clamp-2 border-l-2 pl-2 text-xs italic">{draft.quote}</p>
      )}
      <Textarea
        autoFocus
        value={draft.text}
        maxLength={LIMITS.planAnnotationChars}
        aria-label={t('decisions.annotations.editorLabel')}
        placeholder={
          draft.kind === 'strike'
            ? t('decisions.annotations.reasonPlaceholder')
            : t('decisions.annotations.placeholder')
        }
        className="max-h-48 min-h-10 bg-background"
        onChange={(event) => {
          onText(event.target.value);
        }}
        onKeyDown={onKeyDown}
      />
      <div className="flex justify-end gap-1.5">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          {t('decisions.annotations.cancel')}
        </Button>
        <Button size="sm" data-action="save-annotation" disabled={!canSave} onClick={onSave}>
          {t('decisions.annotations.save')}
        </Button>
      </div>
    </div>
  );
}

function AnnotationNote({
  annotation,
  active,
  editable,
  onActivate,
  onEdit,
  onRemove,
}: {
  annotation: PlanAnnotation;
  active: boolean;
  editable: boolean;
  onActivate: () => void;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const t = useT();
  const strike = annotation.kind === 'strike';
  const comment = annotation.comment.trim();
  return (
    <div
      data-slot="plan-annotation"
      data-annotation-id={annotation.id}
      data-kind={annotation.kind}
      data-active={active ? 'true' : undefined}
      className={cn(
        'group/note mt-1.5 flex gap-2 rounded-md border px-2 py-1.5 text-xs transition-colors',
        strike ? 'border-destructive/30 bg-destructive/5' : 'border-warning/40 bg-warning/10',
        active && 'ring-ring ring-2',
      )}
      onClick={onActivate}
    >
      {strike ? (
        <StrikethroughIcon aria-hidden className="text-destructive mt-0.5 size-3.5 shrink-0" />
      ) : (
        <MessageSquareIcon aria-hidden className="text-warning mt-0.5 size-3.5 shrink-0" />
      )}
      <div className="grid min-w-0 flex-1 gap-0.5">
        <p className="text-muted-foreground line-clamp-1 italic">
          {annotation.quote === '' ? t('decisions.annotations.wholeBlock') : annotation.quote}
        </p>
        {strike ? <p className="font-medium">{t('decisions.annotations.struck')}</p> : null}
        {comment === '' ? null : <p className="break-words whitespace-pre-wrap">{comment}</p>}
      </div>
      {editable ? (
        <div className="flex shrink-0 items-start gap-0.5 opacity-60 group-hover/note:opacity-100 focus-within:opacity-100">
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            aria-label={t('decisions.annotations.edit')}
            title={t('decisions.annotations.edit')}
            onClick={(event) => {
              event.stopPropagation();
              onEdit();
            }}
          >
            <PencilIcon aria-hidden className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            data-action="remove-annotation"
            aria-label={t('decisions.annotations.remove')}
            title={t('decisions.annotations.remove')}
            onClick={(event) => {
              event.stopPropagation();
              onRemove();
            }}
          >
            <Trash2Icon aria-hidden className="size-3.5" />
          </Button>
        </div>
      ) : null}
    </div>
  );
}

export interface PlanAnnotatorProps {
  sessionKey: string;
  text: string;
  annotations: readonly PlanAnnotation[];
  /** null = read-only. */
  onChange: ((next: readonly PlanAnnotation[]) => void) | null;
  /** Right side of the bar (the plan tab's "Keep planning"). */
  actions?: ReactNode;
  /** Shown in the bar when there are no annotations (editable: how to make one). */
  emptyHint?: ReactNode;
  /** The bar sticks to the top of the scrolling panel. */
  stickyBar?: boolean;
}

export function PlanAnnotator({
  sessionKey,
  text,
  annotations,
  onChange,
  actions,
  emptyHint,
  stickyBar = false,
}: PlanAnnotatorProps) {
  const t = useT();
  const { Markdown } = useFeatureSlots();
  const owner = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  const blocks = useMemo(() => splitPlanBlocks(text), [text]);
  const sorted = useMemo(() => sortAnnotations(text, annotations, blocks), [annotations, blocks, text]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [selected, setSelected] = useState<Selected | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const editable = onChange !== null;
  const full = annotations.length >= LIMITS.planAnnotations;

  // Marks in the text: every annotation, the active one and the passage of an open draft.
  const draftBlock = draft?.block ?? null;
  const draftQuote = draft?.quote ?? '';
  const draftPrefix = draft?.prefix ?? '';
  const draftSuffix = draft?.suffix ?? '';
  useEffect(() => {
    const container = containerRef.current;
    if (container === null || !supportsHighlights()) return undefined;
    const anchor =
      draftBlock === null
        ? null
        : { block: draftBlock, quote: draftQuote, prefix: draftPrefix, suffix: draftSuffix };
    let frame = 0;
    const draw = () => {
      frame = 0;
      const ranges: { [K in keyof HighlightRanges]: Range[] } = {
        'plan-annotation': [],
        'plan-strike': [],
        'plan-annotation-active': [],
      };
      for (const annotation of annotations) {
        const range = rangeOf(container, annotation);
        if (range === null) continue;
        ranges[annotation.kind === 'strike' ? 'plan-strike' : 'plan-annotation'].push(range);
        if (annotation.id === active) ranges['plan-annotation-active'].push(range);
      }
      const pending = anchor === null ? null : rangeOf(container, anchor);
      if (pending !== null) ranges['plan-annotation-active'].push(pending);
      setHighlights(owner, ranges);
    };
    draw();
    // The Markdown of a block renders lazily: draw again when the text arrives.
    const observer = new MutationObserver(() => {
      if (frame === 0) frame = requestAnimationFrame(draw);
    });
    observer.observe(container, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      if (frame !== 0) cancelAnimationFrame(frame);
      setHighlights(owner, null);
    };
  }, [active, annotations, draftBlock, draftPrefix, draftQuote, draftSuffix, owner]);

  // The selection toolbar follows the user's selection inside the plan.
  useEffect(() => {
    const container = containerRef.current;
    if (!editable || container === null) return undefined;
    const update = () => {
      setSelected(readSelection(container));
    };
    const onPointerUp = () => {
      requestAnimationFrame(update);
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.shiftKey || event.key.startsWith('Arrow')) update();
    };
    // A selection that collapsed or moved elsewhere (the transcript, the composer) hides the toolbar.
    // Its start counts, like `readSelection` (a triple click on the last block ends past the plan).
    const onSelectionChange = () => {
      const selection = window.getSelection();
      const range = selection === null || selection.rangeCount === 0 ? null : selection.getRangeAt(0);
      if (range === null || range.collapsed || !container.contains(range.startContainer)) setSelected(null);
    };
    container.addEventListener('pointerup', onPointerUp);
    container.addEventListener('keyup', onKeyUp);
    document.addEventListener('selectionchange', onSelectionChange);
    return () => {
      container.removeEventListener('pointerup', onPointerUp);
      container.removeEventListener('keyup', onKeyUp);
      document.removeEventListener('selectionchange', onSelectionChange);
    };
  }, [editable]);

  // An open editor with unsaved text is never replaced: the focus goes back to it instead.
  const openDraft = useCallback(
    (next: Draft): boolean => {
      if (draft !== null && isDirty(draft, annotations)) {
        containerRef.current
          ?.querySelector<HTMLTextAreaElement>('[data-slot="plan-annotation-editor"] textarea')
          ?.focus();
        return false;
      }
      setDraft(next);
      return true;
    },
    [annotations, draft],
  );

  const create = useCallback(
    (kind: PlanAnnotationKind, anchor: TextQuote & { block: number }) => {
      if (onChange === null || full) return;
      if (kind === 'comment' && !openDraft({ id: null, kind, ...anchor, text: '' })) return;
      window.getSelection()?.removeAllRanges();
      setSelected(null);
      if (kind === 'strike') {
        const annotation: PlanAnnotation = {
          id: newAnnotationId(),
          kind,
          block: anchor.block,
          quote: anchor.quote,
          prefix: anchor.prefix,
          suffix: anchor.suffix,
          comment: '',
          createdAt: new Date().toISOString(),
        };
        onChange([...annotations, annotation]);
        setActive(annotation.id);
      }
    },
    [annotations, full, onChange, openDraft],
  );

  // Key C comments on the selection (not while typing; Ctrl+C stays "copy").
  useEffect(() => {
    if (selected === null) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || event.repeat) return;
      if (event.key.toLowerCase() !== 'c') return;
      if (isEditable(event.target instanceof Element ? event.target : null)) return;
      event.preventDefault();
      create('comment', selected);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [create, selected]);

  const saveDraft = () => {
    if (draft === null || onChange === null) return;
    const comment = draft.text.trim();
    if (draft.kind === 'comment' && comment === '') return;
    if (draft.id === null) {
      const annotation: PlanAnnotation = {
        id: newAnnotationId(),
        kind: draft.kind,
        block: draft.block,
        quote: draft.quote,
        prefix: draft.prefix,
        suffix: draft.suffix,
        comment,
        createdAt: new Date().toISOString(),
      };
      onChange([...annotations, annotation]);
      setActive(annotation.id);
    } else {
      const id = draft.id;
      onChange(
        annotations.map((annotation) => (annotation.id === id ? { ...annotation, comment } : annotation)),
      );
    }
    setDraft(null);
  };

  const remove = (id: string) => {
    if (onChange === null) return;
    onChange(annotations.filter((annotation) => annotation.id !== id));
    if (active === id) setActive(null);
    if (draft?.id === id) setDraft(null);
  };

  const jump = (step: 1 | -1) => {
    if (sorted.length === 0) return;
    const index = sorted.findIndex((annotation) => annotation.id === active);
    const next =
      index < 0 ? (step === 1 ? 0 : sorted.length - 1) : (index + step + sorted.length) % sorted.length;
    const target = sorted[next];
    if (target === undefined) return;
    setActive(target.id);
    containerRef.current
      ?.querySelector(`[data-annotation-id="${target.id}"]`)
      ?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  };

  const byBlock = new Map<number, PlanAnnotation[]>();
  for (const annotation of sorted) {
    const list = byBlock.get(annotation.block) ?? [];
    list.push(annotation);
    byBlock.set(annotation.block, list);
  }
  // Annotations whose block no longer exists (never expected: a version's text is fixed).
  const orphans = sorted.filter((annotation) => annotation.block >= blocks.length);
  const count = annotations.length;
  const showBar = count > 0 || emptyHint !== undefined || actions !== undefined;

  return (
    <div data-slot="plan-annotator" data-annotations={count} className="relative">
      {showBar ? (
        <div
          data-slot="plan-annotation-bar"
          className={cn(
            'mb-3 flex min-h-8 flex-wrap items-center gap-x-2 gap-y-1 border-b pb-2',
            stickyBar && 'bg-background/95 sticky top-0 z-10 -mx-4 -mt-3 px-4 pt-2 backdrop-blur',
          )}
        >
          {count > 0 ? (
            <>
              <span className="text-xs font-medium" data-slot="plan-annotation-count">
                {t('decisions.annotations.count', { count })}
              </span>
              <span className="inline-flex">
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-6"
                  aria-label={t('decisions.annotations.previous')}
                  title={t('decisions.annotations.previous')}
                  onClick={() => {
                    jump(-1);
                  }}
                >
                  <ChevronUpIcon aria-hidden />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-6"
                  aria-label={t('decisions.annotations.next')}
                  title={t('decisions.annotations.next')}
                  onClick={() => {
                    jump(1);
                  }}
                >
                  <ChevronDownIcon aria-hidden />
                </Button>
              </span>
            </>
          ) : (
            <span className="text-muted-foreground min-w-0 flex-1 text-xs">{emptyHint}</span>
          )}
          {count > 0 ? <span className="flex-1" /> : null}
          {actions}
        </div>
      ) : null}
      <div ref={containerRef} className="relative">
        {blocks.map((block, index) => {
          const notes = byBlock.get(index) ?? [];
          const struck = notes.some((note) => note.kind === 'strike' && note.quote === '');
          const marked = notes.some((note) => note.quote === '');
          return (
            <div
              key={index}
              data-plan-block={index}
              className={cn('group/block relative pl-6', blockSpacing(blocks, index))}
            >
              {editable ? (
                <Button
                  variant="ghost"
                  size="icon"
                  className="text-muted-foreground absolute top-0 left-0 size-5 opacity-0 group-hover/block:opacity-100 focus-visible:opacity-100"
                  data-action="annotate-block"
                  aria-label={t('decisions.annotations.addBlock')}
                  title={
                    full
                      ? t('decisions.annotations.full', { max: LIMITS.planAnnotations })
                      : t('decisions.annotations.addBlock')
                  }
                  disabled={full}
                  onClick={() => {
                    create('comment', { block: index, quote: '', prefix: '', suffix: '' });
                  }}
                >
                  <MessageSquarePlusIcon aria-hidden className="size-3.5" />
                </Button>
              ) : null}
              <div
                data-plan-text={index}
                className={cn(
                  marked && '-ml-2 border-l-2 pl-1.5',
                  marked && (struck ? 'border-destructive/60' : 'border-warning/70'),
                  struck && 'text-muted-foreground decoration-destructive line-through',
                )}
              >
                <Markdown text={block.text} sessionKey={sessionKey} />
              </div>
              {notes.map((annotation) =>
                draft?.id === annotation.id ? (
                  <AnnotationEditor
                    key={annotation.id}
                    draft={draft}
                    onText={(value) => {
                      setDraft({ ...draft, text: value });
                    }}
                    onSave={saveDraft}
                    onCancel={() => {
                      setDraft(null);
                    }}
                  />
                ) : (
                  <AnnotationNote
                    key={annotation.id}
                    annotation={annotation}
                    active={annotation.id === active}
                    editable={editable}
                    onActivate={() => {
                      setActive(annotation.id);
                    }}
                    onEdit={() => {
                      openDraft({ ...annotation, text: annotation.comment });
                    }}
                    onRemove={() => {
                      remove(annotation.id);
                    }}
                  />
                ),
              )}
              {draft !== null && draft.id === null && draft.block === index ? (
                <AnnotationEditor
                  draft={draft}
                  onText={(value) => {
                    setDraft({ ...draft, text: value });
                  }}
                  onSave={saveDraft}
                  onCancel={() => {
                    setDraft(null);
                  }}
                />
              ) : null}
            </div>
          );
        })}
        {orphans.map((annotation) => (
          <AnnotationNote
            key={annotation.id}
            annotation={annotation}
            active={annotation.id === active}
            editable={editable}
            onActivate={() => {
              setActive(annotation.id);
            }}
            onEdit={() => {
              openDraft({ ...annotation, text: annotation.comment });
            }}
            onRemove={() => {
              remove(annotation.id);
            }}
          />
        ))}
        {editable && selected !== null && draft === null ? (
          <div
            role="toolbar"
            aria-label={t('decisions.annotations.comment')}
            data-slot="plan-selection-toolbar"
            className="bg-popover text-popover-foreground absolute z-20 flex items-center gap-0.5 rounded-md border p-0.5 shadow-md"
            style={{ top: selected.top, left: selected.left }}
            onPointerDown={(event) => {
              // Keep the selection while clicking a button.
              event.preventDefault();
            }}
          >
            <Button
              variant="ghost"
              size="sm"
              data-action="comment-selection"
              disabled={full}
              title={full ? t('decisions.annotations.full', { max: LIMITS.planAnnotations }) : undefined}
              onClick={() => {
                create('comment', selected);
              }}
            >
              <MessageSquarePlusIcon aria-hidden />
              {t('decisions.annotations.comment')}
              <Kbd>{t('decisions.annotations.commentKey')}</Kbd>
            </Button>
            <Button
              variant="ghost"
              size="sm"
              data-action="strike-selection"
              disabled={full}
              onClick={() => {
                create('strike', selected);
              }}
            >
              <StrikethroughIcon aria-hidden />
              {t('decisions.annotations.strike')}
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
