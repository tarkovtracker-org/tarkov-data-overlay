/**
 * Duplicate-key detection for JSON5 sources.
 *
 * JSON5 accepts a repeated key and keeps the last one. Nothing warns: the file
 * parses, validation passes, the build succeeds, and the earlier entry is
 * gone. Finding that needs a textual scan — parsing first would collapse the
 * duplicate before it could be seen.
 */

/** A key seen more than once under the same parent. */
export interface DuplicateKey {
  /** Full path, e.g. `tasks/5ae4.../objectives/6a54...` */
  path: string;
  /** Just the repeated key, for reporting */
  key: string;
  count: number;
}

const IDENT_START = /[A-Za-z_$]/;
const IDENT_PART = /[\w$-]/;

interface Frame {
  /** Path segment this frame contributes */
  segment: string;
  /** Set for arrays: how many elements have been opened so far */
  elements?: number;
}

/**
 * Every key that appears more than once under the same parent.
 *
 * Two things this has to distinguish, both of which a simpler scan gets wrong:
 *
 * Paths, not nesting depth. The same key under two different parents sits at
 * the same depth and is perfectly valid — `pvp-season` appears once per task
 * in the divergences file.
 *
 * Array elements. `storyRequirements` is a list of objects that each carry a
 * `type` and a `name`; those are siblings in the text but not in the data.
 * Elements therefore get their index in the path.
 */
export function findDuplicateKeys(source: string): DuplicateKey[] {
  const counts = new Map<string, number>();
  const stack: Frame[] = [];
  let pendingKey: string | null = null;
  let lastValue: string | null = null;

  const path = (key: string) => [...stack.map((f) => f.segment), key].filter(Boolean).join('/');

  for (let i = 0; i < source.length; i++) {
    const ch = source[i]!;
    const next = source[i + 1];

    if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i++;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let value = '';
      i++;
      while (i < source.length && source[i] !== ch) {
        if (source[i] === '\\') i++;
        else value += source[i];
        i++;
      }
      lastValue = value;
      continue;
    }
    if (IDENT_START.test(ch)) {
      let value = ch;
      while (i + 1 < source.length && IDENT_PART.test(source[i + 1]!)) value += source[++i]!;
      lastValue = value;
      continue;
    }
    if (ch === ':') {
      if (lastValue !== null) {
        pendingKey = lastValue;
        counts.set(path(pendingKey), (counts.get(path(pendingKey)) ?? 0) + 1);
      }
      lastValue = null;
      continue;
    }
    if (ch === '{') {
      const parent = stack[stack.length - 1];
      if (pendingKey !== null) stack.push({ segment: pendingKey });
      else if (parent?.elements !== undefined) stack.push({ segment: `[${parent.elements++}]` });
      else stack.push({ segment: '' });
      pendingKey = null;
      lastValue = null;
      continue;
    }
    if (ch === '[') {
      stack.push({ segment: pendingKey ?? '', elements: 0 });
      pendingKey = null;
      lastValue = null;
      continue;
    }
    if (ch === '}' || ch === ']') {
      stack.pop();
      pendingKey = null;
      lastValue = null;
      continue;
    }
    if (ch === ',') {
      pendingKey = null;
      lastValue = null;
    }
  }

  return [...counts]
    .filter(([, count]) => count > 1)
    .map(([full, count]) => ({ path: full, key: full.split('/').pop() ?? full, count }));
}
