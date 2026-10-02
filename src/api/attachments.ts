import { getThread } from "../db/store";
import { discordClient } from "../discord/threads";
import type { Env } from "../env";

// Report files live in Discord threads. Discord CDN links expire, so GitHub
// issues and the website link here; we resolve a fresh signed URL and redirect.

export async function attachmentRedirect(
  env: Env,
  channelId: string,
  messageId: string,
  attachmentId: string,
): Promise<Response> {
  if (![channelId, messageId, attachmentId].every((id) => /^\d{17,20}$/.test(id))) {
    return new Response("Not found", { status: 404 });
  }
  const cached = await env.DB.prepare(
    "SELECT url,expires_at FROM attachment_cache WHERE attachment_id=? AND channel_id=? AND message_id=?",
  )
    .bind(attachmentId, channelId, messageId)
    .first<{ url: string; expires_at: string }>();
  if (cached && Date.parse(cached.expires_at) - Date.now() > 10 * 60_000) {
    return redirect(cached.url, Date.parse(cached.expires_at));
  }
  if (!(await getThread(env.DB, channelId))) return new Response("Not found", { status: 404 });
  const message = await discordClient(env)
    .get<{ attachments?: Array<{ id: string; url: string; content_type?: string }> }>(
      `/channels/${channelId}/messages/${messageId}`,
    )
    .catch(() => null);
  const attachment = message?.attachments?.find((value) => value.id === attachmentId);
  if (!attachment) return new Response("Not found", { status: 404 });
  const expiresHex = new URL(attachment.url).searchParams.get("ex");
  const expiresAt = expiresHex ? Number.parseInt(expiresHex, 16) * 1000 : Date.now() + 3600_000;
  await env.DB.prepare(
    `INSERT OR REPLACE INTO attachment_cache(attachment_id,channel_id,message_id,url,content_type,expires_at)
     VALUES(?,?,?,?,?,?)`,
  )
    .bind(
      attachmentId,
      channelId,
      messageId,
      attachment.url,
      attachment.content_type ?? null,
      new Date(expiresAt).toISOString(),
    )
    .run();
  return redirect(attachment.url, expiresAt);
}

function redirect(url: string, expiresAt: number): Response {
  const maxAge = Math.max(60, Math.min(3600, Math.floor((expiresAt - Date.now()) / 1000) - 600));
  return new Response(null, {
    status: 302,
    headers: { Location: url, "Cache-Control": `public, max-age=${maxAge}` },
  });
}
