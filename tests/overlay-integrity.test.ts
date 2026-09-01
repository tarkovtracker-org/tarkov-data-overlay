import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyOverlaySha256 } from '../src/lib/index.js';

function withDigest(value: Record<string, unknown>): Record<string, unknown> {
  const unsigned = { ...value };
  const metadata = { ...(unsigned.$meta as Record<string, unknown>) };
  delete metadata.sha256;
  const content = JSON.stringify({ ...unsigned, $meta: metadata }, null, 2);
  return {
    ...unsigned,
    $meta: {
      ...metadata,
      sha256: createHash('sha256').update(content).digest('hex'),
    },
  };
}

describe('overlay integrity', () => {
  it('accepts a digest generated with the build serialization', () => {
    const overlay = withDigest({
      modes: { regular: {} },
      $meta: { version: '1.80', generated: '2026-08-31T00:00:00.000Z' },
    });

    expect(verifyOverlaySha256(overlay)).toBe(true);
  });

  it('rejects missing, malformed, and tampered digests', () => {
    const overlay = withDigest({
      modes: { regular: {} },
      $meta: { version: '1.80', generated: '2026-08-31T00:00:00.000Z' },
    });

    const malformed = {
      ...overlay,
      $meta: { ...(overlay.$meta as Record<string, unknown>), sha256: 'bad' },
    };
    expect(verifyOverlaySha256(malformed)).toBe(false);
    expect(verifyOverlaySha256({ modes: {} })).toBe(false);
    expect(
      verifyOverlaySha256({
        ...overlay,
        modes: { regular: { tasks: { changed: true } } },
      })
    ).toBe(false);
  });
});
