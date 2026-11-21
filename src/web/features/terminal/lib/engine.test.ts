import { describe, expect, it, vi } from 'vitest';
import { createXtermEngine, isWebLink } from './engine';

const terminalOptions = vi.hoisted((): unknown[] => []);

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    constructor(options: unknown) {
      terminalOptions.push(options);
    }
    loadAddon(): undefined {
      return undefined;
    }
  },
}));
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    proposeDimensions(): undefined {
      return undefined;
    }
  },
}));

describe('isWebLink (WP-99 review)', () => {
  it('accepts absolute http(s) URLs only', () => {
    expect(isWebLink('https://example.com/docs')).toBe(true);
    expect(isWebLink('http://localhost:8080/')).toBe(true);
    expect(isWebLink('javascript:alert(1)')).toBe(false);
    expect(isWebLink('file:///C:/Windows/System32/cmd.exe')).toBe(false);
    expect(isWebLink('vscode://open?file=x')).toBe(false);
    expect(isWebLink('/relative/path')).toBe(false);
    expect(isWebLink('not a url')).toBe(false);
  });
});

describe('createXtermEngine (WP-104)', () => {
  it('tells xterm about ConPTY only for a Windows computer', () => {
    const options = { theme: {}, font: { family: 'monospace', size: 12 }, screenReaderMode: false };
    terminalOptions.length = 0;
    createXtermEngine({ ...options, conpty: true });
    createXtermEngine({ ...options, conpty: false });
    expect(terminalOptions[0]).toMatchObject({ windowsPty: { backend: 'conpty' } });
    expect(terminalOptions[1]).not.toHaveProperty('windowsPty');
  });
});
