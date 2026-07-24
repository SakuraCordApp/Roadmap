import {
  ConflictError,
  HistoryEntrySchema,
  RoadmapItemSchema,
  type AtomicMutation,
  type HistoryEntry,
  type ListItemsQuery,
  type MutationResult,
  type Page,
  type RoadmapItem,
  type RoadmapStorage,
} from "@roadmap/core";

interface ItemRow {
  document: string;
}

interface HistoryRow {
  id: number;
  item_id: string;
  revision: number;
  mutation_id: string;
  action: HistoryEntry["action"];
  actor_json: string;
  before_json: string | null;
  after_json: string;
  override_reason: string | null;
  created_at: string;
}

export class D1RoadmapStorage implements RoadmapStorage {
  constructor(private readonly db: D1Database) {}

  async list(query: ListItemsQuery): Promise<Page<RoadmapItem>> {
    const conditions: string[] = [];
    const bindings: Array<string | number> = [];
    const inClause = (column: string, values?: string[]) => {
      if (!values?.length) return;
      conditions.push(`${column} IN (${values.map(() => "?").join(",")})`);
      bindings.push(...values);
    };
    inClause("status", query.status);
    inClause("area", query.area);
    inClause("type", query.type);
    inClause("priority", query.priority);
    inClause("difficulty", query.difficulty);
    if (query.search) {
      conditions.push(
        "(lower(title) LIKE ? OR lower(json_extract(document, '$.description')) LIKE ?)",
      );
      const term = `%${query.search.toLowerCase()}%`;
      bindings.push(term, term);
    }
    if (query.completedSince) {
      conditions.push("completed_at >= ?");
      bindings.push(query.completedSince);
    }
    if (query.cursor) {
      conditions.push("updated_at < ?");
      bindings.push(query.cursor);
    }
    const limit = Math.min(Math.max(query.limit ?? 100, 1), 250);
    bindings.push(limit + 1);
    const sql = `SELECT document FROM roadmap_items ${
      conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""
    } ORDER BY updated_at DESC, id ASC LIMIT ?`;
    const result = await this.db
      .prepare(sql)
      .bind(...bindings)
      .all<ItemRow>();
    const rows = result.results.map((row) => RoadmapItemSchema.parse(JSON.parse(row.document)));
    const hasMore = rows.length > limit;
    const data = rows.slice(0, limit);
    const last = data.at(-1);
    return {
      data,
      ...(hasMore && last ? { nextCursor: last.updatedAt } : {}),
    };
  }

  async get(id: string): Promise<RoadmapItem | null> {
    const row = await this.db
      .prepare("SELECT document FROM roadmap_items WHERE id = ?")
      .bind(id)
      .first<ItemRow>();
    return row ? RoadmapItemSchema.parse(JSON.parse(row.document)) : null;
  }

  async mutate(mutation: AtomicMutation): Promise<MutationResult> {
    const replay = await this.db
      .prepare("SELECT before_json, after_json FROM audit_history WHERE mutation_id = ?")
      .bind(mutation.mutationId)
      .first<{ before_json: string | null; after_json: string }>();
    if (replay) {
      return {
        before: replay.before_json ? RoadmapItemSchema.parse(JSON.parse(replay.before_json)) : null,
        after: RoadmapItemSchema.parse(JSON.parse(replay.after_json)),
        replayed: true,
      };
    }
    const item = mutation.item;
    const actorJson = JSON.stringify(mutation.actor);
    const document = JSON.stringify(item);
    if (mutation.expectedRevision === null) {
      try {
        await this.db.batch([
          this.db
            .prepare(
              `INSERT INTO roadmap_items (
                id,title,type,area,status,priority,difficulty,revision,created_at,updated_at,
                completed_at,document,actor_json,mutation_id,mutation_action,override_reason
              ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            )
            .bind(
              item.id,
              item.title,
              item.type,
              item.area,
              item.status,
              item.priority,
              item.difficulty,
              item.revision,
              item.createdAt,
              item.updatedAt,
              item.completedAt ?? null,
              document,
              actorJson,
              mutation.mutationId,
              mutation.action,
              mutation.overrideReason ?? null,
            ),
          this.db
            .prepare(
              `INSERT INTO audit_history (
                item_id,revision,mutation_id,action,actor_json,before_json,after_json,override_reason
              ) VALUES (?,?,?,?,?,?,?,?)`,
            )
            .bind(
              item.id,
              item.revision,
              mutation.mutationId,
              mutation.action,
              actorJson,
              null,
              document,
              mutation.overrideReason ?? null,
            ),
          this.db
            .prepare(
              `INSERT INTO sync_jobs (job_key,kind,item_id,payload)
               VALUES (?,?,?,json_object('revision', ?))`,
            )
            .bind(`item:${item.id}:${item.revision}`, "sync_item", item.id, item.revision),
          this.db
            .prepare(
              `INSERT OR IGNORE INTO sync_jobs (job_key,kind,payload)
               VALUES (?,?,'{}')`,
            )
            .bind(`projection:${item.id}:${item.revision}`, "publish_roadmap"),
          this.db
            .prepare(
              `UPDATE discord_submissions
               SET linked_item_id = ?,
                   review_state = IIF(review_state = 'inbox', 'linked', review_state),
                   updated_at = ?
               WHERE thread_id IN (
                 SELECT json_extract(value, '$.threadId')
                 FROM json_each(?, '$.linkedDiscordThreads')
               )`,
            )
            .bind(item.id, item.updatedAt, document),
        ]);
      } catch (error) {
        const replayAfterRace = await this.replay(mutation.mutationId);
        if (replayAfterRace) return replayAfterRace;
        throw error;
      }
      return { before: null, after: item, replayed: false };
    }
    const before = await this.get(item.id);
    const appliesToCurrentMutation = `EXISTS (
      SELECT 1 FROM roadmap_items
      WHERE id = ? AND revision = ? AND mutation_id = ?
    )`;
    const results = await this.db.batch([
      this.db
        .prepare(
          `UPDATE roadmap_items SET
            title=?, type=?, area=?, status=?, priority=?, difficulty=?, revision=?,
            updated_at=?, completed_at=?, document=?, actor_json=?, mutation_id=?,
            mutation_action=?, override_reason=?
          WHERE id=? AND revision=?`,
        )
        .bind(
          item.title,
          item.type,
          item.area,
          item.status,
          item.priority,
          item.difficulty,
          item.revision,
          item.updatedAt,
          item.completedAt ?? null,
          document,
          actorJson,
          mutation.mutationId,
          mutation.action,
          mutation.overrideReason ?? null,
          item.id,
          mutation.expectedRevision,
        ),
      this.db
        .prepare(
          `INSERT INTO audit_history (
            item_id,revision,mutation_id,action,actor_json,before_json,after_json,override_reason
          )
          SELECT ?,?,?,?,?,?,?,?
          WHERE ${appliesToCurrentMutation}`,
        )
        .bind(
          item.id,
          item.revision,
          mutation.mutationId,
          mutation.action,
          actorJson,
          before ? JSON.stringify(before) : null,
          document,
          mutation.overrideReason ?? null,
          item.id,
          item.revision,
          mutation.mutationId,
        ),
      this.db
        .prepare(
          `INSERT INTO sync_jobs (job_key,kind,item_id,payload)
           SELECT ?,?,?,json_object('revision', ?)
           WHERE ${appliesToCurrentMutation}`,
        )
        .bind(
          `item:${item.id}:${item.revision}`,
          "sync_item",
          item.id,
          item.revision,
          item.id,
          item.revision,
          mutation.mutationId,
        ),
      this.db
        .prepare(
          `INSERT OR IGNORE INTO sync_jobs (job_key,kind,payload)
           SELECT ?,?,'{}'
           WHERE ${appliesToCurrentMutation}`,
        )
        .bind(
          `projection:${item.id}:${item.revision}`,
          "publish_roadmap",
          item.id,
          item.revision,
          mutation.mutationId,
        ),
      this.db
        .prepare(
          `UPDATE discord_submissions
           SET linked_item_id = ?,
               review_state = IIF(review_state = 'inbox', 'linked', review_state),
               updated_at = ?
           WHERE ${appliesToCurrentMutation}
             AND thread_id IN (
               SELECT json_extract(value, '$.threadId')
               FROM json_each(?, '$.linkedDiscordThreads')
             )`,
        )
        .bind(item.id, item.updatedAt, item.id, item.revision, mutation.mutationId, document),
    ]);
    if (results[0]?.meta.changes !== 1) {
      const replayAfterRace = await this.replay(mutation.mutationId);
      if (replayAfterRace) return replayAfterRace;
      const current = await this.get(item.id);
      throw new ConflictError(
        `Revision ${mutation.expectedRevision} is no longer current for ${item.id}.`,
        { current },
      );
    }
    return { before, after: item, replayed: false };
  }

  async history(itemId?: string, since?: string, limit = 100): Promise<HistoryEntry[]> {
    const conditions: string[] = [];
    const bindings: Array<string | number> = [];
    if (itemId) {
      conditions.push("item_id = ?");
      bindings.push(itemId);
    }
    if (since) {
      conditions.push("created_at >= ?");
      bindings.push(since);
    }
    bindings.push(Math.min(Math.max(limit, 1), 500));
    const result = await this.db
      .prepare(
        `SELECT * FROM audit_history ${
          conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""
        } ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .bind(...bindings)
      .all<HistoryRow>();
    return result.results.map((row) =>
      HistoryEntrySchema.parse({
        id: String(row.id),
        itemId: row.item_id,
        revision: row.revision,
        mutationId: row.mutation_id,
        action: row.action,
        actor: JSON.parse(row.actor_json),
        before: row.before_json ? JSON.parse(row.before_json) : null,
        after: JSON.parse(row.after_json),
        overrideReason: row.override_reason,
        createdAt: normalizeSqliteTimestamp(row.created_at),
      }),
    );
  }

  async syncStatus() {
    const rows = await this.db
      .prepare(
        `SELECT status, count(*) AS count, max(completed_at) AS last_completed
         FROM sync_jobs GROUP BY status`,
      )
      .all<{ status: string; count: number; last_completed: string | null }>();
    const counts = Object.fromEntries(rows.results.map((row) => [row.status, row.count]));
    const completed = rows.results.find((row) => row.status === "complete");
    return {
      pending: counts.pending ?? 0,
      processing: counts.processing ?? 0,
      failed: counts.failed ?? 0,
      lastSuccessfulAt: completed?.last_completed ?? null,
    };
  }

  private async replay(mutationId: string): Promise<MutationResult | null> {
    const replay = await this.db
      .prepare("SELECT before_json, after_json FROM audit_history WHERE mutation_id = ?")
      .bind(mutationId)
      .first<{ before_json: string | null; after_json: string }>();
    return replay
      ? {
          before: replay.before_json
            ? RoadmapItemSchema.parse(JSON.parse(replay.before_json))
            : null,
          after: RoadmapItemSchema.parse(JSON.parse(replay.after_json)),
          replayed: true,
        }
      : null;
  }
}

function normalizeSqliteTimestamp(value: string): string {
  return new Date(value).toISOString();
}
