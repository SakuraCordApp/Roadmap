export interface GhUser {
  login: string;
  id: number;
  type: string;
  html_url?: string;
  avatar_url?: string;
}

export interface GhLabel {
  id?: number;
  name: string;
  color?: string;
  description?: string | null;
}

export interface GhMilestone {
  number: number;
  title: string;
  description: string | null;
  state: "open" | "closed";
  due_on: string | null;
  closed_at: string | null;
  open_issues: number;
  closed_issues: number;
  html_url: string;
  updated_at: string;
}

export interface GhIssue {
  id: number;
  node_id: string;
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  state_reason: string | null;
  labels: Array<GhLabel | string>;
  milestone: GhMilestone | null;
  user: GhUser | null;
  author_association?: string;
  type?: { name: string } | null;
  reactions?: { "+1"?: number };
  comments: number;
  html_url: string;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  pull_request?: unknown;
}

export interface GhComment {
  id: number;
  body: string;
  user: GhUser | null;
  author_association: string;
  html_url: string;
  created_at: string;
  updated_at: string;
  performed_via_github_app?: { slug: string } | null;
}

export interface GhPull {
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  merged: boolean;
  merged_at: string | null;
  merge_commit_sha: string | null;
  draft?: boolean;
  html_url: string;
  user: GhUser | null;
  base: { ref: string };
  head: { ref: string; repo: { full_name: string } | null };
}

export interface GhRelease {
  tag_name: string;
  name: string | null;
  prerelease: boolean;
  draft: boolean;
  html_url: string;
  published_at: string | null;
}

export function labelNames(issue: Pick<GhIssue, "labels">): string[] {
  return issue.labels.map((label) => (typeof label === "string" ? label : label.name));
}
