export function isValidAvatarUrl(url) {
  if (!url) return true;
  if (typeof url !== "string") return false;

  const normalized = url.trim();
  if (!normalized) return true;

  if (normalized.startsWith("blob:")) return false;
  return normalized.includes("supabase.co/storage/");
}

function encodePath(path) {
  return String(path || "")
    .split("/")
    .filter(Boolean)
    .map((segment) => {
      try {
        return encodeURIComponent(decodeURIComponent(segment));
      } catch {
        return encodeURIComponent(segment);
      }
    })
    .join("/");
}

export function normalizeSupabaseAvatarUrl(url) {
  if (!url || typeof url !== "string") return null;
  const raw = url.trim();
  if (!raw) return null;

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return raw;
  }

  const signMarker = "/storage/v1/object/sign/";
  const publicMarker = "/storage/v1/object/public/";

  if (parsed.pathname.includes(signMarker)) {
    const bucketAndPath = parsed.pathname.split(signMarker)[1] || "";
    let decodedBucketAndPath = bucketAndPath;
    try {
      decodedBucketAndPath = decodeURIComponent(bucketAndPath);
    } catch {
      decodedBucketAndPath = bucketAndPath;
    }

    if (!decodedBucketAndPath.startsWith("avatars/")) {
      return raw;
    }

    const relativePath = decodedBucketAndPath.slice("avatars/".length);
    const encodedRelativePath = encodePath(relativePath);

    parsed.pathname = `/storage/v1/object/public/avatars/${encodedRelativePath}`;
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  }

  if (parsed.pathname.includes(`${publicMarker}avatars/`)) {
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  }

  return raw;
}

export function normalizeAvatarUrl(value) {
  if (!value) return null;
  const normalized = normalizeSupabaseAvatarUrl(value);
  return normalized || null;
}

export function withNormalizedAvatar(record) {
  if (!record || typeof record !== "object") return record;
  if (!Object.prototype.hasOwnProperty.call(record, "avatar_url")) return record;

  return {
    ...record,
    avatar_url: normalizeAvatarUrl(record.avatar_url),
  };
}
