import type { IssueKind, StatusId } from "../config";
import type { IssueRecord } from "../db/store";
import type { Env } from "../env";
import { reportText } from "../report/body";
import { sha256 } from "../util/crypto";

// Duplicate search: bge-m3 embeddings (Workers AI free tier) in Vectorize.
// Calibrated on SakuraCord data: true duplicates score ~0.88, related ~0.68.

const MODEL = "@cf/baai/bge-m3";
export const SIMILAR_THRESHOLD = 0.7;

export async function embed(env: Env, texts: string[]): Promise<number[][]> {
  const result = (await env.AI.run(MODEL as any, { text: texts } as any)) as {
    data?: number[][];
  };
  if (!result.data?.length) throw new Error("Workers AI returned no embeddings.");
  return result.data;
}

export function issueEmbeddingText(issue: Pick<IssueRecord, "title" | "body" | "summary">): string {
  const text = reportText(issue.title, issue.body, 3000);
  return issue.summary ? `${issue.title}\n${issue.summary}\n${text}` : text;
}

export async function indexIssue(env: Env, issue: IssueRecord): Promise<string | null> {
  if (!issue.kind) return null;
  const text = issueEmbeddingText(issue);
  const hash = await sha256(`${text}|${issue.status}|${issue.state}`);
  if (hash === issue.embeddedHash) return hash;
  const [vector] = await embed(env, [text]);
  await env.VECTORIZE.upsert([
    {
      id: String(issue.number),
      values: vector!,
      metadata: { kind: issue.kind, status: issue.status, state: issue.state },
    },
  ]);
  return hash;
}

export interface SimilarIssue {
  number: number;
  score: number;
  kind: IssueKind;
  status: StatusId;
}

export async function similarTo(
  env: Env,
  text: string,
  options: { topK?: number; exclude?: number; minScore?: number } = {},
): Promise<SimilarIssue[]> {
  const [vector] = await embed(env, [text.slice(0, 6000)]);
  const result = await env.VECTORIZE.query(vector!, {
    topK: Math.min(options.topK ?? 8, 20),
    returnMetadata: "all",
  });
  return result.matches
    .map((match) => ({
      number: Number(match.id),
      score: match.score,
      kind: (match.metadata?.kind as IssueKind) ?? "bug",
      status: (match.metadata?.status as StatusId) ?? "new",
    }))
    .filter(
      (match) =>
        match.number !== options.exclude &&
        match.status !== "duplicate" &&
        match.score >= (options.minScore ?? 0),
    );
}
