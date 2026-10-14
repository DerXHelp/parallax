/**
 * Every SDK fixture must be valid JSONL (header + events with gap-free seq, non-decreasing tMs)
 * and free of personal data (user paths, e-mails, tokens; plus this machine's user/host name).
 */
import { readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseFixture } from '../../../scripts/record/format';
import { findGenericLeaks } from '../../../scripts/record/sanitize';

const dir = path.dirname(fileURLToPath(import.meta.url));
const files = readdirSync(dir)
  .filter((name) => name.endsWith('.jsonl'))
  .sort();

function machineWords(): string[] {
  const words = [os.userInfo().username, os.hostname()];
  return words.filter((word) => word.length >= 5);
}

describe('SDK fixtures', () => {
  it('exist', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  describe.each(files)('%s', (file) => {
    const text = readFileSync(path.join(dir, file), 'utf8');

    it('is valid JSONL with header and gap-free seq', () => {
      const { header, events } = parseFixture(text, file);
      expect(header.scenario).toBe(file.replace(/\.jsonl$/, ''));
      expect(events.length).toBeGreaterThan(0);
      expect(events.at(-1)?.seq).toBe(events.length);
    });

    it('contains no personal data', () => {
      expect(findGenericLeaks(text)).toEqual([]);
      const lower = text.toLowerCase();
      for (const word of machineWords()) {
        expect(lower.includes(word.toLowerCase()), 'machine-specific word found').toBe(false);
      }
    });
  });
});
