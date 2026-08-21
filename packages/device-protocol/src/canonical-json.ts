export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new TypeError("Canonical JSON rejects non-finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    const prototype = Object.getPrototypeOf(object);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Canonical JSON accepts plain objects only");
    }
    const entries = Object.keys(object)
      .sort()
      .map((key) => {
        const entry = object[key];
        if (entry === undefined)
          throw new TypeError("Canonical JSON rejects undefined values");
        return `${JSON.stringify(key)}:${canonicalJson(entry)}`;
      });
    return `{${entries.join(",")}}`;
  }
  throw new TypeError(`Canonical JSON cannot encode ${typeof value}`);
}
