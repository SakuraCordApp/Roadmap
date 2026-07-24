export function labelFor(values: Array<{ id: string; label: string }>, id: string): string {
  return values.find((value) => value.id === id)?.label ?? id.replaceAll("_", " ");
}
