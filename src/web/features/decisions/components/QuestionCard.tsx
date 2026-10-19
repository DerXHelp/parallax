import { ArrowRightIcon, CheckIcon, CircleIcon } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { LIMITS } from '@shared/common';
import type { QuestionDecision, QuestionResponse } from '@shared/model';
import { useT } from '@web/i18n';
import { useFeatureSlots } from '@web/shell/slots';
import { Badge } from '@web/ui/badge';
import { Button } from '@web/ui/button';
import { Checkbox } from '@web/ui/checkbox';
import { Input } from '@web/ui/input';
import { Label } from '@web/ui/label';
import { RadioGroup, RadioGroupItem } from '@web/ui/radio-group';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@web/ui/tabs';
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
  inTab,
  onChange,
}: {
  sessionKey: string;
  decisionId: string;
  index: number;
  question: Question;
  draft: QuestionDraft;
  /** Shown in a tab: the tab carries the header, the legend only the question. */
  inTab: boolean;
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
      id={`${base}-other-text`}
      name={`${base}-other-text`}
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
        {inTab || question.header === '' ? null : <Badge variant="outline">{question.header}</Badge>}
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
        id={`${base}-notes`}
        name={`${base}-notes`}
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
 * answer for every question; "Skip" declines. Several questions are tabs (one question at a time,
 * the header as the tab name, a tick once answered, "Next question"); the drafts of all questions
 * live here, so switching tabs keeps them. Tabs and "Next question" never answer (card-shell:
 * Mod+Enter on another button of the card does nothing).
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
  const [active, setActive] = useState(0);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  /** Set by "Next question": the new tab takes the focus (the pressed button is gone with its tab). */
  const focusActiveTab = useRef(false);

  useEffect(() => {
    if (!focusActiveTab.current) return;
    focusActiveTab.current = false;
    tabRefs.current[active]?.focus();
  }, [active]);

  const block = (question: Question, index: number, inTab: boolean) => (
    <QuestionBlock
      key={question.question}
      sessionKey={sessionKey}
      decisionId={decision.id}
      index={index}
      question={question}
      draft={drafts[index] ?? EMPTY_DRAFT}
      inTab={inTab}
      onChange={(draft) => {
        setDrafts((current) => current.map((entry, i) => (i === index ? draft : entry)));
      }}
    />
  );

  const body =
    count < 2 ? (
      decision.questions.map((question, index) => block(question, index, false))
    ) : (
      <Tabs
        data-slot="question-tabs"
        value={String(active)}
        onValueChange={(value) => {
          setActive(Number(value));
        }}
        className="gap-1 pt-1"
      >
        <TabsList aria-label={t('decisions.question.tabs')}>
          {decision.questions.map((question, index) => {
            const answered = isAnswered(drafts[index] ?? EMPTY_DRAFT);
            const label =
              question.header === '' ? t('decisions.question.tab', { number: index + 1 }) : question.header;
            return (
              <TabsTrigger
                key={question.question}
                ref={(element) => {
                  tabRefs.current[index] = element;
                }}
                value={String(index)}
                data-answered={answered ? 'true' : 'false'}
                aria-label={t(answered ? 'decisions.question.tabAnswered' : 'decisions.question.tabOpen', {
                  label,
                })}
              >
                {answered ? (
                  <CheckIcon aria-hidden className="text-success" />
                ) : (
                  <CircleIcon aria-hidden className="size-2.5" />
                )}
                {label}
              </TabsTrigger>
            );
          })}
        </TabsList>
        {decision.questions.map((question, index) => (
          <TabsContent key={question.question} value={String(index)}>
            {block(question, index, true)}
            {index < count - 1 ? (
              <Button
                variant="ghost"
                size="sm"
                data-slot="question-next"
                onClick={() => {
                  focusActiveTab.current = true;
                  setActive(index + 1);
                }}
              >
                {t('decisions.question.next')}
                <ArrowRightIcon aria-hidden />
              </Button>
            ) : null}
          </TabsContent>
        ))}
      </Tabs>
    );

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
      {body}
    </DecisionCardShell>
  );
}
