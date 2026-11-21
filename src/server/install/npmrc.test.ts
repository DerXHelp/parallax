import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_REGISTRY,
  authFor,
  parseNpmrc,
  readNpmrc,
  registryFor,
  replaceEnv,
  userNpmrcPath,
} from './npmrc';

const enoent = (): Error => Object.assign(new Error('missing'), { code: 'ENOENT' });

describe('replaceEnv', () => {
  it('replaces ${VAR}, keeps unknown ones, empties ${VAR?} and honours escapes', () => {
    const env = { NPM_TOKEN: 'tok-1', Mixed_Case: 'm' };
    expect(replaceEnv('a${NPM_TOKEN}b', env)).toBe('atok-1b');
    expect(replaceEnv('${npm_token}', env, 'win32')).toBe('tok-1');
    expect(replaceEnv('${MIXED_CASE}', env, 'win32')).toBe('m');
    expect(replaceEnv('${MISSING}', env)).toBe('${MISSING}');
    expect(replaceEnv('x${MISSING?}y', env)).toBe('xy');
    expect(replaceEnv('\\${NPM_TOKEN}', env)).toBe('${NPM_TOKEN}');
    expect(replaceEnv('\\\\${NPM_TOKEN}', env)).toBe('\\tok-1');
  });

  it('matches variable names exactly on POSIX', () => {
    const env = { NPM_TOKEN: 'tok-1' };
    expect(replaceEnv('${NPM_TOKEN}', env, 'linux')).toBe('tok-1');
    expect(replaceEnv('${npm_token}', env, 'linux')).toBe('${npm_token}');
  });
});

describe('parseNpmrc', () => {
  it('reads key=value lines like npm (comments, quotes, CRLF, sections, arrays)', () => {
    const text = [
      '; comment',
      '# comment',
      'registry = https://registry.example/npm/ ; trailing comment',
      '@anthropic-ai:registry="https://scoped.example/"',
      "quoted='a;b#c'",
      'escaped=a\\;b',
      'list[]=x',
      'novalue',
      '//Registry.Example/npm/:_authToken=${TOKEN}',
      '${KEY_NAME}=from-env-key',
      'registry=https://registry.example/later/',
      '[section]',
      'ignored=1',
    ].join('\r\n');
    const npmrc = parseNpmrc(text, { TOKEN: 'secret-token', KEY_NAME: 'dynamic' });
    expect(Object.fromEntries(npmrc)).toEqual({
      registry: 'https://registry.example/later/',
      '@anthropic-ai:registry': 'https://scoped.example/',
      quoted: 'a;b#c',
      escaped: 'a;b',
      '//registry.example/npm/:_authToken': 'secret-token',
      dynamic: 'from-env-key',
    });
  });
});

describe('readNpmrc', () => {
  it('reads NPM_CONFIG_USERCONFIG, else %USERPROFILE%\\.npmrc', async () => {
    const readFile = vi.fn((file: string) => Promise.resolve(`registry=https://r.example/ # ${file}`));
    const fromVar = await readNpmrc({ npm_config_userconfig: 'C:\\cfg\\my.npmrc' }, readFile, 'win32');
    expect(readFile).toHaveBeenLastCalledWith('C:\\cfg\\my.npmrc');
    expect(fromVar.get('registry')).toBe('https://r.example/');
    await readNpmrc({ USERPROFILE: 'C:\\Users\\someone' }, readFile, 'win32');
    expect(readFile).toHaveBeenLastCalledWith('C:\\Users\\someone\\.npmrc');
    expect(userNpmrcPath({}, 'win32')).toBeNull();
  });

  it('reads npm_config_userconfig, else $HOME/.npmrc on Linux', async () => {
    const readFile = vi.fn(() => Promise.resolve('registry=https://r.example/'));
    await readNpmrc({ NPM_CONFIG_USERCONFIG: '/etc/demo/npmrc', HOME: '/home/demo' }, readFile, 'linux');
    expect(readFile).toHaveBeenLastCalledWith('/etc/demo/npmrc');
    await readNpmrc({ HOME: '/home/demo', USERPROFILE: 'C:\\Users\\someone' }, readFile, 'linux');
    expect(readFile).toHaveBeenLastCalledWith('/home/demo/.npmrc');
    expect(userNpmrcPath({ home: '/home/demo' }, 'linux')).toBeNull();
    readFile.mockClear();
    for (const file of ['relative/.npmrc', '/proc/self/environ', 'C:\\cfg\\my.npmrc']) {
      expect((await readNpmrc({ npm_config_userconfig: file }, readFile, 'linux')).size).toBe(0);
    }
    expect(readFile).not.toHaveBeenCalled();
  });

  it('treats a missing file as empty and rethrows other errors', async () => {
    const env = { USERPROFILE: 'C:\\Users\\someone' };
    expect((await readNpmrc(env, () => Promise.reject(enoent()), 'win32')).size).toBe(0);
    await expect(
      readNpmrc(env, () => Promise.reject(Object.assign(new Error('denied'), { code: 'EACCES' })), 'win32'),
    ).rejects.toThrow('denied');
  });

  it('never touches a UNC, device or relative path', async () => {
    const readFile = vi.fn(() => Promise.resolve('registry=https://r.example/'));
    for (const file of ['\\\\server\\share\\.npmrc', '\\\\?\\C:\\x\\.npmrc', 'relative\\.npmrc']) {
      expect((await readNpmrc({ NPM_CONFIG_USERCONFIG: file }, readFile, 'win32')).size).toBe(0);
    }
    expect((await readNpmrc({ USERPROFILE: '\\\\server\\home' }, readFile, 'win32')).size).toBe(0);
    expect(readFile).not.toHaveBeenCalled();
  });
});

describe('registryFor', () => {
  const npmrc = parseNpmrc(
    '@anthropic-ai:registry=https://scoped.example/npm\nregistry=https://default.example/',
    {},
  );

  it('prefers the environment, then the scope, then registry=, then registry.npmjs.org', () => {
    expect(registryFor('@anthropic-ai', npmrc, { NPM_CONFIG_REGISTRY: 'https://env.example' })).toBe(
      'https://env.example/',
    );
    expect(registryFor('@anthropic-ai', npmrc, { npm_config_registry: 'https://env2.example/' })).toBe(
      'https://env2.example/',
    );
    expect(registryFor('@anthropic-ai', npmrc, {})).toBe('https://scoped.example/npm/');
    expect(registryFor('@other', npmrc, {})).toBe('https://default.example/');
    expect(registryFor(null, npmrc, {})).toBe('https://default.example/');
    expect(registryFor('@anthropic-ai', new Map(), { NPM_CONFIG_REGISTRY: ' ' })).toBe(DEFAULT_REGISTRY);
  });
});

describe('authFor', () => {
  it('returns Bearer for _authToken, Basic for _auth and username + _password', () => {
    const npmrc = parseNpmrc(
      [
        '//token.example/:_authToken=tok',
        '//auth.example/:_auth=dXNlcjpwYXNz',
        '//user.example/:username=alice',
        `//user.example/:_password=${Buffer.from('s3cret').toString('base64')}`,
      ].join('\n'),
      {},
    );
    expect(authFor('https://token.example/pkg', npmrc)).toBe('Bearer tok');
    expect(authFor('https://auth.example/pkg', npmrc)).toBe('Basic dXNlcjpwYXNz');
    expect(authFor('https://user.example/pkg', npmrc)).toBe(
      `Basic ${Buffer.from('alice:s3cret').toString('base64')}`,
    );
  });

  it('prefers the token over _auth over username + password at the same prefix', () => {
    const npmrc = parseNpmrc(
      '//r.example/:_auth=YQ==\n//r.example/:_authToken=tok\n//r.example/:username=u\n//r.example/:_password=cA==',
      {},
    );
    expect(authFor('https://r.example/x', npmrc)).toBe('Bearer tok');
  });

  it('takes the longest matching prefix and never another host or port', () => {
    const npmrc = parseNpmrc(
      [
        '//registry.example/:_authToken=root',
        '//registry.example/npm/private/:_authToken=deep',
        '//registry.example/npm:_authToken=noslash',
        '//registry.example:8443/:_authToken=port',
      ].join('\n'),
      {},
    );
    expect(authFor('https://registry.example/npm/private/@s%2Fpkg', npmrc)).toBe('Bearer deep');
    expect(authFor('https://registry.example/npm/other/x.tgz', npmrc)).toBe('Bearer noslash');
    expect(authFor('https://registry.example/elsewhere', npmrc)).toBe('Bearer root');
    expect(authFor('https://REGISTRY.example/elsewhere', npmrc)).toBe('Bearer root');
    expect(authFor('https://registry.example:8443/x', npmrc)).toBe('Bearer port');
    expect(authFor('https://cdn.example/registry.example/x', npmrc)).toBeNull();
    expect(authFor('https://registry.example.evil.example/x', npmrc)).toBeNull();
    expect(authFor('not a url', npmrc)).toBeNull();
  });
});
