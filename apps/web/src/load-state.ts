export type LoadState<T> =
  { state: "loading" } | { state: "ready"; value: T } | { state: "error"; message: string };

export function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : "An unexpected error occurred.";
}
