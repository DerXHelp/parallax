import { useState, type ReactNode } from 'react';
import { LIMITS } from '@shared/common';
import type { QuestionDecision, QuestionResponse } from '@shared/model';
import { useT } from '@web/i18n';
import { useFeatureSlots } from '@web/shell/slots';
import { Badge } from '@web/ui/badge';
import { Checkbox } from '@web/ui/checkbox';
import { Input } from '@web/ui/input';
import { Label } from '@web/ui/label';
import { RadioGroup, RadioGroupItem } from '@web/ui/radio-group';
import { respondToDecision } from '../lib/respond';
import { DecisionAction, DecisionCardShell, useCardDisabled } from './card-shell';

type Question = QuestionDecision['questions'][number];

/** Value of the "Other" radio item (never an option label: labels are compared exactly). */
const OTHER = '\u0000other';

export interface QuestionDraft {
  selected: readonly string[];
  /** "Other" chosen (single select) or ticked (multi select). */
  other: boolean;
  otherText: string;
  notes: string;
}

const EMPTY_DRAFT: QuestionDraft = { selected: [], other: false, otherText: '', notes: '' };

function isAnswered(draft: QuestionDraft): boolean {
  return draft.selected.length > 0 || (draft.other && draft.otherText.trim() !== '');
}

/**
 * Answer format of the contract (F.5, `questionResponseSchema`): key = question text, `selected`
 * ⊆ option labels (multi-select: several, the server joins them), "Other" as `otherText`, notes
 * as `notes` (→ annotations). One answer per question, in question order.
 */
export function buildQuestionAnswer(
  questions: readonly Question[],
  drafts: readonly QuestionDraft[],
): QuestionResponse | null {
  const answers = questions.map((question, index) => {
    const draft = drafts[index] ?? EMPTY_DRAFT;
    const otherText = draft.other ? draft.otherText.trim() : '';
    const notes = draft.notes.trim();
    return {
      question: question.question,
      selected: [...draft.selected],
      otherText: otherText === '' ? null : otherText,
      notes: notes === '' ? null : notes,
    };
  });
  if (!drafts.every(isAnswered) || drafts.length < questions.length) return null;
  return { behavior: 'answer', answers };
}

function OptionText({ label, description }: { label: string; description: string }) {
  return (
    <span className="grid min-w-0 gap-0.5">
      <span>{label}</span>
      {description === '' ? null : <span className="text-muted-foreground text-2xs">{description}</span>}
    </span>
  );
}

function QuestionBlock({
  sessionKey,
  decisionId,
  index,
  question,
  draft,
  onChange,
}: {
  sessionKey: string;
  decisionId: string;
  index: number;
  question: Question;
  draft: QuestionDraft;
  onChange: (draft: QuestionDraft) => void;
}) {
  const t = useT();
  const { Markdown } = useFeatureSlots();
  const disabled = useCardDisabled();
  const base = `q-${decisionId}-${String(index)}`;
  const previewOption = question.options.find(
    (option) => option.preview !== null && draft.selected.includes(option.label),
  );

  const otherInput = (
    <Input
      aria-label={t('decisions.question.otherOption')}
      placeholder={t('decisions.question.otherPlaceholder')}
      value={draft.otherText}
      maxLength={LIMITS.answerChars}
      disabled={disabled}
      className="h-7 max-w-80"
      onChange={(event) => {
        // Typing into "Other" chooses it; in a single-select question that drops the option chosen
        // before (one answer only, R2W-02), like picking the "Other" radio.
        const selected = question.multiSelect ? draft.selected : [];
        onChange({ ...draft, selected, other: true, otherText: event.target.value });
      }}
    />
  );

  let options: ReactNode;
  if (question.multiSelect) {
    options = (
      <div role="group" aria-labelledby={`${base}-q`} className="grid gap-1.5">
        {question.options.map((option, optionIndex) => {
          const id = `${base}-o${String(optionIndex)}`;
          const checked = draft.selected.includes(option.label);
          return (
            <div key={option.label} className="flex items-start gap-2">
              <Checkbox
                id={id}
                checked={checked}
                disabled={disabled}
                className="mt-0.5"
                onCheckedChange={(value) => {
                  const selected =
                    value === true
                      ? [...draft.selected, option.label]
                      : draft.selected.filter((label) => label !== option.label);
                  onChange({ ...draft, selected });
                }}
              />
              <Label htmlFor={id} className="font-normal">
                <OptionText label={option.label} description={option.description} />
              </Label>
            </div>
          );
        })}
        <div className="flex flex-wrap items-center gap-2">
          <Checkbox
            id={`${base}-other`}
            checked={draft.other}
            disabled={disabled}
            onCheckedChange={(value) => {
              onChange({ ...draft, other: value === true });
            }}
          />
          <Label htmlFor={`${base}-other`} className="font-normal">
            {t('decisions.question.otherOption')}
          </Label>
          {otherInput}
        </div>
      </div>
    );
  } else {
    const value = draft.other ? OTHER : (draft.selected[0] ?? '');
    options = (
      <RadioGroup
        aria-labelledby={`${base}-q`}
        value={value}
        disabled={disabled}
        className="gap-1.5"
        onValueChange={(next) => {
          if (next === OTHER) onChange({ ...draft, selected: [], other: true });
          else onChange({ ...draft, selected: [next], other: false });
        }}
      >
        {question.options.map((option, optionIndex) => {
          const id = `${base}-o${String(optionIndex)}`;
          return (
            <div key={option.label} className="flex items-start gap-2">
              <RadioGroupItem id={id} value={option.label} className="mt-0.5" />
              <Label htmlFor={id} className="font-normal">
                <OptionText label={option.label} description={option.description} />
              </Label>
            </div>
          );
        })}
        <div className="flex flex-wrap items-center gap-2">
          <RadioGroupItem id={`${base}-other`} value={OTHER} />
          <Label htmlFor={`${base}-other`} className="font-normal">
            {t('decisions.question.otherOption')}
          </Label>
          {otherInput}
        </div>
      </RadioGroup>
    );
  }

  return (
    <fieldset data-slot="question" className="grid gap-1.5 border-t py-2 first:border-t-0 first:pt-1">
      <legend id={`${base}-q`} className="flex flex-wrap items-center gap-1.5 pb-1">
        {question.header === '' ? null : <Badge variant="outline">{question.header}</Badge>}
        <span className="font-medium">{question.question}</span>
        {question.multiSelect ? (
          <span className="text-muted-foreground text-2xs">{t('decisions.question.multiSelect')}</span>
        ) : null}
      </legend>
      {options}
      {previewOption === undefined || previewOption.preview === null ? null : (
        <div data-slot="option-preview" className="bg-muted/40 rounded-md border px-2 py-1">
          <div className="text-muted-foreground pb-1 text-2xs">
            {t('decisions.question.preview', { label: previewOption.label })}
          </div>
          <div className="max-h-48 overflow-auto">
            <Markdown text={previewOption.preview} sessionKey={sessionKey} />
          </div>
        </div>
      )}
      <Input
        aria-label={t('decisions.question.notes')}
        placeholder={t('decisions.question.notesPlaceholder')}
        value={draft.notes}
        maxLength={LIMITS.answerChars}
        disabled={disabled}
        className="h-7"
        onChange={(event) => {
          onChange({ ...draft, notes: event.target.value });
        }}
      />
    </fieldset>
  );
}

/**
 * Question card (AskUserQuestion, F.5): options with description and Markdown preview (slot
 * `Markdown`), "Other" free text, notes, multi-select when the input asks for it. "Answer" needs an
 * answer for every question; "Skip" declines.
 */
export function QuestionCard({
  sessionKey,
  decision,
  headerExtra,
}: {
  sessionKey: string;
  decision: QuestionDecision;
  headerExtra?: ReactNode;
}) {
  const t = useT();
  const [drafts, setDrafts] = useState<QuestionDraft[]>(() => decision.questions.map(() => EMPTY_DRAFT));
  const response = buildQuestionAnswer(decision.questions, drafts);
  const answer =
    response === null ? null : () => respondToDecision(sessionKey, decision, { kind: 'question', response });
  const decline = () =>
    respondToDecision(sessionKey, decision, {
      kind: 'question',
      response: { behavior: 'decline', message: '' },
    });
  const count = decision.questions.length;

  return (
    <DecisionCardShell
      sessionKey={sessionKey}
      decision={decision}
      title={t('decisions.question.title', { count })}
      headerExtra={headerExtra}
      primary={answer}
      actions={
        <>
          <DecisionAction
            data-action="answer"
            disabled={answer === null}
            onAnswer={answer ?? (() => Promise.resolve(false))}
          >
            {t('decisions.question.answer')}
          </DecisionAction>
          <DecisionAction variant="outline" data-action="decline" onAnswer={decline}>
            {t('decisions.question.decline')}
          </DecisionAction>
          {answer === null ? (
            <span className="text-muted-foreground text-2xs">{t('decisions.question.incomplete')}</span>
          ) : null}
        </>
      }
    >
      {decision.questions.map((question, index) => (
        <QuestionBlock
          key={question.question}
          sessionKey={sessionKey}
          decisionId={decision.id}
          index={index}
          question={question}
          draft={drafts[index] ?? EMPTY_DRAFT}
          onChange={(draft) => {
            setDrafts((current) => current.map((entry, i) => (i === index ? draft : entry)));
          }}
        />
      ))}
    </DecisionCardShell>
  );
}
