// The story's crawl across the table: how the paragraph breaks into lines, and where it is at time t.

/** Words into lines no wider than maxWidth (as `measure` reports); a word wider than a line is broken across lines. */
export function wrapLines(text, measure, maxWidth) {
  const lines = [];
  let line = '';
  const push = (word) => {
    const next = line ? line + ' ' + word : word;
    if (measure(next) <= maxWidth) { line = next; return; }
    if (line) { lines.push(line); line = ''; }
    while (measure(word) > maxWidth) {           // break it: as many characters as fit, at least one
      let k = 1;
      while (k < word.length && measure(word.slice(0, k + 1)) <= maxWidth) k++;
      lines.push(word.slice(0, k));
      word = word.slice(k);
    }
    line = word;
  };
  for (const word of String(text || '').split(/\s+/).filter(Boolean)) push(word);
  if (line) lines.push(line);
  return lines;
}

/**
 * Where the crawl is at time t (s). offset runs from -viewHeight (the text still below the near edge) to
 * lineCount * lineHeight (its last line gone past the far edge) over max(words / wordsPerSecond, 4) s; then the table
 * is dark (alpha 0) for `pause` s, and it starts again.
 */
export function crawlState(t, { lineCount, lineHeight, viewHeight, words, wordsPerSecond = 2, pause = 2.5 }) {
  const end = lineCount * lineHeight, dur = Math.max(words / wordsPerSecond, 4), cycle = dur + pause;
  const tt = ((t % cycle) + cycle) % cycle;
  if (tt >= dur) return { offset: end, alpha: 0 };
  return { offset: -viewHeight + (end + viewHeight) * (tt / dur), alpha: 1 };
}
