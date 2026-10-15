import { Fragment, memo, useMemo } from 'react';
import { cn } from '@web/lib/cn';
import { PLAIN_STYLE, parseAnsi, type AnsiColor, type AnsiStyle } from '../lib/ansi';

/** ANSI colors → design tokens (no raw colors, index.css). */
const FOREGROUND: Readonly<Record<AnsiColor, string>> = {
  black: 'text-muted-foreground',
  red: 'text-destructive',
  green: 'text-success',
  yellow: 'text-warning',
  blue: 'text-info',
  magenta: 'text-profile-violet',
  cyan: 'text-profile-teal',
  white: 'text-foreground',
};

const BACKGROUND: Readonly<Record<AnsiColor, string>> = {
  black: 'bg-foreground/15',
  red: 'bg-destructive/20',
  green: 'bg-success/20',
  yellow: 'bg-warning/20',
  blue: 'bg-info/20',
  magenta: 'bg-profile-violet/20',
  cyan: 'bg-profile-teal/20',
  white: 'bg-foreground/10',
};

function styleClass(style: AnsiStyle): string {
  return cn(
    style.fg !== null && FOREGROUND[style.fg],
    style.bg !== null && BACKGROUND[style.bg],
    style.bold && 'font-semibold',
    style.dim && 'opacity-70',
    style.italic && 'italic',
    style.underline && 'underline',
  );
}

/** Terminal text with ANSI colors; escape sequences never reach the DOM (React text nodes only). */
export const AnsiText = memo(function AnsiText({ text }: { text: string }) {
  const segments = useMemo(() => parseAnsi(text), [text]);
  return segments.map((segment, index) =>
    segment.style === PLAIN_STYLE ? (
      <Fragment key={index}>{segment.text}</Fragment>
    ) : (
      <span key={index} className={styleClass(segment.style)}>
        {segment.text}
      </span>
    ),
  );
});
