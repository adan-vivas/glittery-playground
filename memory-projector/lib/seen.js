// Which memories this browser has already seen, so a new one "develops" the first time it is shown.
// Lives in localStorage when it can; when storage is missing, blocked or corrupt, every memory simply counts as new.

export function safeLocalStorage() {
  try { return globalThis.localStorage || null; } catch { return null; }
}

export function createSeen(storage = safeLocalStorage(), key = 'memory-projector:seen') {
  const read = () => {
    try {
      const v = JSON.parse(storage?.getItem(key) || '[]');
      return new Set(Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
    } catch { return new Set(); }
  };
  return {
    has: (id) => read().has(id),
    mark(id) {
      try {
        const s = read();
        if (s.has(id)) return;
        s.add(id);
        storage?.setItem(key, JSON.stringify([...s]));
      } catch { /* storage refused: it just stays new */ }
    },
  };
}
