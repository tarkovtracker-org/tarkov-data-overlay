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
  /** Readable location, e.g. `tasks/5ae4.../objectives/6a54...` */
  path: string;
  /** Just the repeated key, for reporting */
  key: string;
  count: number;
}

// JSON5 identifiers follow ECMAScript, which is not ASCII-only. Restricting
// them to ASCII would make a key like `größe` invisible to the scan.
const IDENT_START = /[\p{ID_Start}$_]/u;
const IDENT_PART = /[\p{ID_Continue}$‌‍-]/u;

const HEX_4 = /^[0-9a-fA-F]{4}$/;
const HEX_2 = /^[0-9a-fA-F]{2}$/;

const SINGLE_ESCAPES: Record<string, string> = {
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
  v: '\v',
  '0': '\0',
};

interface Frame {
  /** Path segment this frame contributes */
  segment: string;
  /** Set for arrays: how many elements have been opened so far */
  elements?: number;
}

/** Read a quoted string, resolving escapes so `a` and `a` compare equal. */
function readString(source: string, start: number): { value: string; end: number } {
  const quote = source[start]!;
  let value = '';
  let i = start + 1;
  while (i < source.length && source[i] !== quote) {
    if (source[i] !== '\\') {
      value += source[i];
      i++;
      continue;
    }
    const escape = source[i + 1];
    if (escape === 'u' || escape === 'x') {
      const width = escape === 'u' ? 4 : 2;
      const digits = source.slice(i + 2, i + 2 + width);
      // Literal patterns rather than one built from `width`: nothing here is
      // attacker-controlled, but a regex assembled at runtime is a sink worth
      // not having.
      const pattern = escape === 'u' ? HEX_4 : HEX_2;
      if (pattern.test(digits)) {
        value += String.fromCharCode(parseInt(digits, 16));
        i += 2 + width;
        continue;
      }
    }
    if (escape === '\n') {
      // line continuation contributes nothing
      i += 2;
      continue;
    }
    value += escape !== undefined ? (SINGLE_ESCAPES[escape] ?? escape) : '';
    i += 2;
  }
  return { value, end: i };
}

/**
 * Every key that appears more than once under the same parent.
 *
 * Three things this has to distinguish, each of which a simpler scan gets
 * wrong:
 *
 * Paths, not nesting depth. The same key under two different parents sits at
 * the same depth and is perfectly valid — `pvp-season` appears once per task
 * in the divergences file.
 *
 * Array elements. `storyRequirements` is a list of objects that each carry a
 * `type` and a `name`; those are siblings in the text but not in the data. Any
 * container opened inside an array takes the next index, nested arrays
 * included, or two sibling lists collapse onto one path.
 *
 * Path identity. Segments are compared as a list rather than a joined string,
 * so a key containing the separator cannot alias a different parent. The joined
 * form is for reading only.
 */
export function findDuplicateKeys(source: string): DuplicateKey[] {
  const counts = new Map<string, { path: string; key: string; count: number }>();
  const stack: Frame[] = [];
  let pendingKey: string | null = null;
  let lastValue: string | null = null;

  const enter = (isArray: boolean) => {
    const parent = stack[stack.length - 1];
    let segment: string;
    if (pendingKey !== null) segment = pendingKey;
    else if (parent?.elements !== undefined) segment = `[${parent.elements++}]`;
    else segment = '';
    stack.push({ segment, elements: isArray ? 0 : undefined });
    pendingKey = null;
    lastValue = null;
  };

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
      const { value, end } = readString(source, i);
      lastValue = value;
      i = end;
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
        const segments = [...stack.map((frame) => frame.segment), pendingKey];
        const identity = JSON.stringify(segments);
        const seen = counts.get(identity);
        if (seen) seen.count++;
        else
          counts.set(identity, {
            path: segments.filter(Boolean).join('/'),
            key: pendingKey,
            count: 1,
          });
      }
      lastValue = null;
      continue;
    }
    if (ch === '{') {
      enter(false);
      continue;
    }
    if (ch === '[') {
      enter(true);
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

  return [...counts.values()].filter((entry) => entry.count > 1);
}
