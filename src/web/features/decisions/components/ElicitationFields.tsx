import type { ReactNode } from 'react';
import type { ElicitationField } from '@shared/model';
import { useT } from '@web/i18n';
import { Checkbox } from '@web/ui/checkbox';
import { Input } from '@web/ui/input';
import { Label } from '@web/ui/label';
import { RadioGroup, RadioGroupItem } from '@web/ui/radio-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@web/ui/select';
import { Textarea } from '@web/ui/textarea';
import {
  elicitationControl,
  elicitationHints,
  maxLengthOf,
  type ElicitationControl,
  type ElicitationDraft,
  type ElicitationDraftValue,
  type ElicitationIssue,
} from '../lib/elicitation';

/** Value of an optional enum's "Not specified" choice (enum choices are their index). */
const NONE = 'none';

const INPUT_TYPE: Partial<Record<ElicitationControl, string>> = {
  text: 'text',
  email: 'email',
  url: 'url',
  date: 'date',
  datetime: 'datetime-local',
  number: 'text',
};

export interface ElicitationFieldsProps {
  /** Prefix of the control ids (unique per card). */
  idBase: string;
  fields: readonly ElicitationField[];
  draft: ElicitationDraft;
  /** The issue shown at a field (null = none yet). */
  issueOf: (key: string) => ElicitationIssue | null;
  onChange: (key: string, value: ElicitationDraftValue) => void;
  /** The field lost the focus; `badInput` = a native date input holds text it cannot parse. */
  onBlur: (key: string, badInput: boolean) => void;
}

/**
 * The form of an elicitation (WP-116): one control per field in schema order – text (one line, or
 * multi-line for long/unbounded strings: Enter adds a line, it never sends), email/url/date/
 * date-time inputs, numbers as text (decimal keyboard, checked by the card), a checkbox, radio
 * buttons or a select for enums (optional ones with "Not specified"). Labels, required marks,
 * descriptions, hints and the error are tied to the control (`aria-describedby`, `aria-invalid`).
 * No `<form>`: Enter in a field submits nothing; answers only come from the card's buttons or
 * Mod+Enter (card-shell).
 */
export function ElicitationFields({
  idBase,
  fields,
  draft,
  issueOf,
  onChange,
  onBlur,
}: ElicitationFieldsProps) {
  const t = useT();
  const anyRequired = fields.some((field) => field.required && field.type !== 'boolean');
  return (
    <div
      role="group"
      data-slot="elicitation-form"
      aria-label={t('decisions.elicitation.formLabel')}
      className="grid gap-2.5 pt-2"
    >
      {fields.map((field, index) => (
        <FieldRow
          // Keys come from the server and are unique; the index keeps odd keys out of the DOM ids.
          key={field.key}
          id={`${idBase}-f${String(index)}`}
          index={index}
          field={field}
          value={draft.get(field.key)}
          issue={issueOf(field.key)}
          onChange={(value) => {
            onChange(field.key, value);
          }}
          onBlur={(badInput) => {
            onBlur(field.key, badInput);
          }}
        />
      ))}
      {anyRequired ? (
        <p className="text-muted-foreground text-2xs">{t('decisions.elicitation.requiredHint')}</p>
      ) : null}
    </div>
  );
}

interface FieldRowProps {
  id: string;
  index: number;
  field: ElicitationField;
  value: ElicitationDraftValue | undefined;
  issue: ElicitationIssue | null;
  onChange: (value: ElicitationDraftValue) => void;
  onBlur: (badInput: boolean) => void;
}

function RequiredMark({ field }: { field: ElicitationField }) {
  const t = useT();
  if (!field.required || field.type === 'boolean') return null;
  return (
    <span aria-hidden className="text-destructive">
      {t('decisions.elicitation.requiredMark')}
    </span>
  );
}

function FieldRow({ id, index, field, value, issue, onChange, onBlur }: FieldRowProps) {
  const t = useT();
  const control = elicitationControl(field);
  const label = field.title ?? field.key;
  const text = typeof value === 'string' ? value : '';
  const hints = elicitationHints(field)
    .map((hint) => t(hint.key, hint.params))
    .join(' · ');
  const descriptionId = `${id}-description`;
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy =
    [
      field.description === null ? null : descriptionId,
      hints === '' ? null : hintId,
      issue === null ? null : errorId,
    ]
      .filter((part) => part !== null)
      .join(' ') || undefined;
  const aria = {
    'aria-describedby': describedBy,
    'aria-invalid': issue === null ? undefined : true,
    'aria-required': field.required && field.type !== 'boolean' ? true : undefined,
  };

  let body: ReactNode;
  switch (control) {
    case 'checkbox':
      body = (
        <div className="flex items-center gap-2">
          <Checkbox
            id={id}
            checked={value === true}
            onCheckedChange={(checked) => {
              onChange(checked === true);
            }}
            onBlur={() => {
              onBlur(false);
            }}
            {...aria}
          />
          <Label htmlFor={id} className="font-normal">
            {label}
          </Label>
        </div>
      );
      break;
    case 'radio': {
      const labelId = `${id}-label`;
      body = (
        <>
          <span id={labelId} className="flex items-center gap-1 text-xs font-medium">
            {label}
            <RequiredMark field={field} />
          </span>
          <RadioGroup
            id={id}
            aria-labelledby={labelId}
            required={field.required}
            value={text === '' && !field.required ? NONE : text}
            className="gap-1.5"
            onValueChange={(next) => {
              onChange(next === NONE ? '' : next);
            }}
            onBlur={(event) => {
              // Moving between the options is no blur of the field.
              if (
                !(event.relatedTarget instanceof Node) ||
                !event.currentTarget.contains(event.relatedTarget)
              ) {
                onBlur(false);
              }
            }}
            {...aria}
          >
            {(field.enumValues ?? []).map((enumValue, optionIndex) => {
              const optionId = `${id}-o${String(optionIndex)}`;
              return (
                // Enum values may repeat or be '': the index is the choice (and the key).
                <div key={optionIndex} className="flex items-center gap-2">
                  <RadioGroupItem id={optionId} value={String(optionIndex)} />
                  <Label htmlFor={optionId} className="font-normal">
                    {field.enumNames?.[optionIndex] ?? enumValue}
                  </Label>
                </div>
              );
            })}
            {field.required ? null : (
              <div className="flex items-center gap-2">
                <RadioGroupItem id={`${id}-none`} value={NONE} />
                <Label htmlFor={`${id}-none`} className="text-muted-foreground font-normal">
                  {t('decisions.elicitation.none')}
                </Label>
              </div>
            )}
          </RadioGroup>
        </>
      );
      break;
    }
    case 'select':
      body = (
        <>
          <Label htmlFor={id}>
            {label}
            <RequiredMark field={field} />
          </Label>
          <Select
            value={text === '' && !field.required ? NONE : text}
            onValueChange={(next) => {
              onChange(next === NONE ? '' : next);
            }}
          >
            <SelectTrigger
              id={id}
              className="w-full max-w-80"
              onBlur={() => {
                onBlur(false);
              }}
              {...aria}
            >
              <SelectValue placeholder={t('decisions.elicitation.choose')} />
            </SelectTrigger>
            <SelectContent>
              {field.required ? null : (
                <SelectItem value={NONE}>{t('decisions.elicitation.none')}</SelectItem>
              )}
              {(field.enumValues ?? []).map((enumValue, optionIndex) => (
                <SelectItem key={optionIndex} value={String(optionIndex)}>
                  {field.enumNames?.[optionIndex] ?? enumValue}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </>
      );
      break;
    case 'multiline':
      body = (
        <>
          <Label htmlFor={id}>
            {label}
            <RequiredMark field={field} />
          </Label>
          <Textarea
            id={id}
            rows={1}
            value={text}
            maxLength={maxLengthOf(field)}
            className="max-h-32 min-h-7 py-1"
            onChange={(event) => {
              onChange(event.target.value);
            }}
            onBlur={() => {
              onBlur(false);
            }}
            {...aria}
          />
        </>
      );
      break;
    default:
      body = (
        <>
          <Label htmlFor={id}>
            {label}
            <RequiredMark field={field} />
          </Label>
          <Input
            id={id}
            type={INPUT_TYPE[control] ?? 'text'}
            inputMode={control === 'number' ? (field.type === 'integer' ? 'numeric' : 'decimal') : undefined}
            value={text}
            maxLength={field.type === 'string' ? maxLengthOf(field) : undefined}
            placeholder={placeholderOf(control, t)}
            className="h-7 max-w-96"
            onChange={(event) => {
              onChange(event.target.value);
            }}
            onBlur={(event) => {
              onBlur(event.currentTarget.validity.badInput);
            }}
            {...aria}
          />
        </>
      );
  }

  return (
    <div data-slot="elicitation-field" data-field-index={index} data-control={control} className="grid gap-1">
      {body}
      {field.description === null ? null : (
        <p id={descriptionId} className="text-muted-foreground text-2xs break-words">
          {field.description}
        </p>
      )}
      {hints === '' ? null : (
        <p id={hintId} className="text-muted-foreground text-2xs">
          {hints}
        </p>
      )}
      {issue === null ? null : (
        <p id={errorId} data-slot="elicitation-error" className="text-destructive text-2xs">
          {t(`decisions.elicitation.errors.${issue.code}`, issue.params)}
        </p>
      )}
    </div>
  );
}

function placeholderOf(control: ElicitationControl, t: ReturnType<typeof useT>): string | undefined {
  if (control === 'email') return t('decisions.elicitation.placeholders.email');
  if (control === 'url') return t('decisions.elicitation.placeholders.uri');
  return undefined;
}
