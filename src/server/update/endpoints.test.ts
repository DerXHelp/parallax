import { describe, expect, it } from 'vitest';
import { RELEASE_PUBLIC_KEYS } from '../launcher/release';
import { RELEASES_URL, isUpdateTestBuild, releaseZipName, testEndpoints, updateEndpoints } from './endpoints';

const KEY = 'A'.repeat(43);

describe('update endpoints (WP-87 §1.7, E7)', () => {
  it('a normal build uses the GitHub downloads and the release keys, whatever the environment says', () => {
    expect(isUpdateTestBuild()).toBe(false);
    const endpoints = updateEndpoints({
      PARALLAX_TEST_UPDATE_BASE: 'http://127.0.0.1:9/releases',
      PARALLAX_TEST_RELEASE_KEYS: KEY,
    });
    expect(endpoints.latestUrl).toBe(`${RELEASES_URL}/latest/download/latest.json`);
    expect(endpoints.latestSignatureUrl).toBe(`${RELEASES_URL}/latest/download/latest.json.sig`);
    expect(endpoints.assetUrl('1.0.1')).toBe(`${RELEASES_URL}/download/v1.0.1/parallax-1.0.1-win.zip`);
    expect(endpoints.changelogUrl('1.0.1')).toBe(`${RELEASES_URL}/download/v1.0.1/CHANGELOG.md`);
    expect(endpoints.releaseKeys).toBe(RELEASE_PUBLIC_KEYS);
    expect(endpoints.registry).toBeUndefined();
    expect(endpoints.allowLoopbackHttp).toBe(false);
    expect(releaseZipName('1.0.0-rc.4')).toBe('parallax-1.0.0-rc.4-win.zip');
  });

  it('a test build reads a local release server, test keys and a registry', () => {
    const endpoints = testEndpoints({
      PARALLAX_TEST_UPDATE_BASE: 'http://127.0.0.1:4800/releases/',
      PARALLAX_TEST_RELEASE_KEYS: `${KEY},${'B'.repeat(43)}`,
      PARALLAX_TEST_REGISTRY: 'http://localhost:4801/',
    });
    expect(endpoints.latestUrl).toBe('http://127.0.0.1:4800/releases/latest/download/latest.json');
    expect(endpoints.assetUrl('9.9.1')).toBe(
      'http://127.0.0.1:4800/releases/download/v9.9.1/parallax-9.9.1-win.zip',
    );
    expect(endpoints.releaseKeys).toEqual([KEY, 'B'.repeat(43)]);
    expect(endpoints.registry).toBe('http://localhost:4801/');
    expect(endpoints.allowLoopbackHttp).toBe(true);
    expect(testEndpoints({}).releaseKeys).toBe(RELEASE_PUBLIC_KEYS);
  });

  it('a test build refuses a non-loopback base and malformed keys', () => {
    expect(() => testEndpoints({ PARALLAX_TEST_UPDATE_BASE: 'https://example.com/releases' })).toThrow();
    expect(() => testEndpoints({ PARALLAX_TEST_RELEASE_KEYS: 'short' })).toThrow();
  });
});
