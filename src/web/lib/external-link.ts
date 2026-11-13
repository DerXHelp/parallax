import { isHttpUrl } from '@shared/model';

/**
 * WP-65 §1.6b: external http(s) links open in the user's DEFAULT browser – Parallax's Chrome app
 * profile is signed in nowhere (claude.ai asks for the login). The one way for every external link
 * (Markdown links and images in the transcript, "Open in the Claude app"): a plain click goes to
 * the host command `link.open` (the server starts the default browser); copying, middle click and
 * clicks with a modifier keep the browser's own behaviour (`href`). When the host cannot open it
 * (no connection, `OPEN_FAILED` …) the link opens here as before (`window.open`, without opener and
 * referrer) and a short hint says why.
 *
 * Pure apart from the opener the shell installs (`configureExternalLinks`, ShellEffects): lib/
 * never talks to the server itself. Without an installed opener (tests, before the shell mounted)
 * links open here, without a hint.
 */
export interface ExternalLinkOpener {
  /** Asks the host to open the URL (rejects when it cannot). */
  open(url: string): Promise<void>;
  /** The link opened in this window instead: show the hint. */
  fellBack(): void;
}

let opener: ExternalLinkOpener | null = null;

/** Installs the opener; the returned function removes it again (effect cleanup). */
export function configureExternalLinks(next: ExternalLinkOpener): () => void {
  opener = next;
  return () => {
    if (opener === next) opener = null;
  };
}

function openHere(url: string): void {
  window.open(url, '_blank', 'noopener,noreferrer');
}

/** Opens an http(s) URL in the default browser (fallback: here). Anything else is ignored (false). */
export function openExternalLink(url: string): boolean {
  if (!isHttpUrl(url)) return false;
  const current = opener;
  if (current === null) {
    openHere(url);
    return true;
  }
  current.open(url).catch(() => {
    openHere(url);
    current.fellBack();
  });
  return true;
}

/** The fields of a (React) mouse event the click handler reads. */
export interface LinkClick {
  button: number;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  defaultPrevented: boolean;
  preventDefault(): void;
}

/**
 * `onClick` of an `<a href={url} target="_blank">`: a plain primary click opens through
 * `openExternalLink`; a modifier, another button or an already handled event keeps the default.
 */
export function onExternalLinkClick(event: LinkClick, url: string): void {
  if (event.defaultPrevented || event.button !== 0) return;
  if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
  if (!isHttpUrl(url)) return;
  event.preventDefault();
  openExternalLink(url);
}
