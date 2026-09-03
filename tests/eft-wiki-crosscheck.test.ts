import { describe, it, expect } from 'vitest';
import { classifyWiki, wikiTitleFor } from '../scripts/eft-wiki-crosscheck.js';

describe('eft-wiki-crosscheck classifyWiki', () => {
  it('reports fetch-failed distinctly from no-wiki-value', () => {
    // Fetch failed: must not be collapsed into "no usable wiki value".
    expect(classifyWiki(10, 12, undefined, true)).toBe('fetch-failed');
    // Page loaded but carried no value for the field.
    expect(classifyWiki(10, 12, undefined, false)).toBe('no-wiki-value');
  });

  it('classifies agreement when the fetch succeeded', () => {
    expect(classifyWiki(10, 12, 12, false)).toBe('eft'); // wiki backs the reference
    expect(classifyWiki(10, 12, 10, false)).toBe('api'); // wiki backs the API
    expect(classifyWiki(12, 12, 12, false)).toBe('both'); // api==eft, not a real conflict
    expect(classifyWiki(10, 12, 99, false)).toBe('neither');
  });

  it('a failed fetch wins even if a stale wiki value is present', () => {
    // Defensive: fetchFailed should dominate regardless of any wiki value.
    expect(classifyWiki(10, 12, 12, true)).toBe('fetch-failed');
  });
});

describe('eft-wiki-crosscheck wikiTitleFor', () => {
  it('falls back to the task name for malformed percent encoding', () => {
    expect(
      wikiTitleFor({
        id: 'task-1',
        name: 'Fallback task',
        wikiLink: 'https://escapefromtarkov.fandom.com/wiki/Bad%E0%A4%A',
      })
    ).toBe('Fallback task');
  });

  it('removes query strings before decoding wiki titles', () => {
    expect(
      wikiTitleFor({
        id: 'task-1',
        name: 'Fallback task',
        wikiLink: 'https://escapefromtarkov.fandom.com/wiki/Quest_Name?so=search',
      })
    ).toBe('Quest_Name');
  });

  it('accepts relative wiki links', () => {
    expect(
      wikiTitleFor({ id: 'task-1', name: 'Fallback task', wikiLink: '/wiki/Quest_Name' })
    ).toBe('Quest_Name');
  });
});
