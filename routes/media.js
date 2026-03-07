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
const COMPOSITION_BACKGROUND_PER_PAGE = 10;

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

function parseVoiceParts(raw) {
  if (!raw) return [];
  return String(raw)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 8);
}

function sanitizePromptText(value, max = 180) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
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

function scoreCompositionBackground(photo) {
  const text = String(photo?.alt || "").toLowerCase();
  const instrumentMatches = countKeywordMatches(text, INSTRUMENT_KEYWORDS);
  const faceMatches = countKeywordMatches(text, FACE_KEYWORDS);
  const neutralMatches = countKeywordMatches(text, [
    "background",
    "texture",
    "stage",
    "concert",
    "music",
    "sheet",
    "notes",
    "choir",
  ]);
  const score = instrumentMatches * 3 + neutralMatches - faceMatches * 2;
  return {
    instrumentMatches,
    faceMatches,
    neutralMatches,
    score,
  };
}

function buildFallbackCompositionQueries({
  title,
  description,
  accompaniment,
  voiceParts,
}) {
  const titleText = sanitizePromptText(title, 120);
  const descriptionText = sanitizePromptText(description, 120);
  const accompanimentText = sanitizePromptText(accompaniment, 60);
  const firstVoicePart = Array.isArray(voiceParts) ? voiceParts[0] || "" : "";

  const queries = [
    `${titleText || "choral composition"} classical music background`,
    `${titleText || "choir music"} concert stage lights`,
    `${accompanimentText || "piano"} sheet music aesthetic`,
    `${firstVoicePart || "choral"} rehearsal music background`,
    `${descriptionText || "inspirational choir"} music poster background`,
  ]
    .map((item) => sanitizePromptText(item, 120))
    .filter(Boolean);

  return [...new Set(queries)].slice(0, 6);
}

async function buildCompositionQueriesWithAI({
  title,
  description,
  language,
  accompaniment,
  voiceParts = [],
}) {
  const openAiKey = String(process.env.OPENAI_API_KEY || "").trim();
  if (!openAiKey) return null;

  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
  const promptPayload = {
    title: sanitizePromptText(title, 120),
    description: sanitizePromptText(description, 240),
    language: sanitizePromptText(language, 40),
    accompaniment: sanitizePromptText(accompaniment, 60),
    voiceParts: Array.isArray(voiceParts) ? voiceParts.slice(0, 6) : [],
  };

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${openAiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0.3,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "Create marketing-friendly visual search prompts for stock photos. Return JSON with keys: shortDescription (string), queries (array of 4 to 6 short landscape-friendly search phrases). Avoid people close-up portraits. Prefer music, stage, instruments, sheet music, textures, atmosphere.",
        },
        {
          role: "user",
          content: JSON.stringify(promptPayload),
        },
      ],
      max_tokens: 420,
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`OpenAI composition prompt failed: ${response.status} ${errorBody}`);
  }

  const payload = await response.json();
  const content = payload?.choices?.[0]?.message?.content || "";
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    const start = content.indexOf("{");
    const end = content.lastIndexOf("}");
    if (start >= 0 && end > start) {
      parsed = JSON.parse(content.slice(start, end + 1));
    } else {
      parsed = null;
    }
  }

  const queries = Array.isArray(parsed?.queries)
    ? parsed.queries
        .map((entry) => sanitizePromptText(entry, 120))
        .filter(Boolean)
        .slice(0, 6)
    : [];
  const shortDescription = sanitizePromptText(parsed?.shortDescription, 180);

  if (queries.length === 0) return null;
  return { queries, shortDescription };
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

router.get("/composition-background", async (req, res) => {
  try {
    const apiKey = process.env.PEXELS_API_KEY;
    if (!apiKey) {
      return res.status(500).json({
        message:
          "PEXELS_API_KEY is not configured on the server. Add it to server/.env.",
      });
    }

    const title = sanitizePromptText(req.query.title, 140);
    const description = sanitizePromptText(req.query.description, 280);
    const language = sanitizePromptText(req.query.language, 40);
    const accompaniment = sanitizePromptText(req.query.accompaniment, 60);
    const voiceParts = parseVoiceParts(req.query.voiceParts);
    const perPage = normalizePerPage(
      req.query.perPage || COMPOSITION_BACKGROUND_PER_PAGE,
    );

    if (!title) {
      return res.status(400).json({
        message: "title query parameter is required",
      });
    }

    let source = "fallback";
    let shortDescription = "";
    let queries = buildFallbackCompositionQueries({
      title,
      description,
      accompaniment,
      voiceParts,
    });

    try {
      const aiPrompt = await buildCompositionQueriesWithAI({
        title,
        description,
        language,
        accompaniment,
        voiceParts,
      });
      if (aiPrompt?.queries?.length) {
        source = "ai+pexels";
        queries = aiPrompt.queries;
        shortDescription = aiPrompt.shortDescription || "";
      }
    } catch (aiErr) {
      console.warn(
        "[media/composition-background] AI prompt failed, using fallback queries:",
        aiErr?.message || aiErr,
      );
    }

    const perQuery = Math.min(
      20,
      Math.max(5, Math.ceil((perPage * 2) / Math.max(queries.length, 1))),
    );
    const settled = await Promise.allSettled(
      queries.map((query) =>
        fetchPexelsQuery({
          query,
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
      return res.json({
        source: `${source}-empty`,
        warning: "Could not fetch background images from Pexels",
        errors: failed.slice(0, 3),
        shortDescription,
        queries,
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
        __meta: scoreCompositionBackground(item),
      }))
      .filter((item) => {
        const { faceMatches, instrumentMatches, neutralMatches } = item.__meta;
        if (faceMatches >= 2 && instrumentMatches + neutralMatches < faceMatches) {
          return false;
        }
        return true;
      })
      .sort((a, b) => b.__meta.score - a.__meta.score);

    const items = scored.slice(0, perPage).map(({ __meta, ...item }) => item);

    return res.json({
      source,
      shortDescription,
      queries,
      ...(failed.length > 0
        ? {
            warning: "Some Pexels queries failed; showing partial results",
            errors: failed.slice(0, 3),
          }
        : {}),
      items,
    });
  } catch (err) {
    console.error("[media/composition-background] error:", err);
    return res.status(500).json({
      message: err?.message || "Failed to fetch composition backgrounds",
      items: [],
    });
  }
});

export default router;
