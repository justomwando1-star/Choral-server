import crypto from "crypto";
import express from "express";
import { supabaseAdmin } from "../lib/supabaseServer.js";
import { verifySupabaseToken } from "../middleware/verifySupabaseToken.js";
import { serverError } from "../utils/errors.js";

const router = express.Router();

const MPESA_BUSINESS_NUMBER =
  process.env.MPESA_BUSINESS_NUMBER || "400200";
const MPESA_ACCOUNT_NUMBER =
  process.env.MPESA_ACCOUNT_NO || process.env.MPESA_ACCOUNT_NUMBER || "1131723";
const MPESA_BUSINESS_NAME =
  process.env.MPESA_BUSINESS_NAME || "Murekefu Music Hub";
const MPESA_PAYMENT_URL =
  process.env.MPESA_PAYMENT_URL || "https://paynecta.co.ke/pay/music-hub";

function normalizeMpesaCode(rawCode) {
  return String(rawCode || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "");
}

function isValidMpesaCode(code) {
  // M-Pesa codes are typically uppercase alphanumeric and at least ~8 chars.
  return /^[A-Z0-9]{8,20}$/.test(code);
}

function isMissingPaymentSubmissionsError(err) {
  const code = String(err?.code || "").toUpperCase();
  const message = String(err?.message || "").toLowerCase();
  return (
    code === "42P01" ||
    code === "PGRST204" ||
    code === "PGRST205" ||
    message.includes("payment_submissions")
  );
}

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
    .select("id, auth_uid, email")
    .eq("auth_uid", authUid)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

router.get("/status", verifySupabaseToken, async (req, res) => {
  try {
    const user = await resolveUserByAuthUid(req.authUid);
    if (!user) return res.status(404).json({ message: "User not found" });

    const { data, error } = await supabaseAdmin
      .from("payment_submissions")
      .select(
        `
        id,
        checkout_batch_id,
        composition_id,
        amount,
        mpesa_code,
        status,
        submitted_at,
        reviewed_at,
        admin_notes,
        compositions(title)
      `,
      )
      .eq("buyer_id", user.id)
      .order("submitted_at", { ascending: false })
      .limit(100);

    if (error) throw error;
    return res.json(data || []);
  } catch (err) {
    return serverError(res, err);
  }
});

// POST /api/checkout/submit
// Accepts manual M-Pesa payment details and creates pending submission rows for admin review.
router.post("/submit", verifySupabaseToken, async (req, res) => {
  try {
    const authUid = req.authUid;
    if (!authUid) return res.status(401).json({ message: "Unauthorized" });

    console.log("[checkout-submit] incoming request", {
      authUid,
      itemCount: Array.isArray(req.body?.items) ? req.body.items.length : 0,
      hasMpesaCode: Boolean(req.body?.mpesaCode),
    });

    const mpesaCode = normalizeMpesaCode(req.body?.mpesaCode);
    const rawItems = Array.isArray(req.body?.items) ? req.body.items : [];
    const compositionIds = [
      ...new Set(
        rawItems
          .map((item) => item?.composition_id || item?.compositionId)
          .filter(Boolean),
      ),
    ];

    if (!isValidMpesaCode(mpesaCode)) {
      return res.status(400).json({
        message:
          "Invalid M-Pesa transaction code format. Use the exact code sent by M-Pesa.",
      });
    }

    if (compositionIds.length === 0) {
      return res.status(400).json({
        message: "At least one composition is required for checkout submission",
      });
    }

    const user = await resolveUserByAuthUid(authUid);
    if (!user) return res.status(404).json({ message: "User not found" });

    const { data: compositionRows, error: compositionErr } = await supabaseAdmin
      .from("compositions")
      .select("id, title, price")
      .in("id", compositionIds)
      .eq("deleted", false);
    if (compositionErr) throw compositionErr;

    const compositionById = {};
    (compositionRows || []).forEach((row) => {
      compositionById[row.id] = row;
    });

    const missingCompositionIds = compositionIds.filter(
      (id) => !compositionById[id],
    );
    if (missingCompositionIds.length > 0) {
      return res.status(404).json({
        message: "Some selected compositions were not found",
        missingCompositionIds,
      });
    }

    const purchaseBuyerIds = await resolvePurchaseBuyerIds(user.id);

    const [activePurchasesRes, pendingSubmissionsRes] = await Promise.all([
      supabaseAdmin
        .from("purchases")
        .select("composition_id")
        .in("buyer_id", purchaseBuyerIds)
        .eq("is_active", true)
        .in("composition_id", compositionIds),
      supabaseAdmin
        .from("payment_submissions")
        .select("composition_id")
        .eq("buyer_id", user.id)
        .eq("status", "pending")
        .in("composition_id", compositionIds),
    ]);

    if (activePurchasesRes.error) throw activePurchasesRes.error;
    if (pendingSubmissionsRes.error) throw pendingSubmissionsRes.error;

    const alreadyPurchased = new Set(
      (activePurchasesRes.data || []).map((row) => row.composition_id),
    );
    const alreadyPending = new Set(
      (pendingSubmissionsRes.data || []).map((row) => row.composition_id),
    );

    const eligibleCompositionIds = compositionIds.filter(
      (compositionId) =>
        !alreadyPurchased.has(compositionId) && !alreadyPending.has(compositionId),
    );

    if (eligibleCompositionIds.length === 0) {
      return res.status(409).json({
        message: "All selected items are already purchased or pending approval",
        skipped: {
          alreadyPurchased: [...alreadyPurchased],
          alreadyPending: [...alreadyPending],
        },
      });
    }

    const checkoutBatchId = crypto.randomUUID();
    const rowsToInsert = eligibleCompositionIds.map((compositionId) => ({
      checkout_batch_id: checkoutBatchId,
      buyer_id: user.id,
      composition_id: compositionId,
      amount: Number(compositionById[compositionId].price || 0),
      mpesa_code: mpesaCode,
      status: "pending",
      submitted_at: new Date().toISOString(),
    }));

    const { data: insertedRows, error: insertErr } = await supabaseAdmin
      .from("payment_submissions")
      .insert(rowsToInsert)
      .select(
        "id, checkout_batch_id, composition_id, amount, mpesa_code, status, submitted_at",
      );
    if (insertErr) throw insertErr;

    const totalAmount = rowsToInsert.reduce(
      (sum, row) => sum + Number(row.amount || 0),
      0,
    );

    console.log("[checkout-submit] pending payment submissions created", {
      buyerId: user.id,
      authUid,
      checkoutBatchId,
      submittedCount: insertedRows?.length || 0,
      totalAmount,
    });

    return res.status(201).json({
      success: true,
      checkoutBatchId,
      totalAmount,
      mpesa: {
        businessNumber: MPESA_BUSINESS_NUMBER,
        accountNo: MPESA_ACCOUNT_NUMBER,
        businessName: MPESA_BUSINESS_NAME,
        paymentUrl: MPESA_PAYMENT_URL,
      },
      submitted: insertedRows || [],
      skipped: {
        alreadyPurchased: [...alreadyPurchased],
        alreadyPending: [...alreadyPending],
      },
    });
  } catch (err) {
    console.error("[checkout-submit] failed", err);
    if (isMissingPaymentSubmissionsError(err)) {
      return res.status(500).json({
        message:
          "payment_submissions table is missing. Run migration 014 or 024 and retry.",
      });
    }
    if (err?.code === "23505") {
      return res.status(409).json({
        message:
          "A pending checkout already exists for one or more selected compositions.",
      });
    }
    return serverError(res, err);
  }
});

export default router;

