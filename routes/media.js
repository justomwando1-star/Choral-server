import express from "express";

const router = express.Router();

const PEXELS_SEARCH_URL = "https://api.pexels.com/v1/search";
const CACHE_TTL_MS = 30 * 60 * 1000;
const PEXELS_TIMEOUT_MS = 8000;
const DEFAULT_QUERY = "choir music performance";
const DEFAULT_PER_PAGE = 12;
const DEFAULT_MODE = "instruments";
const INSTRUMENT_QUERIES = [
  "piano keys close up",
  "guitar strings close up",
  "drum kit studio",
  "violin on sheet music",
  "trumpet saxophone instruments",
  "music instruments flat lay",
];
const INSTRUMENT_KEYWORDS = [
  "instrument",
  "piano",
  "keyboard",
  "guitar",
  "violin",
  "cello",
  "trumpet",
  "saxophone",
  "drum",
  "percussion",
  "flute",
  "clarinet",
  "sheet music",
  "music stand",
];
const FACE_KEYWORDS = [
  "portrait",
  "face",
  "selfie",
  "headshot",
  "man",
  "woman",
  "boy",
  "girl",
  "person",
  "people",
  "human",
];

let cache = {
  key: "",
  expiresAt: 0,
  items: [],
};
let lastSuccessfulItems = [];

function normalizePerPage(raw) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_PER_PAGE;
  return Math.min(Math.max(Math.floor(value), 4), 20);
}

function getCacheKey(query, perPage) {
  return `${query}|${perPage}`;
}

function normalizeMode(raw) {
  const value = String(raw || "").trim().toLowerCase();
  return value === "mixed" ? "mixed" : DEFAULT_MODE;
}

function parseQueries(raw) {
  if (!raw) return [];
  return String(raw)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function countKeywordMatches(text, keywords) {
  let score = 0;
  for (const keyword of keywords) {
    if (text.includes(keyword)) score += 1;
  }
  return score;
}

function scorePhotoRelevance(photo) {
  const text = String(photo?.alt || "").toLowerCase();
  const instrumentMatches = countKeywordMatches(text, INSTRUMENT_KEYWORDS);
  const faceMatches = countKeywordMatches(text, FACE_KEYWORDS);
  return {
    instrumentMatches,
    faceMatches,
    score: instrumentMatches * 3 - faceMatches * 2,
  };
}

function normalizePhoto(photo) {
  return {
    id: photo.id,
    photographer: photo.photographer || "",
    width: photo.width,
    height: photo.height,
    alt: photo.alt || "",
    src: {
      original: photo?.src?.original || null,
      large2x: photo?.src?.large2x || null,
      large: photo?.src?.large || null,
      medium: photo?.src?.medium || null,
      small: photo?.src?.small || null,
      portrait: photo?.src?.portrait || null,
      landscape: photo?.src?.landscape || null,
    },
    url: photo.url || null,
  };
}

async function fetchPexelsQuery({
  query,
  perPage,
  apiKey,
  timeoutMs = PEXELS_TIMEOUT_MS,
}) {
  const url = new URL(PEXELS_SEARCH_URL);
  url.searchParams.set("query", query);
  url.searchParams.set("per_page", String(perPage));
  url.searchParams.set("orientation", "landscape");
  url.searchParams.set("size", "large");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response;

  try {
    response = await fetch(url.toString(), {
      headers: {
        Authorization: apiKey,
      },
      signal: controller.signal,
    });
  } catch (err) {
    if (err?.name === "AbortError") {
      const timeoutError = new Error(
        `Pexels query timed out (${query}) after ${timeoutMs}ms`,
      );
      timeoutError.code = "PEXELS_TIMEOUT";
      throw timeoutError;
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`Pexels query failed (${query}): ${details}`);
  }

  const payload = await response.json();
  return Array.isArray(payload?.photos)
    ? payload.photos.map((photo) => normalizePhoto(photo))
    : [];
}

router.get("/landing-images", async (req, res) => {
  try {
    const apiKey = process.env.PEXELS_API_KEY;
    if (!apiKey) {
      return res.status(500).json({
        message:
          "PEXELS_API_KEY is not configured on the server. Add it to server/.env.",
      });
    }

    const query = String(req.query.query || DEFAULT_QUERY).trim();
    const perPage = normalizePerPage(req.query.perPage);
    const mode = normalizeMode(req.query.mode);
    const customQueries = parseQueries(req.query.queries);
    const activeQueries =
      customQueries.length > 0
        ? customQueries
        : mode === "instruments"
          ? INSTRUMENT_QUERIES
          : [query];
    const cacheKey = getCacheKey(
      `${query}|${mode}|${activeQueries.join(",")}`,
      perPage,
    );
    const now = Date.now();

    if (cache.key === cacheKey && cache.expiresAt > now && cache.items.length > 0) {
      return res.json({
        source: "cache",
        items: cache.items,
      });
    }

    const perQuery = Math.min(
      20,
      Math.max(6, Math.ceil((perPage * 2) / activeQueries.length)),
    );
    const settled = await Promise.allSettled(
      activeQueries.map((q) =>
        fetchPexelsQuery({
          query: q,
          perPage: perQuery,
          apiKey,
        }),
      ),
    );
    const succeeded = settled
      .filter((result) => result.status === "fulfilled")
      .map((result) => result.value);
    const failed = settled
      .filter((result) => result.status === "rejected")
      .map((result) => result.reason?.message || "Pexels request failed");

    if (succeeded.length === 0) {
      if (cache.key === cacheKey && cache.items.length > 0) {
        return res.json({
          source: "cache-stale",
          mode,
          warning: "Pexels unavailable; serving stale cache",
          errors: failed.slice(0, 3),
          items: cache.items,
        });
      }
      if (lastSuccessfulItems.length > 0) {
        const fallback = lastSuccessfulItems.slice(0, perPage);
        return res.json({
          source: "fallback",
          mode,
          warning: "Pexels unavailable; serving fallback images",
          errors: failed.slice(0, 3),
          items: fallback,
        });
      }
      return res.json({
        source: "fallback-empty",
        mode,
        warning: "Pexels unavailable; no cached images yet",
        errors: failed.slice(0, 3),
        items: [],
      });
    }

    const merged = succeeded.flat();
    const deduped = [];
    const seen = new Set();
    for (const item of merged) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      deduped.push(item);
    }

    const scored = deduped
      .map((item) => ({
        ...item,
        __meta: scorePhotoRelevance(item),
      }))
      .filter((item) => {
        if (mode !== "instruments") return true;
        const { instrumentMatches, faceMatches } = item.__meta;
        if (instrumentMatches === 0) return false;
        if (faceMatches >= 2 && instrumentMatches < faceMatches) return false;
        return true;
      })
      .sort((a, b) => b.__meta.score - a.__meta.score);

    const items = scored.slice(0, perPage).map(({ __meta, ...item }) => item);

    cache = {
      key: cacheKey,
      expiresAt: now + CACHE_TTL_MS,
      items,
    };
    if (items.length > 0) {
      lastSuccessfulItems = items;
    }

    return res.json({
      source: "pexels",
      mode,
      ...(failed.length > 0
        ? {
            warning: "Some Pexels queries failed; showing partial results",
            errors: failed.slice(0, 3),
          }
        : {}),
      items,
    });
  } catch (err) {
    console.error("[media/landing-images] error:", err);
    const mode = normalizeMode(req.query.mode);
    if (cache.items.length > 0) {
      return res.json({
        source: "cache-stale",
        mode,
        warning: err?.message || "Pexels request failed; serving stale cache",
        items: cache.items,
      });
    }
    if (lastSuccessfulItems.length > 0) {
      return res.json({
        source: "fallback",
        mode,
        warning: err?.message || "Pexels request failed; serving fallback images",
        items: lastSuccessfulItems.slice(0, normalizePerPage(req.query.perPage)),
      });
    }
    return res.json({
      source: "fallback-empty",
      mode,
      warning: err?.message || "Failed to load landing images",
      items: [],
    });
  }
});

export default router;
