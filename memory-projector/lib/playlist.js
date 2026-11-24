// The memories in story order, and where the projector is among them. Back and next wrap around; shuffle jumps to
// any other memory. Every mover returns the memory now current (null when there are none).
export function createPlaylist(memories, rng = Math.random) {
  const list = Array.isArray(memories) ? memories.slice() : [];
  let index = 0;
  const current = () => list[index] || null;
  const go = (i) => { if (list.length) index = ((i % list.length) + list.length) % list.length; return current(); };
  return {
    get size() { return list.length; },
    get index() { return index; },
    get current() { return current(); },
    get list() { return list; },
    next: () => go(index + 1),
    back: () => go(index - 1),
    shuffle() {
      if (list.length < 2) return current();
      const k = Math.min(Math.floor(rng() * (list.length - 1)), list.length - 2);   // one of the others
      return go(k >= index ? k + 1 : k);
    },
    show(id) {
      const i = list.findIndex((m) => m && m.id === id);
      if (i < 0) return false;
      index = i;
      return true;
    },
  };
}
