import { describe, expect, it } from 'vitest';
import { buildSpikeEnv } from './env';

describe('buildSpikeEnv', () => {
  const base: NodeJS.ProcessEnv = {
    Path: 'C:\\tools;D:\\repo\\node_modules\\.bin;C:\\Windows',
    PATH: 'ignored duplicate spelling',
    CLAUDECODE: '1',
    CLAUDE_CODE_SESSION_ID: 'x',
    CLAUDE_CODE_ENTRYPOINT: 'cli',
    CLAUDE_CODE_MESSAGING_TOKEN: 'secret',
    CLAUDE_CODE_GIT_BASH_PATH: 'C:\\Git\\bin\\bash.exe',
    CLAUDE_CODE_USE_POWERSHELL_TOOL: '1',
    CLAUDE_PID: '42',
    CLAUDE_EFFORT: 'high',
    CLAUDE_AGENT_SDK_VERSION: '0.0.1',
    npm_config_user_agent: 'pnpm',
    PNPM_HOME: 'C:\\pnpm',
    INIT_CWD: 'D:\\repo',
    NODE_ENV: 'test',
    NODE_OPTIONS: '--inspect',
    ANTHROPIC_API_KEY: 'test-api-key',
    ANTHROPIC_AUTH_TOKEN: 'tok',
    ANTHROPIC_BASE_URL: 'https://gateway.example',
    PARALLAX_LIVE: '1',
    parallax: 'old',
    USERPROFILE: 'C:\\Users\\someone',
    CLAUDE_CONFIG_DIR: 'D:\\cfg',
  };

  it('removes session, run-state and credential variables and keeps the allowlist', () => {
    const { env, removed } = buildSpikeEnv(base, { delimiter: ';' });
    for (const key of [
      'CLAUDECODE',
      'CLAUDE_CODE_SESSION_ID',
      'CLAUDE_CODE_ENTRYPOINT',
      'CLAUDE_CODE_MESSAGING_TOKEN',
      'CLAUDE_PID',
      'CLAUDE_EFFORT',
      'CLAUDE_AGENT_SDK_VERSION',
      'npm_config_user_agent',
      'PNPM_HOME',
      'INIT_CWD',
      'NODE_ENV',
      'NODE_OPTIONS',
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_AUTH_TOKEN',
      'ANTHROPIC_BASE_URL',
      'PARALLAX_LIVE',
    ]) {
      expect(env[key], key).toBeUndefined();
      expect(removed).toContain(key);
    }
    expect(env.CLAUDE_CODE_GIT_BASH_PATH).toBe('C:\\Git\\bin\\bash.exe');
    expect(env.CLAUDE_CODE_USE_POWERSHELL_TOOL).toBe('1');
    expect(env.USERPROFILE).toBe('C:\\Users\\someone');
    expect(env.CLAUDE_CONFIG_DIR).toBe('D:\\cfg');
  });

  it('drops node_modules\\.bin from PATH case-insensitively and keeps one spelling', () => {
    const { env, pathEntriesRemoved } = buildSpikeEnv(base, { delimiter: ';' });
    expect(env.Path).toBe('C:\\tools;C:\\Windows');
    expect(env.PATH).toBeUndefined();
    expect(pathEntriesRemoved).toBe(1);
  });

  it('sets the Parallax variables last, replacing other spellings', () => {
    const { env, set } = buildSpikeEnv(base, {
      delimiter: ';',
      entryId: 'e1',
      extra: { PARALLAX_HOME: 'T:\\home' },
    });
    expect(env.PARALLAX).toBe('1');
    expect(env.parallax).toBeUndefined();
    expect(env.PARALLAX_ENTRY_ID).toBe('e1');
    expect(env.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS).toBe('1');
    expect(env.CLAUDE_AGENT_SDK_CLIENT_APP).toBe('parallax/0.0.0-spike');
    expect(env.PARALLAX_HOME).toBe('T:\\home');
    expect(Object.keys(set)).toContain('PARALLAX_HOME');
  });
});
