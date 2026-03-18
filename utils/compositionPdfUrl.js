import { supabaseAdmin } from "../lib/supabaseServer.js";

const COMPOSITION_BUCKET = "compositions";
const DEFAULT_SIGNED_URL_TTL_SECONDS = 24 * 60 * 60;

function resolveSignedUrlTtlSeconds() {
  const raw = Number.parseInt(
    process.env.COMPOSITION_PDF_URL_TTL_SECONDS || "",
    10,
  );
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_SIGNED_URL_TTL_SECONDS;
  return Math.min(raw, 7 * 24 * 60 * 60);
}

export function extractCompositionStoragePath(pdfUrl) {
  if (!pdfUrl) return null;
  const raw = String(pdfUrl).trim();
  if (!raw) return null;

  if (!/^https?:\/\//i.test(raw)) {
    return raw.replace(/^\/+/, "");
  }

  const match = raw.match(
    /\/storage\/v1\/object\/(?:sign|public)\/compositions\/([^?]+)/i,
  );
  if (!match?.[1]) return null;

  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

async function refreshSignedUrlForField(composition, field) {
  if (!composition?.[field]) return composition;

  const storagePath = extractCompositionStoragePath(composition[field]);
  if (!storagePath) return composition;

  const { data, error } = await supabaseAdmin.storage
    .from(COMPOSITION_BUCKET)
    .createSignedUrl(storagePath, resolveSignedUrlTtlSeconds());

  if (error || !data?.signedUrl) {
    console.warn("[composition-file] Failed to refresh signed URL:", {
      compositionId: composition.id,
      field,
      path: storagePath,
      error: error?.message || error || "missing signedUrl",
    });
    return composition;
  }

  return {
    ...composition,
    [field]: data.signedUrl,
  };
}

export async function refreshCompositionPdfUrl(composition) {
  let updated = composition;
  updated = await refreshSignedUrlForField(updated, "pdf_url");
  updated = await refreshSignedUrlForField(updated, "midi_url");
  return updated;
}

export async function refreshCompositionPdfUrls(compositions) {
  const list = Array.isArray(compositions) ? compositions : [];
  if (list.length === 0) return list;

  return await Promise.all(
    list.map((composition) => refreshCompositionPdfUrl(composition)),
  );
}
