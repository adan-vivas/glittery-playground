// The list of memories (memories.json): checking an entry, and adding or replacing one.
import { FPS, MAX_SECONDS } from '../lib/depth-format.js';

export const wordCount = (s) => String(s || '').split(/\s+/).filter(Boolean).length;

export function slugify(s) {
  const slug = String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || 'memory';
}

/** Problems with an entry, as readable sentences (empty when it is fine). */
export function validateEntry(e) {
  const errs = [];
  if (!e || typeof e !== 'object') return ['not a memory'];
  if (!/^[a-z0-9-]+$/.test(e.id || '')) errs.push('id must be lowercase letters, digits and dashes');
  if (!String(e.story || '').trim()) errs.push('the story is empty');
  if (!(e.seconds > 0 && e.seconds <= MAX_SECONDS)) errs.push(`a memory lasts at most ${MAX_SECONDS} seconds`);
  if (!/\.mp4$/.test(e.src || '')) errs.push('src must be an .mp4');
  if (e.fps !== FPS) errs.push(`fps must be ${FPS}`);
  if (e.format != null && e.format !== 1 && e.format !== 2) errs.push('format must be 1 or 2');
  return errs;
}

/** A new list with the entry replacing the one of the same id (in place), or added; dated entries stay in date order. */
export function upsertMemory(list, entry) {
  const out = list.slice(), i = out.findIndex((m) => m.id === entry.id);
  if (i >= 0) { out[i] = entry; return out; }
  if (!entry.date) return [...out, entry];
  const at = out.findIndex((m) => m.date && m.date > entry.date);
  if (at < 0) {                                   // after the last dated one, before undated ones that follow it
    let lastDated = -1; out.forEach((m, k) => { if (m.date) lastDated = k; });
    out.splice(lastDated + 1, 0, entry);
  } else out.splice(at, 0, entry);
  return out;
}
