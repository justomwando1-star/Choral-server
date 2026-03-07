import express from "express";
import { supabaseAdmin } from "../lib/supabaseServer.js";
import { verifySupabaseToken } from "../middleware/verifySupabaseToken.js";
import {
  REGISTRATION_TYPES,
  ensureActiveRegistrationRegulations,
  getRequiredRegistrationFee,
  findApprovedUnconsumedRegistrationPayment,
  consumeRegistrationPaymentSubmission,
  isMissingRegistrationTablesError,
  missingRegistrationTablesResponse,
} from "../utils/registrationPayments.js";

const router = express.Router();

function normalizeText(value, max = 255) {
  return String(value || "")
    .trim()
    .slice(0, max);
}

function normalizeEmail(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .slice(0, 255);
}

function isMissingEnrollmentsError(err) {
  const code = String(err?.code || "").toUpperCase();
  const message = String(err?.message || "").toLowerCase();
  return (
    code === "42P01" ||
    code === "PGRST204" ||
    code === "PGRST205" ||
    message.includes("enrollments")
  );
}

function missingMigrationResponse(res) {
  return res.status(500).json({
    message:
      "Enrollments table is missing. Run migration 021_create_enrollments_table.sql and retry.",
  });
}

async function resolveDbUser(authUid) {
  if (!authUid) return null;
  const { data, error } = await supabaseAdmin
    .from("users")
    .select("id, email, display_name")
    .eq("auth_uid", authUid)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

router.use(verifySupabaseToken);

// Submit a new enrollment request.
router.post("/", async (req, res) => {
  try {
    const authUid = req.authUid;
    if (!authUid) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const user = await resolveDbUser(authUid);
    if (!user?.id) {
      return res.status(404).json({
        message: "User profile not found. Sign in again and retry.",
      });
    }

    const fullName = normalizeText(
      req.body?.full_name || req.body?.fullName || user.display_name || "",
      160,
    );
    const email = normalizeEmail(req.body?.email || user.email || "");
    const musicClass = normalizeText(
      req.body?.music_class || req.body?.musicClass || "",
      120,
    );
    const skillLevel = normalizeText(
      req.body?.skill_level || req.body?.skillLevel || "",
      32,
    ).toLowerCase();
    const notes = normalizeText(req.body?.notes, 4000) || null;

    if (!fullName) {
      return res.status(400).json({ message: "Full name is required" });
    }
    if (!email) {
      return res.status(400).json({ message: "Email is required" });
    }
    if (!musicClass) {
      return res.status(400).json({ message: "Music class is required" });
    }
    if (!skillLevel) {
      return res.status(400).json({ message: "Skill level is required" });
    }

    const { data: existing, error: existingErr } = await supabaseAdmin
      .from("enrollments")
      .select("id, status, music_class")
      .eq("user_id", user.id)
      .eq("music_class", musicClass)
      .in("status", ["pending", "admitted"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (existingErr) throw existingErr;

    if (existing?.status === "pending") {
      return res.status(409).json({
        message: "You already have a pending enrollment for this class.",
        enrollmentId: existing.id,
        status: existing.status,
      });
    }
    if (existing?.status === "admitted") {
      return res.status(409).json({
        message: "You are already admitted for this class.",
        enrollmentId: existing.id,
        status: existing.status,
      });
    }

    let approvedPayment = null;
    const regulations = await ensureActiveRegistrationRegulations(supabaseAdmin);
    const requiredEnrollmentFee = getRequiredRegistrationFee(
      regulations,
      REGISTRATION_TYPES.ENROLLMENT,
    );

    if (requiredEnrollmentFee > 0) {
      approvedPayment = await findApprovedUnconsumedRegistrationPayment(
        supabaseAdmin,
        user.id,
        REGISTRATION_TYPES.ENROLLMENT,
      );

      if (!approvedPayment?.id) {
        return res.status(402).json({
          code: "REGISTRATION_PAYMENT_REQUIRED",
          message:
            "Enrollment registration fee payment is required before submitting this enrollment.",
          registrationType: REGISTRATION_TYPES.ENROLLMENT,
          requiredFee: requiredEnrollmentFee,
          bankName: regulations.bank_name || "I&M Bank",
          bankAccountNumber:
            regulations.bank_account_number || "0030 7335 5161 50",
          accountName: regulations.account_name || "Murekefu Music Hub",
        });
      }
    }

    const { data: enrollment, error: insertErr } = await supabaseAdmin
      .from("enrollments")
      .insert({
        user_id: user.id,
        full_name: fullName,
        email,
        music_class: musicClass,
        skill_level: skillLevel,
        notes,
        status: "pending",
      })
      .select("*")
      .single();
    if (insertErr) throw insertErr;

    if (approvedPayment?.id) {
      const consumedPayment = await consumeRegistrationPaymentSubmission(
        supabaseAdmin,
        approvedPayment.id,
        REGISTRATION_TYPES.ENROLLMENT,
        enrollment.id,
      );
      if (!consumedPayment?.id) {
        await supabaseAdmin.from("enrollments").delete().eq("id", enrollment.id);
        return res.status(409).json({
          code: "REGISTRATION_PAYMENT_ALREADY_USED",
          message:
            "The approved enrollment payment was already used. Submit a new registration payment and try again.",
        });
      }
    }

    return res.status(201).json({
      success: true,
      message: "Enrollment submitted successfully",
      enrollment,
    });
  } catch (err) {
    console.error("[enrollments-create] Error:", err);
    if (isMissingEnrollmentsError(err)) {
      return missingMigrationResponse(res);
    }
    if (isMissingRegistrationTablesError(err)) {
      return missingRegistrationTablesResponse(res);
    }
    return res.status(500).json({
      message: err?.message || "Failed to submit enrollment",
    });
  }
});

// List enrollments submitted by current user.
router.get("/my", async (req, res) => {
  try {
    const authUid = req.authUid;
    if (!authUid) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const user = await resolveDbUser(authUid);
    if (!user?.id) {
      return res.status(404).json({ message: "User profile not found" });
    }

    const limit = Math.min(
      Math.max(Number(req.query.limit) || 100, 1),
      500,
    );

    const { data, error } = await supabaseAdmin
      .from("enrollments")
      .select(
        "id, full_name, email, music_class, skill_level, notes, status, admitted_by, admitted_at, created_at, updated_at",
      )
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) throw error;

    return res.json(data || []);
  } catch (err) {
    console.error("[enrollments-my] Error:", err);
    if (isMissingEnrollmentsError(err)) {
      return missingMigrationResponse(res);
    }
    return res.status(500).json({
      message: "Failed to fetch enrollments",
      error: err?.message || "UNKNOWN_ERROR",
    });
  }
});

export default router;
