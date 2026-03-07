import { supabaseAdmin } from "../lib/supabaseServer.js";

const AVATAR_BUCKET = "avatars";
const DEFAULT_AVATAR_URL_TTL_SECONDS = 24 * 60 * 60;

function resolveAvatarSignedUrlTtlSeconds() {
  const raw = Number.parseInt(process.env.AVATAR_URL_TTL_SECONDS || "", 10);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_AVATAR_URL_TTL_SECONDS;
  return Math.min(raw, 7 * 24 * 60 * 60);
}

export function extractAvatarStoragePath(avatarUrl) {
  if (!avatarUrl) return null;
  const raw = String(avatarUrl).trim();
  if (!raw) return null;

  if (!/^https?:\/\//i.test(raw)) {
    return raw.replace(/^\/+/, "");
  }

  const match = raw.match(
    /\/storage\/v1\/object\/(?:sign|public)\/avatars\/([^?]+)/i,
  );
  if (!match?.[1]) return null;

  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

export async function refreshAvatarUrl(record) {
  if (!record?.avatar_url) return record;

  const storagePath = extractAvatarStoragePath(record.avatar_url);
  if (!storagePath) return record;

  const { data, error } = await supabaseAdmin.storage
    .from(AVATAR_BUCKET)
    .createSignedUrl(storagePath, resolveAvatarSignedUrlTtlSeconds());

  if (error || !data?.signedUrl) {
    console.warn("[avatar-url] Failed to refresh signed URL:", {
      userId: record.id,
      path: storagePath,
      error: error?.message || error || "missing signedUrl",
    });
    return record;
  }

  return {
    ...record,
    avatar_url: data.signedUrl,
  };
}
