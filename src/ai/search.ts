import { getIssue } from "../db/store";
import type { Env } from "../env";
import { similarTo } from "./embeddings";

const STOP = new Set(
  "the and for that this with from have when not are was but can its into after before using should would could issue report sakuracord version what happened steps reproduce feature request please".split(
    " ",
  ),
);
export function searchTerms(text: string): string[] {
  return [
    ...new Set(
      (text.toLowerCase().match(/[\p{L}\p{N}_]{3,}/gu) ?? []).filter((word) => !STOP.has(word)),
    ),
  ].slice(0, 20);
}
/** Search both categories and every lifecycle state, even without Vectorize. */
export async function searchReports(
  env: Env,
  text: string,
  options: { limit?: number; exclude?: number } = {},
) {
  const limit = Math.min(options.limit ?? 12, 12);
  const title = text.trim().split("\n", 1)[0]!.trim();
  const terms = searchTerms(text);
  const exact = await env.DB.prepare(
    "SELECT number FROM issues WHERE lower(title)=lower(?) AND status!='duplicate' AND number!=? LIMIT 12",
  )
    .bind(title, options.exclude ?? -1)
    .all<{ number: number }>();
  const lexical = terms.length
    ? await env.DB.prepare(
        `SELECT rowid AS number FROM issue_search WHERE issue_search MATCH ? ORDER BY bm25(issue_search,10,4,1) LIMIT 24`,
      )
        .bind(terms.map((word) => `"${word}"${word.length >= 4 ? "*" : ""}`).join(" OR "))
        .all<{ number: number }>()
    : { results: [] };
  const semantic = await similarTo(env, text, {
    topK: 20,
    exclude: options.exclude,
    minScore: 0.55,
  }).catch((error) => {
    console.error("Semantic search unavailable; using full-text matches", error);
    return [];
  });
  const ranks = new Map<number, { rank: number; score: number }>();
  for (const list of [lexical.results, semantic])
    list.forEach((match, index) => {
      if (match.number === options.exclude) return;
      const previous = ranks.get(match.number) ?? { rank: 0, score: 0 };
      ranks.set(match.number, {
        rank: previous.rank + 1 / (60 + index),
        score: Math.max(previous.score, "score" in match ? Number(match.score) : 0),
      });
    });
  for (const match of exact.results) ranks.set(match.number, { rank: 1, score: 1 });
  const results = [];
  for (const [number, match] of [...ranks].sort((a, b) => b[1].rank - a[1].rank).slice(0, 24)) {
    const issue = await getIssue(env.DB, number);
    if (!issue || issue.status === "duplicate") continue;
    results.push({ issue, score: match.score });
    if (results.length === limit) break;
  }
  return results;
}
