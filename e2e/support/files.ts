/**
 * Phase-3 helpers (WP-60): sample files of every viewer kind in a test project, the messages of the
 * server log (the recording opener of the FakeBackend logs `file.open (fake): <target> <path>`), the
 * requests the guard refused (a browser cannot read the status of a CORS-blocked answer),
 * a page recorder that notes every text a selector ever showed (for states that last only a few
 * frames, e.g. the plan file while Claude writes it – no fixed waits) and one that notes WHEN a text
 * first showed (time bounds of the app without the retry lag of an assertion, FIX-R5-F6).
 */
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { z } from 'zod';
import { LIMITS } from '@shared/common';
import { FAKE_SHOT_PNG_BASE64 } from '../../src/server/backend/fake/image';
import type { E2eServer } from './server';

export const README_TITLE = 'Readme of the E2E project';

/** A one-page PDF (Chrome's viewer repairs the missing xref table). */
const PDF = [
  '%PDF-1.4',
  '1 0 obj <</Type /Catalog /Pages 2 0 R>> endobj',
  '2 0 obj <</Type /Pages /Kids [3 0 R] /Count 1>> endobj',
  '3 0 obj <</Type /Page /Parent 2 0 R /MediaBox [0 0 200 100]>> endobj',
  'trailer <</Root 1 0 R>>',
  '%%EOF',
  '',
].join('\n');

export interface SampleFiles {
  /** Markdown (rendered / source). */
  readme: string;
  /** Plain text, changed on disk by the tests (live reload). */
  notes: string;
  image: string;
  pdf: string;
  /** Text larger than LIMITS.fileTextBytes (the viewer shows the first part). */
  big: string;
}

/** Writes the sample files into `dir` (a test project). */
export async function writeSampleFiles(dir: string): Promise<SampleFiles> {
  const files: SampleFiles = {
    readme: path.join(dir, 'README.md'),
    notes: path.join(dir, 'notes.txt'),
    image: path.join(dir, 'shot.png'),
    pdf: path.join(dir, 'doc.pdf'),
    big: path.join(dir, 'big.log'),
  };
  await writeFile(files.readme, `# ${README_TITLE}\n\nSome **bold** words.\n`);
  await writeFile(files.notes, 'first version of the notes\n');
  await writeFile(files.image, Buffer.from(FAKE_SHOT_PNG_BASE64, 'base64'));
  await writeFile(files.pdf, PDF);
  const line = `${'x'.repeat(99)}\n`;
  await writeFile(files.big, line.repeat(Math.ceil(LIMITS.fileTextBytes / line.length) + 100));
  return files;
}

/** `msg` of every JSON line of the server log so far. */
export async function logMessages(server: E2eServer): Promise<string[]> {
  return (await server.logLines()).flatMap((line) => {
    try {
      const parsed: unknown = JSON.parse(line);
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        'msg' in parsed &&
        typeof parsed.msg === 'string'
      ) {
        return [parsed.msg];
      }
    } catch {
      // not JSON – ignore
    }
    return [];
  });
}

const rejectedLineSchema = z.object({
  msg: z.literal('request rejected'),
  class: z.string(),
  origin: z.string().nullable(),
  site: z.string().nullable(),
  error: z.object({ code: z.string(), params: z.object({ reason: z.string() }).optional() }),
});

/**
 * Requests the server's guard refused so far (log line `request rejected`), each as
 * `<route class> <origin|-> <sec-fetch-site|-> <code>/<reason>`.
 */
export async function rejectedRequests(server: E2eServer): Promise<string[]> {
  return (await server.logLines()).flatMap((line) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return [];
    }
    const rejected = rejectedLineSchema.safeParse(parsed);
    if (!rejected.success) return [];
    const { error, origin, site } = rejected.data;
    return [
      `${rejected.data.class} ${origin ?? '-'} ${site ?? '-'} ${error.code}/${error.params?.reason ?? '-'}`,
    ];
  });
}

/**
 * Starts noting every distinct non-empty text of the elements matching `selector` (checked on every
 * DOM change); `seenTexts` returns them. One recorder per page.
 */
export async function recordTexts(page: Page, selector: string): Promise<void> {
  await page.evaluate((watched) => {
    const seen: string[] = [];
    window.__e2eSeenTexts = seen;
    const note = () => {
      for (const element of document.querySelectorAll(watched)) {
        const text = element.textContent.trim();
        if (text !== '' && !seen.includes(text)) seen.push(text);
      }
    };
    new MutationObserver(note).observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
    });
    note();
  }, selector);
}

export async function seenTexts(page: Page): Promise<string[]> {
  return page.evaluate(() => window.__e2eSeenTexts ?? []);
}

/**
 * Starts watching for `text` in an element matching `selector` and notes the moment (`Date.now()`
 * of the page – the same wall clock as the test process) it first shows; `textShownAt` returns it.
 * For time bounds of the app itself: a web-first assertion only sees a change at its next retry
 * (intervals grow to 1 s), which would eat most of a 3-s budget (R5W-11). One watcher per page.
 */
export async function recordTextShown(page: Page, selector: string, text: string): Promise<void> {
  await page.evaluate(
    ({ watched, wanted }) => {
      window.__e2eShownAt = null;
      const check = () => {
        if (window.__e2eShownAt !== null) return;
        for (const element of document.querySelectorAll(watched)) {
          if (element.textContent.includes(wanted)) {
            window.__e2eShownAt = Date.now();
            observer.disconnect();
            return;
          }
        }
      };
      const observer = new MutationObserver(check);
      observer.observe(document.body, { subtree: true, childList: true, characterData: true });
      check();
    },
    { watched: selector, wanted: text },
  );
}

export async function textShownAt(page: Page): Promise<number | null> {
  return page.evaluate(() => window.__e2eShownAt ?? null);
}
