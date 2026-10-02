import { DatabaseSync } from "node:sqlite";
export const sqlite = new DatabaseSync(":memory:");
function prepare(sql: string) {
  let values: any[] = [];
  return {
    bind(...bindings: any[]) {
      if (bindings.length > 100) throw new Error("D1 permits at most 100 bound parameters");
      values = bindings;
      return this;
    },
    async first() {
      return sqlite.prepare(sql).get(...values) ?? null;
    },
    async all() {
      return { results: sqlite.prepare(sql).all(...values) };
    },
    async run() {
      return sqlite.prepare(sql).run(...values);
    },
  };
}
export const db = {
  prepare,
  batch: async (statements: ReturnType<typeof prepare>[]) =>
    Promise.all(statements.map((s) => s.run())),
} as unknown as D1Database;
