import {
  CircleCheckIcon,
  CircleDashedIcon,
  GlobeIcon,
  ListTodoIcon,
  LoaderCircleIcon,
  MessageCircleQuestionMarkIcon,
} from 'lucide-react';
import { useT } from '@web/i18n';
import { cn } from '@web/lib/cn';
import { firstLine } from '../lib/text';
import {
  readQuestionInput,
  readQuestionResult,
  readTodoInput,
  readWebFetchInput,
  readWebSearchInput,
} from '../lib/tool-input';
import { GenericToolBody } from './generic';
import { ToolResultText } from './parts';
import type { ToolBodyProps, ToolRenderer } from './types';

/** Smaller renderers: AskUserQuestion, TodoWrite, WebFetch, WebSearch. */

// ---- AskUserQuestion (F.5): questions with the chosen answer (live `answers`, else the result text) ----

function QuestionBody({ item, sessionKey }: ToolBodyProps) {
  const t = useT();
  const input = readQuestionInput(item.input);
  if (input === null) return <GenericToolBody item={item} sessionKey={sessionKey} />;
  const result = readQuestionResult(item.result?.structured ?? null);
  return (
    <>
      <ul className="grid gap-2">
        {input.questions.map((question, index) => {
          const answer = result?.answers?.[question.question] ?? null;
          const notes = result?.annotations?.[question.question]?.notes ?? null;
          return (
            <li key={index} className="grid gap-0.5">
              <span className="font-medium">{question.question}</span>
              <span className={cn('text-xs', answer === null && 'text-muted-foreground italic')}>
                {answer === null
                  ? t('transcript.question.noAnswer')
                  : t('transcript.question.answer', { answer })}
              </span>
              {notes === null || notes === '' ? null : (
                <span className="text-muted-foreground text-xs">
                  {t('transcript.question.notes', { notes })}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      {result?.answers === undefined ? <ToolResultText item={item} sessionKey={sessionKey} /> : null}
    </>
  );
}

export const questionRenderer: ToolRenderer = {
  icon: MessageCircleQuestionMarkIcon,
  summary: (item) => {
    const first = readQuestionInput(item.input)?.questions[0];
    if (first === undefined) return null;
    return firstLine(first.header !== undefined && first.header !== '' ? first.header : first.question, 120);
  },
  Body: QuestionBody,
};

// ---- TodoWrite: checklist ----

const TODO_ICON = {
  completed: CircleCheckIcon,
  in_progress: LoaderCircleIcon,
  pending: CircleDashedIcon,
} as const;

function isTodoStatus(status: string): status is keyof typeof TODO_ICON {
  return Object.hasOwn(TODO_ICON, status);
}

function TodoBody({ item, sessionKey }: ToolBodyProps) {
  const t = useT();
  const input = readTodoInput(item.input);
  if (input === null) return <GenericToolBody item={item} sessionKey={sessionKey} />;
  return (
    <ul className="grid gap-1">
      {input.todos.map((todo, index) => {
        const known = isTodoStatus(todo.status) ? todo.status : 'pending';
        const Icon = TODO_ICON[known];
        return (
          <li key={index} className="flex items-start gap-1.5 text-xs">
            <Icon
              aria-hidden
              className={cn(
                'mt-0.5 size-3.5 shrink-0',
                known === 'completed'
                  ? 'text-success'
                  : known === 'in_progress'
                    ? 'text-info'
                    : 'text-muted-foreground',
              )}
            />
            <span className="sr-only">{t(`transcript.todo.status.${known}`)}</span>
            <span className={cn(known === 'completed' && 'text-muted-foreground line-through')}>
              {known === 'in_progress' ? (todo.activeForm ?? todo.content) : todo.content}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

export const todoRenderer: ToolRenderer = {
  icon: ListTodoIcon,
  summary: (item, t) => {
    const todos = readTodoInput(item.input)?.todos;
    if (todos === undefined) return null;
    const done = todos.filter((todo) => todo.status === 'completed').length;
    return t('transcript.todo.progress', { done, total: todos.length });
  },
  Body: TodoBody,
  defaultOpen: () => true,
};

// ---- WebFetch / WebSearch: URL or query in the line, generic details ----

export const webFetchRenderer: ToolRenderer = {
  icon: GlobeIcon,
  summary: (item) => readWebFetchInput(item.input)?.url ?? null,
  Body: GenericToolBody,
};

export const webSearchRenderer: ToolRenderer = {
  icon: GlobeIcon,
  summary: (item) => readWebSearchInput(item.input)?.query ?? null,
  Body: GenericToolBody,
};
