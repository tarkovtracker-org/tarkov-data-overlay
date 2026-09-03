import { afterEach, describe, expect, it } from 'vitest';
import { getProjectPaths } from '../src/lib/index.js';
import { resolveBuildVersion } from '../scripts/build.js';

const previousOverlayVersion = process.env.OVERLAY_VERSION;

afterEach(() => {
  if (previousOverlayVersion === undefined) {
    delete process.env.OVERLAY_VERSION;
  } else {
    process.env.OVERLAY_VERSION = previousOverlayVersion;
  }
});

describe('resolveBuildVersion', () => {
  it('prefers an explicitly supplied release version', () => {
    process.env.OVERLAY_VERSION = '1.81';

    expect(resolveBuildVersion('/unused', () => '1.80')).toEqual({
      value: '1.81',
      isAuthoritative: true,
    });
  });

  it('uses the latest tag when tags are available', () => {
    delete process.env.OVERLAY_VERSION;

    expect(resolveBuildVersion('/unused', () => '1.80')).toEqual({
      value: '1.80',
      isAuthoritative: true,
    });
  });

  it('marks the package version as non-authoritative when tags are unavailable', () => {
    delete process.env.OVERLAY_VERSION;
    const { rootDir } = getProjectPaths();

    expect(resolveBuildVersion(rootDir, () => undefined)).toEqual({
      value: '1.0.0',
      isAuthoritative: false,
    });
  });
});
