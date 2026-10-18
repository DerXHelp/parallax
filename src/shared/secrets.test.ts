import { describe, expect, it } from 'vitest';
import { isSecretEnvKey } from './secrets';

describe('isSecretEnvKey (ADR-124)', () => {
  it.each([
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'AWS_BEARER_TOKEN_BEDROCK',
    'GH_TOKEN_CI',
    'GATEWAY_TOKEN',
    'CLIENT_SECRET',
    'AWS_CREDENTIALS',
    'GOOGLE_APPLICATION_CREDENTIAL',
    'DB_PASSWD',
    'DBPASSWORD',
    'my_password_file',
    'OPENAI_APIKEY',
    'api.key',
    'TOKEN',
    'ANTHROPIC_CUSTOM_HEADERS',
    'anthropic_custom_headers',
  ])('treats %s as a secret', (name) => {
    expect(isSecretEnvKey(name)).toBe(true);
  });

  it.each([
    'KEYBOARD_LAYOUT',
    'TOKENIZER_PATH',
    'MONKEY_PATCH',
    'PATH',
    'CLAUDE_CONFIG_DIR',
    'ANTHROPIC_MODEL',
    'HTTPS_PROXY',
    'NODE_EXTRA_CA_CERTS',
    '',
  ])('does not treat %s as a secret', (name) => {
    expect(isSecretEnvKey(name)).toBe(false);
  });
});
