export interface DiffEntry {
  path: string;
  before: unknown;
  after: unknown;
}

export function diffValues(before: unknown, after: unknown, path = ""): DiffEntry[] {
  if (Object.is(before, after)) return [];
  if (
    before === null ||
    after === null ||
    typeof before !== "object" ||
    typeof after !== "object" ||
    Array.isArray(before) ||
    Array.isArray(after)
  ) {
    return [{ path: path || "$", before, after }];
  }
  const left = before as Record<string, unknown>;
  const right = after as Record<string, unknown>;
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  return [...keys].flatMap((key) =>
    diffValues(left[key], right[key], path ? `${path}.${key}` : key),
  );
}
