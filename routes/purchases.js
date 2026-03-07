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

    // Get recommendations using RPC
    const { data, error } = await supabaseAdmin.rpc("get_fyp_recommendations", {
      p_buyer_id: user.id,
      p_limit: Number(limit),
    });

    if (error) throw error;

    return res.json(data || []);
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

    // Update preferences
    const { error } = await supabaseAdmin.from("buyer_preferences").upsert({
      buyer_id: user.id,
      category_id,
      weight,
    });

    if (error) throw error;

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
