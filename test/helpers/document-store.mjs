export function memoryStore() {
  const data = new Map();
  return {
    data,
    async get(key) {
      return data.get(key) ?? null;
    },
    async create(key, value) {
      if (data.has(key)) return false;
      data.set(
        key,
        typeof value === "string" ? new TextEncoder().encode(value) : value,
      );
      return true;
    },
    async delete(key) {
      data.delete(key);
    },
    async list(prefix, cursor, limit) {
      const keys = [...data.keys()]
        .filter((k) => k.startsWith(prefix) && (!cursor || k > cursor))
        .sort();
      return {
        keys: keys.slice(0, limit),
        cursor: keys.length > limit ? keys[limit - 1] : null,
      };
    },
  };
}
