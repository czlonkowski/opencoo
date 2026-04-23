export function stripUndefined<T extends Record<string, unknown>>(
  input: T,
): { [K in keyof T]: Exclude<T[K], undefined> } {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(input)) {
    const value = input[key];
    if (value !== undefined) {
      out[key] = value;
    }
  }
  return out as { [K in keyof T]: Exclude<T[K], undefined> };
}
