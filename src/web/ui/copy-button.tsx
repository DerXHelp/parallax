import { CheckIcon, CopyIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { copyText } from '@web/lib/clipboard';
import { IconButton } from './icon-button';

const COPIED_MS = 1500;

export interface CopyButtonProps {
  text: string;
  /** Accessible name and tooltip (the caller translates it, like ui/lightbox). */
  label: string;
  /** After every attempt: the caller shows its notice ("copied" / "copy failed"). */
  onCopied?: (ok: boolean) => void;
  className?: string;
}

/** Copies `text` to the clipboard (lib/clipboard); the icon confirms success for a moment. */
export function CopyButton({ text, label, onCopied, className }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  const copy = () => {
    void copyText(text).then((ok) => {
      onCopied?.(ok);
      if (!ok) return;
      setCopied(true);
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        setCopied(false);
      }, COPIED_MS);
    });
  };

  return (
    <IconButton label={label} size="icon-xs" className={className} onClick={copy}>
      {copied ? <CheckIcon aria-hidden className="text-success" /> : <CopyIcon aria-hidden />}
    </IconButton>
  );
}
