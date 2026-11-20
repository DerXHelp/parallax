import { afterEach, describe, expect, it, vi } from 'vitest';
import { readTerminalTheme, TERMINAL_THEME_TOKENS, watchTerminalTheme } from './theme';

let style: HTMLStyleElement | null = null;

afterEach(() => {
  style?.remove();
  style = null;
  document.documentElement.classList.remove('dark');
});

function installTokens(light: string, dark: string) {
  style = document.createElement('style');
  style.textContent = [
    `:root { --terminal-background: ${light}; --terminal-foreground: #2a2b30; --terminal-bright-cyan: #0f808c; }`,
    `.dark { --terminal-background: ${dark}; --terminal-foreground: #e3e4e8; }`,
  ].join('\n');
  document.head.append(style);
}

describe('terminal theme (WP-99b)', () => {
  it('reads the --terminal-* tokens into an xterm theme', () => {
    installTokens('#fcfcfd', '#1c1d21');
    const theme = readTerminalTheme();
    expect(theme.background).toBe('#fcfcfd');
    expect(theme.cursorAccent).toBe('#fcfcfd');
    expect(theme.foreground).toBe('#2a2b30');
    expect(theme.brightCyan).toBe('#0f808c');
    // A token that is not defined keeps xterm's default.
    expect(theme.red).toBeUndefined();
    expect(TERMINAL_THEME_TOKENS.map(([, token]) => token)).toContain('--terminal-selection');
  });

  it('applies the theme again when <html> switches between light and dark', async () => {
    installTokens('#fcfcfd', '#1c1d21');
    const onChange = vi.fn();
    const stop = watchTerminalTheme(onChange);
    document.documentElement.classList.add('dark');
    await vi.waitFor(() => {
      expect(onChange).toHaveBeenCalledTimes(1);
    });
    expect(onChange.mock.calls[0]?.[0]).toMatchObject({ background: '#1c1d21', foreground: '#e3e4e8' });

    // A class change that leaves the tokens alone does not repaint.
    document.documentElement.classList.add('some-other-class');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onChange).toHaveBeenCalledTimes(1);
    document.documentElement.classList.remove('some-other-class');

    stop();
    document.documentElement.classList.remove('dark');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});
