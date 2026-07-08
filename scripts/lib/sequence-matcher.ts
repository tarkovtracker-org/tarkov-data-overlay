/**
 * Faithful TypeScript port of Python difflib's SequenceMatcher.ratio()
 * for strings, including the default autojunk behavior.
 *
 * The story generator's optional/required matching was originally written in
 * Python around difflib.SequenceMatcher; this port reproduces the exact
 * algorithm (Ratcliff/Obershelp with the CPython "popular element" autojunk
 * heuristic) so fuzzy-match thresholds behave identically after the pipeline's
 * migration to TypeScript.
 */

interface Match {
  a: number;
  b: number;
  size: number;
}

interface ChainedB {
  /** char -> ascending list of indices in b (popular chars removed by autojunk) */
  b2j: Map<string, number[]>;
  /** junk chars in b (always empty here: no isjunk predicate is used) */
  bjunk: Set<string>;
}

/** CPython SequenceMatcher.__chain_b with isjunk=None, autojunk=True. */
function chainB(b: string): ChainedB {
  const b2j = new Map<string, number[]>();
  for (let i = 0; i < b.length; i += 1) {
    const ch = b[i];
    const indices = b2j.get(ch);
    if (indices) indices.push(i);
    else b2j.set(ch, [i]);
  }

  const bjunk = new Set<string>();

  // autojunk: remove "popular" elements from b2j when b is long enough.
  const n = b.length;
  if (n >= 200) {
    const ntest = Math.floor(n / 100) + 1;
    const popular: string[] = [];
    for (const [ch, indices] of b2j) {
      if (indices.length > ntest) popular.push(ch);
    }
    for (const ch of popular) b2j.delete(ch);
  }

  return { b2j, bjunk };
}

/** CPython SequenceMatcher.find_longest_match. */
function findLongestMatch(
  a: string,
  b: string,
  { b2j, bjunk }: ChainedB,
  alo: number,
  ahi: number,
  blo: number,
  bhi: number
): Match {
  let besti = alo;
  let bestj = blo;
  let bestsize = 0;

  let j2len = new Map<number, number>();
  const nothing: number[] = [];

  for (let i = alo; i < ahi; i += 1) {
    const newj2len = new Map<number, number>();
    for (const j of b2j.get(a[i]) ?? nothing) {
      if (j < blo) continue;
      if (j >= bhi) break;
      const k = (j2len.get(j - 1) ?? 0) + 1;
      newj2len.set(j, k);
      if (k > bestsize) {
        besti = i - k + 1;
        bestj = j - k + 1;
        bestsize = k;
      }
    }
    j2len = newj2len;
  }

  // Extend the best by non-junk elements on each end.
  while (besti > alo && bestj > blo && !bjunk.has(b[bestj - 1]) && a[besti - 1] === b[bestj - 1]) {
    besti -= 1;
    bestj -= 1;
    bestsize += 1;
  }
  while (
    besti + bestsize < ahi &&
    bestj + bestsize < bhi &&
    !bjunk.has(b[bestj + bestsize]) &&
    a[besti + bestsize] === b[bestj + bestsize]
  ) {
    bestsize += 1;
  }

  // Then extend by junk elements on each end (no-op with an empty junk set,
  // kept for fidelity with the CPython implementation).
  while (besti > alo && bestj > blo && bjunk.has(b[bestj - 1]) && a[besti - 1] === b[bestj - 1]) {
    besti -= 1;
    bestj -= 1;
    bestsize += 1;
  }
  while (
    besti + bestsize < ahi &&
    bestj + bestsize < bhi &&
    bjunk.has(b[bestj + bestsize]) &&
    a[besti + bestsize] === b[bestj + bestsize]
  ) {
    bestsize += 1;
  }

  return { a: besti, b: bestj, size: bestsize };
}

/**
 * `difflib.SequenceMatcher(None, a, b).ratio()` for strings.
 *
 * Returns 2*M/T where M is the total size of matched blocks and T the total
 * length of both strings. 1.0 for two empty strings.
 */
export function sequenceRatio(a: string, b: string): number {
  const la = a.length;
  const lb = b.length;
  if (la + lb === 0) return 1.0;

  const chained = chainB(b);

  // get_matching_blocks: only the summed size matters for ratio(), so the
  // adjacent-block merge step is unnecessary.
  let matches = 0;
  const queue: Array<[number, number, number, number]> = [[0, la, 0, lb]];
  while (queue.length > 0) {
    const [alo, ahi, blo, bhi] = queue.pop() as [number, number, number, number];
    const m = findLongestMatch(a, b, chained, alo, ahi, blo, bhi);
    if (m.size > 0) {
      matches += m.size;
      if (alo < m.a && blo < m.b) queue.push([alo, m.a, blo, m.b]);
      if (m.a + m.size < ahi && m.b + m.size < bhi) {
        queue.push([m.a + m.size, ahi, m.b + m.size, bhi]);
      }
    }
  }

  return (2.0 * matches) / (la + lb);
}
