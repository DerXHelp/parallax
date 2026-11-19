import type { PlanAnnotation } from '@shared/model';
import type { TranslationKey, TranslationParams } from '@web/i18n';
import { clipText, plainInline } from './plain-text';
import { splitPlanBlocks, type PlanBlock } from './plan-blocks';

/**
 * WP-93 (ADR-234): the feedback of "Keep planning" from the annotations of a plan version plus the
 * composer text ("General"). Claude gets it as the deny message of ExitPlanMode – it does not read
 * the plan file again, so every entry says where it belongs (headings, lines) and quotes the marked
 * text. Entries in plan order. Texts come from `common.planFeedback` (the user's language). Pure.
 * The annotation part (`planFeedbackSection`) is built once per annotation list; the composer text
 * is joined per keystroke (`joinPlanFeedback`).
 */

type Translate = (key: TranslationKey, params?: TranslationParams) => string;

/** Longest quote in the feedback (longer ones end in "…"). */
export const FEEDBACK_QUOTE_CHARS = 300;

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** The first line of a block without its Markdown marks (a whole-block annotation quotes it). */
function blockLead(block: PlanBlock): string {
  const first = block.text.split('\n').find((line) => line.trim() !== '') ?? '';
  return plainInline(first.replace(/^\s*(?:#{1,6}\s+|[-*+]\s+(?:\[[ xX]\]\s+)?|\d{1,9}[.)]\s+|>\s?)/, ''));
}

/**
 * The plan line of the quote: the first source line of the block that contains its beginning
 * (Markdown marks removed); null when none does (the block's lines are named then).
 */
function quoteLine(block: PlanBlock, quote: string): number | null {
  const head = oneLine(quote).slice(0, 24);
  if (head === '') return null;
  const index = block.text.split('\n').findIndex((line) => oneLine(plainInline(line)).includes(head));
  return index < 0 ? null : block.startLine + index;
}

/** Plan order: block, then where the quote stands in it, then creation time. */
export function sortAnnotations(
  plan: string,
  annotations: readonly PlanAnnotation[],
  blocks: readonly PlanBlock[] = splitPlanBlocks(plan),
): PlanAnnotation[] {
  const plainBlocks = new Map<number, string>();
  const plainOf = (block: number) => {
    let text = plainBlocks.get(block);
    if (text === undefined) {
      text = oneLine(plainInline(blocks[block]?.text ?? ''));
      plainBlocks.set(block, text);
    }
    return text;
  };
  const keyed = annotations.map((annotation) => {
    let position = -1;
    if (annotation.quote !== '') {
      const at = plainOf(annotation.block).indexOf(oneLine(annotation.quote));
      position = at < 0 ? Number.MAX_SAFE_INTEGER : at;
    }
    return { annotation, position, time: Date.parse(annotation.createdAt) };
  });
  keyed.sort((a, b) => a.annotation.block - b.annotation.block || a.position - b.position || a.time - b.time);
  return keyed.map((entry) => entry.annotation);
}

/** Plan lines of an annotation: the quote's line, else the lines of its block; null without block. */
export function annotationLines(
  blocks: readonly PlanBlock[],
  annotation: PlanAnnotation,
): { from: number; to: number } | null {
  const block = blocks[annotation.block];
  if (block === undefined) return null;
  const line = annotation.quote === '' ? null : quoteLine(block, annotation.quote);
  return line === null ? { from: block.startLine, to: block.endLine } : { from: line, to: line };
}

function location(blocks: readonly PlanBlock[], annotation: PlanAnnotation, t: Translate): string | null {
  const block = blocks[annotation.block];
  const lines = annotationLines(blocks, annotation);
  if (block === undefined || lines === null) return null;
  const parts: string[] = [];
  if (block.path.length > 0) parts.push(t('common.planFeedback.section', { path: block.path.join(' › ') }));
  parts.push(
    lines.to > lines.from
      ? t('common.planFeedback.lines', { from: lines.from, to: lines.to })
      : t('common.planFeedback.line', { line: lines.from }),
  );
  return parts.join(', ');
}

/** The comment lines of one annotation (a strike says so, with its reason). */
function commentOf(annotation: PlanAnnotation, t: Translate): string {
  const comment = annotation.comment.trim();
  if (annotation.kind === 'strike') {
    return comment === ''
      ? t('common.planFeedback.strike')
      : t('common.planFeedback.strikeReason', { reason: comment });
  }
  return comment;
}

function indent(text: string, prefix: string): string {
  return text
    .split('\n')
    .map((line) => (line === '' ? prefix.trimEnd() : `${prefix}${line}`))
    .join('\n');
}

/** The annotation part of the feedback: an intro and the numbered entries; '' without annotations. */
export function planFeedbackSection(plan: string, annotations: readonly PlanAnnotation[], t: Translate): string {
  if (annotations.length === 0) return '';
  const blocks = splitPlanBlocks(plan);
  const entries = sortAnnotations(plan, annotations, blocks).map((annotation, index) => {
    const block = blocks[annotation.block];
    const head = `${String(index + 1)}. ${location(blocks, annotation, t) ?? ''}`.trimEnd();
    const quoted = annotation.quote === '' ? (block === undefined ? '' : blockLead(block)) : annotation.quote;
    const lines = [head];
    if (quoted.trim() !== '') lines.push(`   > ${clipText(oneLine(quoted), FEEDBACK_QUOTE_CHARS)}`);
    lines.push(indent(commentOf(annotation, t), '   '));
    return lines.join('\n');
  });
  return [t('common.planFeedback.intro', { count: annotations.length }), ...entries].join('\n\n');
}

/**
 * Characters the annotation part adds around a non-empty general text (0 without annotations):
 * the section, a blank line, the "General:" label and its line break (`joinPlanFeedback`).
 */
export function feedbackOverhead(section: string, t: Translate): number {
  return section === '' ? 0 : section.length + t('common.planFeedback.general').length + 3;
}

/** The feedback text from the annotation part and the general text; '' when both are empty. */
export function joinPlanFeedback(section: string, general: string, t: Translate): string {
  const rest = general.trim();
  if (section === '') return rest;
  return rest === '' ? section : `${section}\n\n${t('common.planFeedback.general')}\n${rest}`;
}

/**
 * The feedback text: an intro, the numbered annotations (location, quote, comment) and the general
 * part; only the general part when there are no annotations. '' when both are empty.
 */
export function buildPlanFeedback(
  plan: string,
  annotations: readonly PlanAnnotation[],
  general: string,
  t: Translate,
): string {
  return joinPlanFeedback(planFeedbackSection(plan, annotations, t), general, t);
}
