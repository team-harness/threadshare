function assertWellFormedUnicode(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= value.length) {
        throw new TypeError("strings must not contain unpaired surrogates");
      }
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) {
        throw new TypeError("strings must not contain unpaired surrogates");
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new TypeError("strings must not contain unpaired surrogates");
    }
  }
}

function canonicalString(value) {
  assertWellFormedUnicode(value);
  return value.normalize("NFC");
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function canonicalValue(value, ancestors) {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return JSON.stringify(canonicalString(value));
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("canonical JSON only permits finite integers");
    if (!Number.isInteger(value)) throw new TypeError("canonical JSON only permits integers");
    if (!Number.isSafeInteger(value)) throw new TypeError("canonical JSON only permits safe integers");
    return JSON.stringify(value);
  }
  if (typeof value === "undefined") throw new TypeError("canonical JSON does not permit undefined");
  if (typeof value !== "object") throw new TypeError("canonical JSON only permits JSON values");
  if (ancestors.has(value)) throw new TypeError("canonical JSON does not permit cycles");

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const values = [];
      for (let index = 0; index < value.length; index += 1) {
        values.push(canonicalValue(value[index], ancestors));
      }
      return `[${values.join(",")}]`;
    }
    if (!isPlainObject(value)) throw new TypeError("canonical JSON only permits plain objects");
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new TypeError("canonical JSON objects may not contain symbol keys");
    }
    const entries = Object.keys(value).map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) {
        throw new TypeError("canonical JSON objects may not contain accessors");
      }
      return [canonicalString(key), descriptor.value];
    });
    entries.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    for (let index = 1; index < entries.length; index += 1) {
      if (entries[index - 1][0] === entries[index][0]) {
        throw new TypeError("canonical JSON object keys collide after NFC normalization");
      }
    }
    return `{${entries.map(([key, item]) =>
      `${JSON.stringify(key)}:${canonicalValue(item, ancestors)}`
    ).join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

/** RFC 8785-compatible canonical JSON for Threadshare's restricted value domain. */
export function canonicalJson(value) {
  return canonicalValue(value, new WeakSet());
}

export { assertWellFormedUnicode, canonicalString, isPlainObject };
