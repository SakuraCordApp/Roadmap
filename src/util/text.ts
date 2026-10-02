export function truncate(value: string, maximum: number): string {
  const trimmed = value.trim();
  return trimmed.length <= maximum ? trimmed : `${trimmed.slice(0, maximum - 1).trimEnd()}…`;
}

/** Escape user text for Discord markdown without mangling ordinary punctuation. */
export function escapeDiscord(value: string): string {
  return value
    .replace(/([\\*_~`|>])/g, "\\$1")
    .replace(/@(everyone|here)/gi, "@\u200b$1")
    .replace(/<(@[!&]?|#)(\d+)>/g, "<\u200b$1$2>")
    .replace(/^(#{1,3}\s)/gm, "\\$1")
    .replace(/^(-#\s)/gm, "\\$1");
}

/** Light conversion of GitHub markdown for display inside a Discord message. */
export function githubToDiscord(markdown: string, maximum: number): string {
  const cleaned = markdown
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<\/?(details|summary|sub|sup|br|p)[^>]*>/gi, "")
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, "[$1]($2)")
    .replace(/^#{4,6}\s+/gm, "### ")
    .replace(/@everyone|@here/gi, (match) => match.replace("@", "@\u200b"))
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return truncate(cleaned, maximum);
}

export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}
