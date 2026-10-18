import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TooltipProvider } from '@web/ui/tooltip';
import { EnvTable } from './EnvTable';

describe('EnvTable masks values by the one secret rule of @shared/secrets (ADR-124, R4W-09)', () => {
  it.each([
    ['AWS_BEARER_TOKEN_BEDROCK', true],
    ['GH_TOKEN_CI', true],
    ['ANTHROPIC_CUSTOM_HEADERS', true],
    ['DB_CREDENTIALS', true],
    ['anthropic_api_key', true],
    ['KEYBOARD_LAYOUT', false],
    ['TOKENIZER_PATH', false],
    ['HTTPS_PROXY', false],
  ])('%s → masked: %s', (key, masked) => {
    render(
      <TooltipProvider>
        <EnvTable
          rows={[{ id: 'row-a', key, value: 'value' }]}
          onChange={() => undefined}
          problems={[]}
          issues={new Map()}
          labelId="env-label"
          hintId="env-hint"
        />
      </TooltipProvider>,
    );
    const value = screen.getByLabelText<HTMLInputElement>('Value of variable 1');
    expect(value.type).toBe(masked ? 'password' : 'text');
    expect(screen.queryByRole('button', { name: 'Show the value of variable 1' }) !== null).toBe(masked);
  });
});
