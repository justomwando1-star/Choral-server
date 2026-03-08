import express from "express";
import { supabaseAdmin } from "../lib/supabaseServer.js";
import { verifySupabaseToken } from "../middleware/verifySupabaseToken.js";
import { refreshCompositionPdfUrl } from "../utils/compositionPdfUrl.js";

const router = express.Router();

function isMissingBuyersTableError(err) {
  const code = String(err?.code || "").toUpperCase();
  const message = String(err?.message || "").toLowerCase();
  return (
    code === "42P01" ||
    code === "PGRST204" ||
    code === "PGRST205" ||
    message.includes("could not find the table 'buyers'") ||
    message.includes('relation "buyers" does not exist')
  );
}

function isMissingBuyerPreferencesTableError(err) {
  const code = String(err?.code || "").toUpperCase();
  const message = String(err?.message || "").toLowerCase();
  return (
    code === "42P01" ||
    code === "PGRST204" ||
    code === "PGRST205" ||
    message.includes("buyer_preferences") ||
    message.includes('relation "buyer_preferences" does not exist')
  );
}

function isMissingRecommendationRpcError(err) {
  const code = String(err?.code || "").toUpperCase();
  const message = String(err?.message || "").toLowerCase();
  return (
    code === "42883" ||
    code === "PGRST202" ||
    message.includes("get_fyp_recommendations") ||
    message.includes("function") && message.includes("does not exist")
  );
}

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

function parseSafeLimit(raw, fallback = 20, max = 50) {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), max);
}

async function resolvePurchaseBuyerIds(userId) {
  const ids = [userId];

  const { data, error } = await supabaseAdmin
    .from("buyers")
    .select("id")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    if (isMissingBuyersTableError(error)) return ids;
    throw error;
  }

  if (data?.id && !ids.includes(data.id)) ids.push(data.id);
  return ids;
}
async function resolveUserByAuthUid(authUid) {
  const { data, error } = await supabaseAdmin
    .from("users")
    .select("id")
    .eq("auth_uid", authUid)
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

function buildSafePdfFilename(title) {
  const cleaned = String(title || "composition")
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "")
    .replace(/\s+/g, " ")
    .slice(0, 120);
  const base = cleaned || "composition";
  return base.toLowerCase().endsWith(".pdf") ? base : `${base}.pdf`;
}

function appendDownloadQuery(url, fileName) {
  if (!url) return null;
  const separator = String(url).includes("?") ? "&" : "?";
  return `${url}${separator}download=${encodeURIComponent(fileName)}`;
}

async function hydrateRecommendationRows(rows) {
  return await Promise.all(
    (rows || []).map(async (row) => {
      if (!row?.pdf_url) return row;
      const refreshed = await refreshCompositionPdfUrl(row);
      return {
        ...row,
        ...refreshed,
      };
    }),
  );
}

async function fetchFallbackRecommendations(userId, limit) {
  const safeLimit = parseSafeLimit(limit, 20, 50);
  const purchaseBuyerIds = await resolvePurchaseBuyerIds(userId);
  const purchasedCompositionIds = new Set();
  const prioritizedCategoryIds = [];
  const categoryPrioritySeen = new Set();

  const addCategoryPriority = (value) => {
    const categoryId = Number(value);
    if (!Number.isFinite(categoryId) || categoryPrioritySeen.has(categoryId)) {
      return;
    }
    categoryPrioritySeen.add(categoryId);
    prioritizedCategoryIds.push(categoryId);
  };

  const { data: preferenceRows, error: preferenceError } = await supabaseAdmin
    .from("buyer_preferences")
    .select("category_id, weight")
    .in("buyer_id", purchaseBuyerIds)
    .order("weight", { ascending: false })
    .limit(20);

  if (preferenceError) {
    if (isMissingBuyerPreferencesTableError(preferenceError)) {
      console.warn(
        "[recommendations:fallback] buyer_preferences missing; using purchase history only",
      );
    } else {
      throw preferenceError;
    }
  } else {
    (preferenceRows || []).forEach((row) => addCategoryPriority(row?.category_id));
  }

  const { data: purchaseRows, error: purchaseError } = await supabaseAdmin
    .from("purchases")
    .select(
      `
      composition_id,
      compositions(category_id)
    `,
    )
    .in("buyer_id", purchaseBuyerIds)
    .eq("is_active", true)
    .order("purchased_at", { ascending: false })
    .limit(250);

  if (purchaseError) throw purchaseError;

  (purchaseRows || []).forEach((row) => {
    if (row?.composition_id) {
      purchasedCompositionIds.add(row.composition_id);
    }
    addCategoryPriority(row?.compositions?.category_id);
  });

  const baseSelectColumns = `
    id,
    title,
    description,
    price,
    difficulty,
    duration,
    language,
    accompaniment,
    voice_parts,
    pdf_url,
    created_at,
    category_id,
    composers(users(display_name)),
    categories(name),
    composition_stats(views, purchases)
  `;
  const selectColumnsWithPriceCurrency = `
    id,
    title,
    description,
    price,
    price_currency,
    difficulty,
    duration,
    language,
    accompaniment,
    voice_parts,
    pdf_url,
    created_at,
    category_id,
    composers(users(display_name)),
    categories(name),
    composition_stats(views, purchases)
  `;

  const fetchRows = async (categoryIds = null, includePriceCurrency = true) => {
    let query = supabaseAdmin
      .from("compositions")
      .select(
        includePriceCurrency ? selectColumnsWithPriceCurrency : baseSelectColumns,
      )
      .eq("is_published", true)
      .eq("deleted", false)
      .order("created_at", { ascending: false })
      .limit(Math.max(safeLimit * 4, 24));

    if (Array.isArray(categoryIds) && categoryIds.length > 0) {
      query = query.in("category_id", categoryIds);
    }

    const { data, error } = await query;
    if (error && includePriceCurrency && isMissingPriceCurrencyColumnError(error)) {
      console.warn(
        "[recommendations:fallback] price_currency column missing; retrying without it",
      );
      const fallback = await fetchRows(categoryIds, false);
      return (fallback || []).map((row) => ({
        ...row,
        price_currency: "KES",
      }));
    }
    if (error) throw error;
    return data || [];
  };

  const preferredRows =
    prioritizedCategoryIds.length > 0
      ? await fetchRows(prioritizedCategoryIds)
      : [];
  const recentRows = await fetchRows();

  const categoryPriority = new Map(
    prioritizedCategoryIds.map((categoryId, index) => [categoryId, index]),
  );
  const mergedRows = [...preferredRows, ...recentRows];
  const seenCompositionIds = new Set();

  const filteredRows = mergedRows
    .filter((row) => {
      if (!row?.id || purchasedCompositionIds.has(row.id)) return false;
      if (seenCompositionIds.has(row.id)) return false;
      seenCompositionIds.add(row.id);
      return true;
    })
    .sort((a, b) => {
      const aCategoryPriority = categoryPriority.has(Number(a?.category_id))
        ? categoryPriority.get(Number(a.category_id))
        : Number.MAX_SAFE_INTEGER;
      const bCategoryPriority = categoryPriority.has(Number(b?.category_id))
        ? categoryPriority.get(Number(b.category_id))
        : Number.MAX_SAFE_INTEGER;

      if (aCategoryPriority !== bCategoryPriority) {
        return aCategoryPriority - bCategoryPriority;
      }

      const aStats = Array.isArray(a?.composition_stats)
        ? a.composition_stats[0]
        : a?.composition_stats || {};
      const bStats = Array.isArray(b?.composition_stats)
        ? b.composition_stats[0]
        : b?.composition_stats || {};

      const aPurchases = Number(aStats?.purchases || 0);
      const bPurchases = Number(bStats?.purchases || 0);
      if (aPurchases !== bPurchases) return bPurchases - aPurchases;

      const aViews = Number(aStats?.views || 0);
      const bViews = Number(bStats?.views || 0);
      if (aViews !== bViews) return bViews - aViews;

      return (
        new Date(b?.created_at || 0).getTime() -
        new Date(a?.created_at || 0).getTime()
      );
    })
    .slice(0, safeLimit);

  return await hydrateRecommendationRows(filteredRows);
}


// GET /api/purchases - get buyer's purchases by auth UID
router.get("/", verifySupabaseToken, async (req, res) => {
  try {
    const authUid = req.authUid;
    if (!authUid) {
      return res
        .status(400)
        .json({ message: "authUid is required (from token)" });
    }

    // First resolve auth UID to supabase user id
    const { data: user, error: userError } = await supabaseAdmin
      .from("users")
      .select("id")
      .eq("auth_uid", authUid)
      .maybeSingle();

    if (userError) throw userError;
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const purchaseBuyerIds = await resolvePurchaseBuyerIds(user.id);

    // Fetch purchases with composition and related info (supports users.id and buyers.id references)
    const { data: purchases, error: purchasesError } = await supabaseAdmin
      .from("purchases")
      .select(
        `
        *,
        compositions(
          *,
          composers(user_id),
          categories(name)
        )
      `,
      )
      .in("buyer_id", purchaseBuyerIds)
      .eq("is_active", true)
      .order("purchased_at", { ascending: false });

    if (purchasesError) throw purchasesError;

    const purchasesWithFreshPdfUrls = await Promise.all(
      (purchases || []).map(async (purchase) => {
        const composition = purchase?.compositions || purchase?.composition || null;
        if (!composition?.pdf_url) return purchase;

        const refreshedComposition = await refreshCompositionPdfUrl(composition);

        return {
          ...purchase,
          compositions: refreshedComposition,
          composition: refreshedComposition,
        };
      }),
    );

    return res.json(purchasesWithFreshPdfUrls);
  } catch (err) {
    console.error("[get-purchases] Error:", err);
    return res.status(500).json({
      message: "Failed to fetch purchases",
      error: err.message,
    });
  }
});

// GET /api/purchases/:id/download - get a fresh signed download URL for an authorized purchase
router.get("/:id/download", verifySupabaseToken, async (req, res) => {
  try {
    const { id: purchaseId } = req.params;
    const authUid = req.authUid;

    if (!authUid) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    if (!purchaseId) {
      return res.status(400).json({ message: "Purchase id is required" });
    }

    const user = await resolveUserByAuthUid(authUid);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const purchaseBuyerIds = await resolvePurchaseBuyerIds(user.id);

    const { data: purchase, error: purchaseError } = await supabaseAdmin
      .from("purchases")
      .select(
        `
        id,
        buyer_id,
        composition_id,
        is_active,
        purchased_at,
        compositions(
          id,
          title,
          pdf_url
        )
      `,
      )
      .eq("id", purchaseId)
      .in("buyer_id", purchaseBuyerIds)
      .eq("is_active", true)
      .maybeSingle();

    if (purchaseError) throw purchaseError;

    if (!purchase) {
      return res.status(404).json({
        message: "Authorized purchase not found",
      });
    }

    let composition = purchase?.compositions || null;

    if (!composition && purchase?.composition_id) {
      const { data: compositionRow, error: compositionError } = await supabaseAdmin
        .from("compositions")
        .select("id, title, pdf_url")
        .eq("id", purchase.composition_id)
        .maybeSingle();
      if (compositionError) throw compositionError;
      composition = compositionRow || null;
    }

    if (!composition?.pdf_url) {
      return res.status(404).json({
        message: "Composition PDF not available for this purchase",
      });
    }

    const refreshedComposition = await refreshCompositionPdfUrl(composition);
    if (!refreshedComposition?.pdf_url) {
      return res.status(500).json({
        message: "Failed to generate secure download URL",
      });
    }

    const fileName = buildSafePdfFilename(
      refreshedComposition.title || composition.title || "composition",
    );
    const downloadUrl = appendDownloadQuery(refreshedComposition.pdf_url, fileName);

    return res.json({
      purchaseId: purchase.id,
      compositionId: refreshedComposition.id || composition.id || purchase.composition_id,
      fileName,
      downloadUrl,
    });
  } catch (err) {
    console.error("[download-purchase-composition] Error:", err);
    return res.status(500).json({
      message: "Failed to generate download link",
      error: err.message,
    });
  }
});
// POST /api/purchases - create a purchase
router.post("/", verifySupabaseToken, async (req, res) => {
  try {
    const { composition_id, price_paid, payment_ref } = req.body;
    const authUid = req.authUid;

    if (!authUid || !composition_id || !price_paid) {
      return res.status(400).json({
        message:
          "authUid (from token), composition_id, and price_paid are required",
      });
    }

    // Resolve auth UID to supabase user id
    const { data: user, error: userError } = await supabaseAdmin
      .from("users")
      .select("id")
      .eq("auth_uid", authUid)
      .maybeSingle();

    if (userError) throw userError;
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // Create purchase using RPC function
    const { data, error } = await supabaseAdmin.rpc("purchase_composition", {
      p_buyer_id: user.id,
      p_composition_id: composition_id,
      p_price_paid: price_paid,
      p_payment_ref: payment_ref || null,
    });

    if (error) throw error;

    return res.status(201).json({
      message: "Purchase created",
      purchase: data,
    });
  } catch (err) {
    console.error("[create-purchase] Error:", err);
    return res.status(500).json({
      message: "Failed to create purchase",
      error: err.message,
    });
  }
});

// DELETE /api/purchases/:id - discard/refund a purchase
router.delete("/:id", verifySupabaseToken, async (req, res) => {
  try {
    const { id } = req.params;
    if (!id) {
      return res.status(400).json({ message: "Purchase id is required" });
    }

    // Discard purchase using RPC function
    const { error } = await supabaseAdmin.rpc("discard_purchase", {
      p_purchase_id: id,
    });

    if (error) throw error;

    return res.json({ message: "Purchase discarded" });
  } catch (err) {
    console.error("[discard-purchase] Error:", err);
    return res.status(500).json({
      message: "Failed to discard purchase",
      error: err.message,
    });
  }
});

// GET /api/purchases/recommendations - get FYP recommendations
router.get("/recommendations", verifySupabaseToken, async (req, res) => {
  try {
    const { limit = 20 } = req.query;
    const safeLimit = parseSafeLimit(limit, 20, 50);
    const authUid = req.authUid;

    if (!authUid) {
      return res.status(400).json({ message: "authUid is required" });
    }

    // Resolve auth UID to supabase user id
    const { data: user, error: userError } = await supabaseAdmin
      .from("users")
      .select("id")
      .eq("auth_uid", authUid)
      .maybeSingle();

    if (userError) throw userError;
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const purchaseBuyerIds = await resolvePurchaseBuyerIds(user.id);
    const recommendationOwnerId =
      purchaseBuyerIds.find((id) => id !== user.id) || user.id;

    const { data, error } = await supabaseAdmin.rpc("get_fyp_recommendations", {
      p_buyer_id: recommendationOwnerId,
      p_limit: safeLimit,
    });

    if (error) {
      if (!isMissingRecommendationRpcError(error)) throw error;
      console.warn(
        "[get-recommendations] recommendation RPC missing; using fallback query",
      );
      const fallbackRows = await fetchFallbackRecommendations(user.id, safeLimit);
      return res.json(fallbackRows);
    }

    const rows = Array.isArray(data) ? data : [];
    if (rows.length === 0) {
      const fallbackRows = await fetchFallbackRecommendations(user.id, safeLimit);
      return res.json(fallbackRows);
    }

    const hydratedRows = await hydrateRecommendationRows(rows);
    return res.json(hydratedRows);
  } catch (err) {
    console.error("[get-recommendations] Error:", err);
    return res.status(500).json({
      message: "Failed to fetch recommendations",
      error: err.message,
    });
  }
});

// PUT /api/purchases/preferences - update buyer preferences
router.put("/preferences", verifySupabaseToken, async (req, res) => {
  try {
    const { category_id, weight } = req.body;
    const authUid = req.authUid;

    if (!authUid || !category_id || weight === undefined) {
      return res.status(400).json({
        message:
          "authUid (from token), category_id, and weight are required",
      });
    }

    // Resolve auth UID to supabase user id
    const { data: user, error: userError } = await supabaseAdmin
      .from("users")
      .select("id")
      .eq("auth_uid", authUid)
      .maybeSingle();

    if (userError) throw userError;
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const { error } = await supabaseAdmin.from("buyer_preferences").upsert(
      {
        buyer_id: user.id,
        category_id,
        weight,
      },
      {
        onConflict: "buyer_id,category_id",
      },
    );

    if (error) {
      if (isMissingBuyerPreferencesTableError(error)) {
        return res.status(503).json({
          message:
            "Buyer preferences storage is not available yet. Apply the buyer preferences migration first.",
        });
      }
      throw error;
    }

    return res.json({ message: "Preferences updated" });
  } catch (err) {
    console.error("[update-preferences] Error:", err);
    return res.status(500).json({
      message: "Failed to update preferences",
      error: err.message,
    });
  }
});

export default router;
