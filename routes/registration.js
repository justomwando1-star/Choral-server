import express from "express";
import { supabaseAdmin } from "../lib/supabaseServer.js";
import { verifySupabaseToken } from "../middleware/verifySupabaseToken.js";
import {
  REGISTRATION_TYPES,
  ensureActiveRegistrationRegulations,
  getRequiredRegistrationFee,
  isMissingRegistrationTablesError,
  missingRegistrationTablesResponse,
  findApprovedUnconsumedRegistrationPayment,
} from "../utils/registrationPayments.js";

const router = express.Router();

function normalizePaymentRef(rawValue) {
  return String(rawValue || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "");
}

function isValidPaymentRef(paymentRef) {
  return /^[A-Z0-9\-]{6,96}$/.test(String(paymentRef || ""));
}

async function resolveDbUser(authUid) {
  if (!authUid) return null;
  const { data, error } = await supabaseAdmin
    .from("users")
    .select("id, auth_uid, email, display_name")
    .eq("auth_uid", authUid)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

function normalizeRegistrationType(rawType) {
  const value = String(rawType || "")
    .trim()
    .toLowerCase();
  if (value === REGISTRATION_TYPES.ENROLLMENT) {
    return REGISTRATION_TYPES.ENROLLMENT;
  }
  if (
    value === REGISTRATION_TYPES.COMPOSER_REQUEST ||
    value === "composer" ||
    value === "composer-request"
  ) {
    return REGISTRATION_TYPES.COMPOSER_REQUEST;
  }
  return null;
}

router.use(verifySupabaseToken);

router.get("/regulations", async (_req, res) => {
  try {
    const regulations = await ensureActiveRegistrationRegulations(supabaseAdmin);
    return res.json({
      enrollmentFee: Number(regulations.enrollment_fee || 0),
      composerRequestFee: Number(regulations.composer_request_fee || 0),
      bankName: regulations.bank_name || "I&M Bank",
      bankAccountNumber:
        regulations.bank_account_number || "0030 7335 5161 50",
      accountName: regulations.account_name || "Murekefu Music Hub",
      controllingAdminIdentifier:
        regulations.controlling_admin_identifier || "fredrickmakori102",
      updatedAt: regulations.updated_at || null,
    });
  } catch (err) {
    console.error("[registration-regulations] Error:", err);
    if (isMissingRegistrationTablesError(err)) {
      return missingRegistrationTablesResponse(res);
    }
    return res.status(500).json({
      message: err?.message || "Failed to fetch registration regulations",
    });
  }
});

router.get("/payments/my", async (req, res) => {
  try {
    const authUid = req.authUid;
    if (!authUid) return res.status(401).json({ message: "Unauthorized" });

    const user = await resolveDbUser(authUid);
    if (!user?.id) {
      return res.status(404).json({
        message: "User profile not found. Sign in again and retry.",
      });
    }

    const requestedType = normalizeRegistrationType(req.query.type);
    let query = supabaseAdmin
      .from("registration_payment_submissions")
      .select(
        "id, registration_type, amount, payment_ref, status, is_consumed, submitted_at, reviewed_at, admin_notes, consumed_at, consumed_for, consumed_target_id",
      )
      .eq("requester_id", user.id)
      .order("submitted_at", { ascending: false })
      .limit(100);
    if (requestedType) query = query.eq("registration_type", requestedType);

    const { data, error } = await query;
    if (error) throw error;

    return res.json(data || []);
  } catch (err) {
    console.error("[registration-payments-my] Error:", err);
    if (isMissingRegistrationTablesError(err)) {
      return missingRegistrationTablesResponse(res);
    }
    return res.status(500).json({
      message: err?.message || "Failed to fetch registration payments",
    });
  }
});

router.post("/payments/submit", async (req, res) => {
  try {
    const authUid = req.authUid;
    if (!authUid) return res.status(401).json({ message: "Unauthorized" });

    const user = await resolveDbUser(authUid);
    if (!user?.id) {
      return res.status(404).json({
        message: "User profile not found. Sign in again and retry.",
      });
    }

    const registrationType = normalizeRegistrationType(
      req.body?.registrationType || req.body?.registration_type,
    );
    const paymentRef = normalizePaymentRef(
      req.body?.paymentRef || req.body?.payment_ref || req.body?.mpesaCode,
    );

    if (!registrationType) {
      return res.status(400).json({
        message:
          "registrationType must be enrollment or composer_request",
      });
    }

    if (!isValidPaymentRef(paymentRef)) {
      return res.status(400).json({
        message:
          "Invalid payment reference format. Use the exact transaction reference from your bank/M-Pesa confirmation.",
      });
    }

    const regulations = await ensureActiveRegistrationRegulations(supabaseAdmin);
    const requiredFee = getRequiredRegistrationFee(regulations, registrationType);

    if (requiredFee <= 0) {
      return res.status(409).json({
        message:
          "No registration fee is currently configured for this service. Payment submission is not required.",
        registrationType,
        requiredFee,
      });
    }

    const { data: pendingRow, error: pendingErr } = await supabaseAdmin
      .from("registration_payment_submissions")
      .select("id, status")
      .eq("requester_id", user.id)
      .eq("registration_type", registrationType)
      .eq("status", "pending")
      .limit(1)
      .maybeSingle();
    if (pendingErr) throw pendingErr;
    if (pendingRow?.id) {
      return res.status(409).json({
        message: "You already have a pending registration payment submission.",
        submissionId: pendingRow.id,
      });
    }

    const approvedRow = await findApprovedUnconsumedRegistrationPayment(
      supabaseAdmin,
      user.id,
      registrationType,
    );
    if (approvedRow?.id) {
      return res.status(409).json({
        message:
          "You already have an approved registration payment ready for use.",
        submissionId: approvedRow.id,
        status: approvedRow.status,
      });
    }

    const { data: inserted, error: insertErr } = await supabaseAdmin
      .from("registration_payment_submissions")
      .insert({
        requester_id: user.id,
        registration_type: registrationType,
        amount: requiredFee,
        payment_ref: paymentRef,
        status: "pending",
        submitted_at: new Date().toISOString(),
      })
      .select(
        "id, registration_type, amount, payment_ref, status, submitted_at, reviewed_at",
      )
      .maybeSingle();
    if (insertErr) throw insertErr;

    return res.status(201).json({
      success: true,
      message:
        "Registration payment reference submitted. Awaiting admin approval.",
      submission: inserted,
      regulations: {
        enrollmentFee: Number(regulations.enrollment_fee || 0),
        composerRequestFee: Number(regulations.composer_request_fee || 0),
        bankName: regulations.bank_name || "I&M Bank",
        bankAccountNumber:
          regulations.bank_account_number || "0030 7335 5161 50",
        accountName: regulations.account_name || "Murekefu Music Hub",
      },
    });
  } catch (err) {
    console.error("[registration-payments-submit] Error:", err);
    if (isMissingRegistrationTablesError(err)) {
      return missingRegistrationTablesResponse(res);
    }
    if (err?.code === "23505") {
      return res.status(409).json({
        message:
          "A pending registration payment submission already exists for this request.",
      });
    }
    return res.status(500).json({
      message: err?.message || "Failed to submit registration payment",
    });
  }
});

export default router;
