import express from "express";
import multer from "multer";
import { PDFParse } from "pdf-parse";
import { supabaseAdmin } from "../lib/supabaseServer.js";
import { verifySupabaseToken } from "../middleware/verifySupabaseToken.js";
import { refreshCompositionPdfUrl, refreshCompositionPdfUrls } from "../utils/compositionPdfUrl.js";

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
});
const ADMIN_IDENTIFIERS = new Set(
  String(process.env.ADMIN_IDENTIFIERS || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean),
);

const DIFFICULTY_OPTIONS = ["Easy", "Intermediate", "Advanced"];
const LANGUAGE_OPTIONS = [
  "English",
  "Latin",
  "German",
  "French",
  "Italian",
  "Spanish",
];
const ACCOMPANIMENT_OPTIONS = [
  "A cappella",
  "Piano",
  "Organ",
  "String Quartet",
  "Orchestra",
];
const VOICE_PART_OPTIONS = [
  "Soprano",
  "Alto",
  "Tenor",
  "Bass",
  "Soprano I",
  "Soprano II",
];
const PRICE_CURRENCY_DEFAULT = "KES";
const CURRENCY_ALIAS_MAP = {
  USD: "USD",
  US: "USD",
  DOLLAR: "USD",
  DOLLARS: "USD",
  "$": "USD",
  US$: "USD",
  KES: "KES",
  KSH: "KES",
  KSHS: "KES",
  SHILLING: "KES",
  SHILLINGS: "KES",
  "KSH.": "KES",
  "KSHS.": "KES",
  EUR: "EUR",
  EURO: "EUR",
  EUROS: "EUR",
  "€": "EUR",
  GBP: "GBP",
  POUND: "GBP",
  POUNDS: "GBP",
  "£": "GBP",
  UGX: "UGX",
  TZS: "TZS",
  RWF: "RWF",
  NGN: "NGN",
  ZAR: "ZAR",
  CAD: "CAD",
  AUD: "AUD",
  INR: "INR",
  JPY: "JPY",
};

function isMissingPriceCurrencyColumnError(err) {
  const code = String(err?.code || "").toUpperCase();
  const message = String(err?.message || "").toLowerCase();
  return (
    code === "42703" ||
    code === "PGRST204" ||
    code === "PGRST205" ||
    message.includes("price_currency")
  );
}

function normalizePriceCurrency(value) {
  void value;
  return PRICE_CURRENCY_DEFAULT;
}

function normalizeAccompanimentInput(value) {
  if (Array.isArray(value)) {
    const uniqueParts = [
      ...new Set(
        value
          .flatMap((item) => String(item || "").split(/[,;|•]/g))
          .map((item) => item.trim())
          .filter(Boolean),
      ),
    ];
    return uniqueParts.length > 0 ? uniqueParts.join(", ") : null;
  }

  const text = String(value || "").trim();
  return text ? text : null;
}

function normalizeCurrencyCode(value) {
  const normalized = String(value || "")
    .trim()
    .toUpperCase();
  if (!normalized) return "";
  return CURRENCY_ALIAS_MAP[normalized] || normalized.slice(0, 8);
}

function sanitizePriceInput(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

function parseAmountLoose(value) {
  if (value === null || value === undefined) return NaN;
  if (typeof value === "number") return Number.isFinite(value) ? value : NaN;
  const text = String(value || "")
    .replace(/,/g, "")
    .trim();
  if (!text) return NaN;
  const match = text.match(/-?\d+(\.\d+)?/);
  if (!match) return NaN;
  const amount = Number.parseFloat(match[0]);
  return Number.isFinite(amount) ? amount : NaN;
}

function detectCurrencyFromText(value) {
  const text = String(value || "")
    .toUpperCase()
    .trim();
  if (!text) return "";

  if (text.includes("KSH") || text.includes("KES")) return "KES";
  if (text.includes("UGX")) return "UGX";
  if (text.includes("TZS")) return "TZS";
  if (text.includes("RWF")) return "RWF";
  if (text.includes("NGN")) return "NGN";
  if (text.includes("ZAR")) return "ZAR";
  if (text.includes("EUR") || text.includes("EURO") || text.includes("€")) {
    return "EUR";
  }
  if (text.includes("GBP") || text.includes("POUND") || text.includes("£")) {
    return "GBP";
  }
  if (text.includes("USD") || text.includes("US$") || text.includes("$")) {
    return "USD";
  }
  return "";
}

async function detectPriceWithAI({ priceInput, currencyHint, amountHint }) {
  const openAiKey = String(process.env.OPENAI_API_KEY || "").trim();
  if (!openAiKey) return null;

  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${openAiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "Extract price and currency from user input. Return JSON with keys: amount (number), currencyCode (3-letter ISO code), confidence (0 to 1).",
        },
        {
          role: "user",
          content: JSON.stringify({
            priceInput: sanitizePriceInput(priceInput),
            currencyHint: sanitizePriceInput(currencyHint),
            amountHint:
              Number.isFinite(Number(amountHint)) && Number(amountHint) > 0
                ? Number(amountHint)
                : null,
          }),
        },
      ],
      max_tokens: 220,
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`OpenAI price parse failed: ${response.status} ${errorBody}`);
  }

  const payload = await response.json();
  const content = payload?.choices?.[0]?.message?.content || "";
  let parsed = null;
  try {
    parsed = JSON.parse(content);
  } catch {
    const start = content.indexOf("{");
    const end = content.lastIndexOf("}");
    if (start >= 0 && end > start) {
      parsed = JSON.parse(content.slice(start, end + 1));
    }
  }

  if (!parsed || typeof parsed !== "object") return null;
  return {
    amount: parseAmountLoose(parsed.amount),
    currencyCode: normalizeCurrencyCode(parsed.currencyCode),
    confidence: Number(parsed.confidence || 0),
  };
}

async function fetchRateToUsd(currencyCode) {
  if (!currencyCode || currencyCode === "USD") return 1;
  const endpoint = `https://open.er-api.com/v6/latest/${encodeURIComponent(currencyCode)}`;
  const response = await fetch(endpoint);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Exchange rate lookup failed (${response.status}): ${body}`);
  }
  const payload = await response.json();
  const rate = Number(payload?.rates?.USD);
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new Error("Exchange rate provider returned invalid USD rate");
  }
  return rate;
}

function parseLimit(raw, fallback = 120, max = 500) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}

function firstNonEmptyLine(text) {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return lines[0] || "";
}

function detectDifficulty(text) {
  const lower = text.toLowerCase();
  if (
    lower.includes("advanced") ||
    lower.includes("virtuoso") ||
    lower.includes("professional")
  ) {
    return "Advanced";
  }
  if (
    lower.includes("intermediate") ||
    lower.includes("moderate") ||
    lower.includes("medium")
  ) {
    return "Intermediate";
  }
  return "Easy";
}

function detectLanguage(text) {
  const lower = text.toLowerCase();

  if (
    /\b(kyrie|gloria|sanctus|agnus|dei|miserere|alleluia|magnificat)\b/.test(
      lower,
    )
  ) {
    return "Latin";
  }
  if (/\b(und|der|die|das|herr|gott|ist)\b/.test(lower)) {
    return "German";
  }
  if (/\b(le|la|les|bonjour|seigneur|dieu)\b/.test(lower)) {
    return "French";
  }
  if (/\b(il|lo|gli|signore|dio|ave)\b/.test(lower)) {
    return "Italian";
  }
  if (/\b(el|la|los|las|dios|se\u00f1or)\b/.test(lower)) {
    return "Spanish";
  }

  return "English";
}

function detectAccompaniment(text) {
  const lower = text.toLowerCase();
  if (lower.includes("a cappella") || lower.includes("acappella")) {
    return "A cappella";
  }
  if (lower.includes("string quartet")) return "String Quartet";
  if (lower.includes("orchestra")) return "Orchestra";
  if (lower.includes("organ")) return "Organ";
  if (lower.includes("piano")) return "Piano";
  return "A cappella";
}

function detectVoiceParts(text) {
  const lower = text.toLowerCase();
  const found = [];

  if (/\bsoprano\s*i\b/.test(lower)) found.push("Soprano I");
  if (/\bsoprano\s*ii\b/.test(lower)) found.push("Soprano II");
  if (/\bsoprano\b/.test(lower) && !found.includes("Soprano"))
    found.push("Soprano");
  if (/\balto\b/.test(lower)) found.push("Alto");
  if (/\btenor\b/.test(lower)) found.push("Tenor");
  if (/\bbass\b/.test(lower)) found.push("Bass");

  if (found.length === 0 && /\bsatb\b/.test(lower)) {
    found.push("Soprano", "Alto", "Tenor", "Bass");
  }

  return found;
}

function detectDuration(text) {
  const match = text.match(/\b([0-5]?\d:[0-5]\d)\b/);
  return match?.[1] || "";
}

function heuristicCompositionMetadata(text) {
  const titleGuess = firstNonEmptyLine(text).slice(0, 120) || "Untitled Composition";
  const voiceParts = detectVoiceParts(text);
  const duration = detectDuration(text);

  return {
    title: titleGuess,
    description:
      "Auto-generated from your uploaded PDF score. Please review and edit before publishing.",
    difficulty: detectDifficulty(text),
    duration,
    language: detectLanguage(text),
    accompaniment: detectAccompaniment(text),
    voiceParts,
  };
}

function normalizeOption(value, options, fallback) {
  const matched = options.find(
    (opt) => opt.toLowerCase() === String(value || "").trim().toLowerCase(),
  );
  return matched || fallback;
}

function normalizeMetadata(raw, fallback) {
  const safe = raw || {};
  const voiceParts = Array.isArray(safe.voiceParts)
    ? safe.voiceParts
        .map((part) => normalizeOption(part, VOICE_PART_OPTIONS, null))
        .filter(Boolean)
    : fallback.voiceParts;

  return {
    title: String(safe.title || fallback.title || "Untitled Composition")
      .trim()
      .slice(0, 255),
    description: String(safe.description || fallback.description || "")
      .trim()
      .slice(0, 1000),
    difficulty: normalizeOption(
      safe.difficulty,
      DIFFICULTY_OPTIONS,
      fallback.difficulty,
    ),
    duration: String(safe.duration || fallback.duration || "")
      .trim()
      .slice(0, 20),
    language: normalizeOption(safe.language, LANGUAGE_OPTIONS, fallback.language),
    accompaniment: normalizeOption(
      safe.accompaniment,
      ACCOMPANIMENT_OPTIONS,
      fallback.accompaniment,
    ),
    voiceParts: [...new Set(voiceParts)].slice(0, 6),
  };
}

async function analyzeMetadataWithAI(rawText) {
  const openAiKey = process.env.OPENAI_API_KEY;
  if (!openAiKey) return null;

  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
  const text = rawText.slice(0, 15000);

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${openAiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "Extract choral composition metadata from score text. Return JSON only with keys: title, description, difficulty, duration, language, accompaniment, voiceParts. difficulty must be one of Easy|Intermediate|Advanced. accompaniment must be one of A cappella|Piano|Organ|String Quartet|Orchestra. language must be one of English|Latin|German|French|Italian|Spanish. voiceParts must be an array using only Soprano|Alto|Tenor|Bass|Soprano I|Soprano II.",
        },
        {
          role: "user",
          content: text,
        },
      ],
      max_tokens: 400,
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`OpenAI request failed: ${response.status} ${errorBody}`);
  }

  const payload = await response.json();
  const content = payload?.choices?.[0]?.message?.content;
  if (!content) return null;

  try {
    return JSON.parse(content);
  } catch {
    const start = content.indexOf("{");
    const end = content.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(content.slice(start, end + 1));
    }
    return null;
  }
}

router.post("/price-to-usd", verifySupabaseToken, async (req, res) => {
  try {
    const priceInput = sanitizePriceInput(req.body?.priceInput || req.body?.price);
    const currencyHint = sanitizePriceInput(req.body?.currencyHint || req.body?.currency);
    const amountHint = parseAmountLoose(req.body?.amount);

    if (!priceInput && !Number.isFinite(amountHint)) {
      return res.status(400).json({
        message: "Provide priceInput (or amount) to convert.",
      });
    }

    let aiResult = null;
    try {
      aiResult = await detectPriceWithAI({
        priceInput,
        currencyHint,
        amountHint,
      });
    } catch (error) {
      console.warn("[price-to-usd] AI detection failed, falling back:", error?.message || error);
    }

    const fallbackCurrency =
      normalizeCurrencyCode(currencyHint) || detectCurrencyFromText(priceInput);
    const detectedCurrency =
      normalizeCurrencyCode(aiResult?.currencyCode) || fallbackCurrency;
    if (!detectedCurrency) {
      return res.status(400).json({
        message:
          "Could not detect currency. Add currency code like USD, KES, EUR, GBP.",
      });
    }

    const detectedAmount = Number.isFinite(aiResult?.amount)
      ? Number(aiResult.amount)
      : Number.isFinite(amountHint)
        ? Number(amountHint)
        : parseAmountLoose(priceInput);
    if (!Number.isFinite(detectedAmount) || detectedAmount <= 0) {
      return res.status(400).json({
        message: "Could not detect a valid positive amount.",
      });
    }

    const rateToUsd = await fetchRateToUsd(detectedCurrency);
    const usdAmount = Number((detectedAmount * rateToUsd).toFixed(2));

    return res.json({
      success: true,
      detectedBy: aiResult ? "ai" : "heuristic",
      aiConfidence:
        Number.isFinite(Number(aiResult?.confidence)) && Number(aiResult.confidence) > 0
          ? Number(aiResult.confidence)
          : null,
      originalAmount: Number(detectedAmount.toFixed(2)),
      originalCurrency: detectedCurrency,
      rateToUsd,
      usdAmount,
      usdCurrency: "USD",
      convertedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error("[price-to-usd] Error:", err);
    return res.status(500).json({
      message: "Failed to convert price to USD",
      error: err?.message || "UNKNOWN_ERROR",
    });
  }
});

router.post(
  "/analyze-pdf",
  verifySupabaseToken,
  upload.single("file"),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ message: "PDF file is required" });
      }

      if (req.file.mimetype !== "application/pdf") {
        return res.status(400).json({ message: "Only PDF files are supported" });
      }

      const parser = new PDFParse({ data: req.file.buffer });
      let extractedText = "";
      try {
        const parsed = await parser.getText();
        extractedText = String(parsed?.text || "").trim();
      } finally {
        await parser.destroy().catch(() => null);
      }

      if (!extractedText) {
        return res.status(422).json({
          message: "Could not extract readable text from this PDF",
        });
      }

      const heuristic = heuristicCompositionMetadata(extractedText);
      let aiMetadata = null;
      let source = "heuristic";

      try {
        aiMetadata = await analyzeMetadataWithAI(extractedText);
        if (aiMetadata) source = "ai";
      } catch (error) {
        console.warn("[analyze-pdf] AI analysis fallback:", error?.message || error);
      }

      const metadata = normalizeMetadata(aiMetadata, heuristic);

      return res.json({
        success: true,
        source,
        metadata,
      });
    } catch (err) {
      console.error("[analyze-pdf] Error:", err);
      return res.status(500).json({ message: "Failed to analyze PDF" });
    }
  },
);

// GET /api/compositions
router.get("/", async (req, res) => {
  try {
    const { category, search, limit } = req.query;
    const safeLimit = parseLimit(limit, 120, 500);

    const baseSelect = `
      id,
      composer_id,
      title,
      description,
      category_id,
      price,
      pdf_url,
      thumbnail_url,
      created_at,
      duration,
      difficulty,
      language,
      accompaniment,
      voice_parts,
      composers(id, users(display_name)),
      categories(name),
      composition_stats(views, purchases)
    `;
    const selectWithPriceCurrency = `
      id,
      composer_id,
      title,
      description,
      category_id,
      price,
      price_currency,
      pdf_url,
      thumbnail_url,
      created_at,
      duration,
      difficulty,
      language,
      accompaniment,
      voice_parts,
      composers(id, users(display_name)),
      categories(name),
      composition_stats(views, purchases)
    `;

    const runQuery = async (includePriceCurrency) => {
      let query = supabaseAdmin
        .from("compositions")
        .select(includePriceCurrency ? selectWithPriceCurrency : baseSelect)
        .eq("is_published", true)
        .eq("deleted", false)
        .order("created_at", { ascending: false })
        .limit(safeLimit);

      if (category) query = query.eq("category_id", category);
      if (search)
        query = query.or(`title.ilike.%${search}%,description.ilike.%${search}%`);

      return await query;
    };

    let { data, error } = await runQuery(true);

    if (error && isMissingPriceCurrencyColumnError(error)) {
      console.warn(
        "[public-compositions] price_currency column missing; retrying without it",
      );
      const fallback = await runQuery(false);
      data = fallback.data;
      error = fallback.error;
      if (!error) {
        data = (data || []).map((row) => ({
          ...row,
          price_currency: PRICE_CURRENCY_DEFAULT,
        }));
      }
    }

    if (error) throw error;

    const compositionsWithFreshPdfUrls = await refreshCompositionPdfUrls(data || []);

    return res.json(compositionsWithFreshPdfUrls);
  } catch (err) {
    console.error("[public-compositions] Error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/compositions/:id
// GET /api/compositions/composer/:composerId - get composer's compositions
router.get("/composer/:composerId", async (req, res) => {
  try {
    const { composerId } = req.params;
    if (!composerId)
      return res.status(400).json({ message: "composerId is required" });

    const { data, error } = await supabaseAdmin
      .from("compositions")
      .select(
        `
        *,
        categories(name),
        composition_stats(views, purchases)
      `,
      )
      .eq("composer_id", composerId)
      .eq("deleted", false)
      .order("created_at", { ascending: false });

    if (error) throw error;

    const composerCompositionsWithFreshPdfUrls =
      await refreshCompositionPdfUrls(data || []);

    return res.json(composerCompositionsWithFreshPdfUrls);
  } catch (err) {
    console.error("[get-composer-compositions] Error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/compositions/:id
router.get("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    if (!id) return res.status(400).json({ message: "id is required" });

    const { data, error } = await supabaseAdmin
      .from("compositions")
      .select(
        `
        *,
        composers(id, users(display_name, email)),
        categories(name),
        composition_stats(views, purchases)
      `,
      )
      .eq("id", id)
      .maybeSingle();

    if (error) throw error;
    if (!data)
      return res.status(404).json({ message: "Composition not found" });

    try {
      await supabaseAdmin.rpc("increment_views", { composition_id: id });
    } catch (e) {
      console.warn(
        "[public-composition] increment_views RPC failed:",
        e?.message || e,
      );
    }

    const compositionWithFreshPdfUrl = await refreshCompositionPdfUrl(data);

    return res.json(compositionWithFreshPdfUrl);
  } catch (err) {
    console.error("[public-composition] Error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/compositions (authenticated)
router.post("/", verifySupabaseToken, async (req, res) => {
  try {
    const {
      title,
      description,
      category_id,
      price,
      price_currency,
      file_url,
      pdf_url,
      thumbnail_url,
      duration_seconds,
      duration,
      difficulty,
      language,
      accompaniment,
      voice_parts,
      composer_id,
    } = req.body;

    console.log("[create-composition] incoming request", {
      authUid: req.authUid || null,
      hasComposerIdInBody: Boolean(composer_id),
      title: title || null,
      price: price ?? null,
      price_currency: normalizePriceCurrency(price_currency),
      hasPdfUrl: Boolean(pdf_url || file_url),
      difficulty: difficulty || null,
      language: language || null,
      accompaniment: normalizeAccompanimentInput(accompaniment),
      voicePartsCount: Array.isArray(voice_parts) ? voice_parts.length : 0,
    });

    let composerId = composer_id || null;

    if (!composerId) {
      const authUid = req.authUid;
      if (!authUid) {
        return res
          .status(400)
          .json({ message: "composer_id is required when auth uid is missing" });
      }

      const { data: userRow, error: userRowErr } = await supabaseAdmin
        .from("users")
        .select("id")
        .eq("auth_uid", authUid)
        .maybeSingle();
      if (userRowErr) throw userRowErr;
      if (!userRow) {
        return res.status(404).json({ message: "User profile not found" });
      }

      const { data: composerRow, error: composerRowErr } = await supabaseAdmin
        .from("composers")
        .select("id")
        .eq("user_id", userRow.id)
        .maybeSingle();
      if (composerRowErr) throw composerRowErr;
      if (!composerRow) {
        console.warn("[create-composition] composer row missing for user", {
          authUid,
          userId: userRow.id,
        });
        return res
          .status(403)
          .json({ message: "Composer profile not found for current user" });
      }

      composerId = composerRow.id;
    }

    if (!title) {
      return res.status(400).json({ message: "title is required" });
    }

    const insertPayload = {
      title,
      description: description || null,
      category_id: category_id || null,
      price: price || 0,
      price_currency: normalizePriceCurrency(price_currency),
      pdf_url: pdf_url || file_url || null,
      thumbnail_url: thumbnail_url || null,
      duration: duration || (duration_seconds ? String(duration_seconds) : null),
      difficulty: difficulty || null,
      language: language || null,
      accompaniment: accompaniment || null,
      voice_parts: Array.isArray(voice_parts) ? voice_parts : null,
      composer_id: composerId,
      created_at: new Date().toISOString(),
    };

    let { data: newComp, error: createErr } = await supabaseAdmin
      .from("compositions")
      .insert(insertPayload)
      .select()
      .single();

    if (createErr && isMissingPriceCurrencyColumnError(createErr)) {
      console.warn(
        "[create-composition] price_currency column missing; retrying without it",
      );
      const { price_currency: _omit, ...fallbackPayload } = insertPayload;
      const fallbackInsert = await supabaseAdmin
        .from("compositions")
        .insert(fallbackPayload)
        .select()
        .single();
      newComp = fallbackInsert.data;
      createErr = fallbackInsert.error;
    }

    if (createErr) throw createErr;
    console.log("[create-composition] insert success", {
      compositionId: newComp.id,
      composerId: composerId,
    });

    try {
      await supabaseAdmin
        .from("composition_stats")
        .insert({ composition_id: newComp.id });
    } catch (e) {
      console.warn(
        "[create-composition] Failed to init stats:",
        e?.message || e,
      );
    }

    return res.status(201).json(newComp);
  } catch (err) {
    console.error("[create-composition] Error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// PUT /api/compositions/:id - update composition (authenticated)
router.put("/:id", verifySupabaseToken, async (req, res) => {
  try {
    const { id } = req.params;
    const {
      title,
      description,
      category_id,
      price,
      price_currency,
      is_published,
      difficulty,
      language,
      duration,
      accompaniment,
      voice_parts,
      pdf_url,
      thumbnail_url,
    } = req.body;

    if (!id) return res.status(400).json({ message: "id is required" });

    const updates = {};
    if (title !== undefined) updates.title = title;
    if (description !== undefined) updates.description = description;
    if (category_id !== undefined) updates.category_id = category_id;
    if (price !== undefined) updates.price = price;
    if (price_currency !== undefined)
      updates.price_currency = normalizePriceCurrency(price_currency);
    if (is_published !== undefined) updates.is_published = is_published;
    if (difficulty !== undefined) updates.difficulty = difficulty || null;
    if (language !== undefined) updates.language = language || null;
    if (duration !== undefined) updates.duration = duration || null;
    if (accompaniment !== undefined) {
      updates.accompaniment = normalizeAccompanimentInput(accompaniment);
    }
    if (voice_parts !== undefined)
      updates.voice_parts = Array.isArray(voice_parts) ? voice_parts : null;
    if (pdf_url !== undefined) updates.pdf_url = pdf_url || null;
    if (thumbnail_url !== undefined) updates.thumbnail_url = thumbnail_url || null;

    let { data, error } = await supabaseAdmin
      .from("compositions")
      .update(updates)
      .eq("id", id)
      .select()
      .maybeSingle();

    if (error && isMissingPriceCurrencyColumnError(error)) {
      console.warn(
        "[update-composition] price_currency column missing; retrying without it",
      );
      const { price_currency: _omit, ...fallbackUpdates } = updates;
      const fallbackUpdate = await supabaseAdmin
        .from("compositions")
        .update(fallbackUpdates)
        .eq("id", id)
        .select()
        .maybeSingle();
      data = fallbackUpdate.data;
      error = fallbackUpdate.error;
    }

    if (error) throw error;
    if (!data)
      return res.status(404).json({ message: "Composition not found" });

    return res.json({ message: "Composition updated", composition: data });
  } catch (err) {
    console.error("[update-composition] Error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// DELETE /api/compositions/:id - delete composition (authenticated)
router.delete("/:id", verifySupabaseToken, async (req, res) => {
  try {
    const { id } = req.params;
    const authUid = req.authUid;
    const hardDelete = String(req.query?.hard || "true").toLowerCase() !== "false";
    if (!id) return res.status(400).json({ message: "id is required" });
    if (!authUid) return res.status(401).json({ message: "Unauthorized" });

    const { data: requester, error: requesterErr } = await supabaseAdmin
      .from("users")
      .select("id, email")
      .eq("auth_uid", authUid)
      .maybeSingle();
    if (requesterErr) throw requesterErr;
    if (!requester?.id) {
      return res.status(404).json({ message: "User profile not found" });
    }

    const { data: composition, error: compositionErr } = await supabaseAdmin
      .from("compositions")
      .select("id, title, deleted, composer_id, composers(user_id)")
      .eq("id", id)
      .maybeSingle();
    if (compositionErr) throw compositionErr;
    if (!composition) {
      return res.status(404).json({ message: "Composition not found" });
    }

    const ownerUserId = Array.isArray(composition.composers)
      ? composition.composers?.[0]?.user_id || null
      : composition.composers?.user_id || null;
    const isOwner = Boolean(ownerUserId && ownerUserId === requester.id);

    let isAdmin = false;
    if (!isOwner) {
      const normalizedEmail = String(requester.email || "").trim().toLowerCase();
      if (normalizedEmail && ADMIN_IDENTIFIERS.has(normalizedEmail)) {
        isAdmin = true;
      } else {
        const { data: roleRows, error: roleErr } = await supabaseAdmin
          .from("user_roles")
          .select("roles(name)")
          .eq("user_id", requester.id);

        if (roleErr) {
          console.warn('[delete-composition] user_roles check failed:', roleErr?.message || roleErr);
        } else {
          isAdmin = (roleRows || []).some(
            (row) => String(row?.roles?.name || "").toLowerCase() === "admin",
          );
        }

        if (!isAdmin && normalizedEmail) {
          const { data: adminEmail, error: adminErr } = await supabaseAdmin
            .from("admin_emails")
            .select("id")
            .ilike("email", normalizedEmail)
            .eq("is_active", true)
            .maybeSingle();

          if (adminErr) {
            console.warn(
              "[delete-composition] admin_emails check failed:",
              adminErr?.message || adminErr,
            );
          } else if (adminEmail) {
            isAdmin = true;
          }
        }
      }
    }

    if (!isOwner && !isAdmin) {
      return res.status(403).json({ message: "Forbidden" });
    }

    let hard = false;
    if (hardDelete) {
      const { error: hardErr } = await supabaseAdmin
        .from("compositions")
        .delete()
        .eq("id", id);

      if (!hardErr) {
        hard = true;
      } else {
        const fkBlocked =
          String(hardErr?.code || "") === "23503" ||
          String(hardErr?.message || "")
            .toLowerCase()
            .includes("foreign key");

        if (!fkBlocked) throw hardErr;

        console.warn(
          "[delete-composition] hard delete blocked by FK; applying soft delete:",
          hardErr?.message || hardErr,
        );
      }
    }

    if (!hard) {
      const { error: softErr } = await supabaseAdmin
        .from("compositions")
        .update({ deleted: true, is_published: false })
        .eq("id", id);

      if (softErr) throw softErr;
    }

    // Revoke access for all buyers who previously purchased this composition.
    const { error: revokeErr } = await supabaseAdmin
      .from("purchases")
      .update({ is_active: false })
      .eq("composition_id", id)
      .eq("is_active", true);

    if (revokeErr) {
      console.warn(
        "[delete-composition] failed to deactivate purchases:",
        revokeErr?.message || revokeErr,
      );
    }

    return res.json({
      message: hard ? "Composition deleted from database" : "Composition soft-deleted",
      hard,
    });
  } catch (err) {
    console.error("[delete-composition] Error:", err);
    return res.status(500).json({ error: err.message });
  }
});

export default router;


