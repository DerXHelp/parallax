import { pathTail } from './path-display';

/**
 * Display title of a session (V2-05): the server's title, or – while it is empty (`session.create`
 * without a prompt, no AI title yet) – the name of the project folder, so freshly created sessions
 * are distinguishable in the sidebar, the header and the "Stop server" list.
 */
export function sessionTitle(summary: { title: string; cwd: string }): string {
  const title = summary.title.trim();
  return title === '' ? pathTail(summary.cwd, 1) : summary.title;
}
