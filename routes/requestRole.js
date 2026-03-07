// routes/requestRole.js
import express from "express";
import { verifySupabaseToken } from "../middleware/verifySupabaseToken.js";
import { supabaseAdmin } from "../lib/supabaseServer.js";
import { serverError } from "../utils/errors.js";
import {
  REGISTRATION_TYPES,
  ensureActiveRegistrationRegulations,
  getRequiredRegistrationFee,
  findApprovedUnconsumedRegistrationPayment,
  consumeRegistrationPaymentSubmission,
  isMissingRegistrationTablesError,
} from "../utils/registrationPayments.js";

const router = express.Router();
const ADMIN_IDENTIFIERS = new Set(
  String(process.env.ADMIN_IDENTIFIERS || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean),
);

async function resolveUserRoles(userId, email) {
  const roles = ["buyer"];

  const { data: roleRows, error: roleRowsErr } = await supabaseAdmin
    .from("user_roles")
    .select("roles(name)")
    .eq("user_id", userId);
  if (roleRowsErr) throw roleRowsErr;

  (roleRows || []).forEach((row) => {
    const roleName = row.roles?.name;
    if (roleName && !roles.includes(roleName)) roles.push(roleName);
  });

  const { data: composerRow, error: composerErr } = await supabaseAdmin
    .from("composers")
    .select("id")
    .eq("user_id", userId)
    .maybeSingle();
  if (composerErr) throw composerErr;
  if (composerRow && !roles.includes("composer")) roles.push("composer");

  const normalizedEmail = String(email || "")
    .trim()
    .toLowerCase();
  if (normalizedEmail && ADMIN_IDENTIFIERS.has(normalizedEmail)) {
    if (!roles.includes("admin")) roles.push("admin");
  } else if (normalizedEmail) {
    const { data: adminEmail, error: adminEmailErr } = await supabaseAdmin
      .from("admin_emails")
      .select("id")
      .ilike("email", normalizedEmail)
      .eq("is_active", true)
      .maybeSingle();
    if (adminEmailErr) throw adminEmailErr;
    if (adminEmail && !roles.includes("admin")) roles.push("admin");
  }

  return roles;
}

/**
 * GET /api/request-role/status
 * Returns current role request statuses for the authenticated user.
 */
router.get("/request-role/status", verifySupabaseToken, async (req, res) => {
  try {
    const authUid = req.authUid;

    const { data: userRow, error: userErr } = await supabaseAdmin
      .from("users")
      .select("id, email")
      .eq("auth_uid", authUid)
      .maybeSingle();

    if (userErr) throw userErr;
    if (!userRow) return res.status(404).json({ message: "User not found" });

    const roles = await resolveUserRoles(userRow.id, userRow.email);

    const { data: requests, error: reqErr } = await supabaseAdmin
      .from("role_requests")
      .select("requested_role, status, requested_at")
      .eq("user_id", userRow.id)
      .in("requested_role", ["composer", "admin"])
      .order("requested_at", { ascending: false });

    if (reqErr) throw reqErr;

    const requestStatus = {
      composer: "none",
      admin: "none",
    };

    (requests || []).forEach((row) => {
      const role = row.requested_role;
      if (!["composer", "admin"].includes(role)) return;
      if (requestStatus[role] === "none") {
        requestStatus[role] = row.status || "none";
      }
    });

    if (roles.includes("composer")) requestStatus.composer = "approved";
    if (roles.includes("admin")) requestStatus.admin = "approved";

    return res.json({
      roles,
      requests: requestStatus,
    });
  } catch (err) {
    return serverError(res, err);
  }
});

/**
 * POST /api/request-role
 * Authenticated user requests a role (composer/admin)
 */
router.post("/request-role", verifySupabaseToken, async (req, res) => {
  try {
    const authUid = req.authUid;
    const { requestedRole } = req.body;
    if (!requestedRole)
      return res.status(400).json({ message: "requestedRole required" });
    if (!["composer", "admin"].includes(requestedRole)) {
      return res
        .status(400)
        .json({ message: 'requestedRole must be "composer" or "admin"' });
    }

    // Find user DB row
    const { data: userRow, error } = await supabaseAdmin
      .from("users")
      .select("id, email")
      .eq("auth_uid", authUid)
      .maybeSingle();

    if (error) throw error;
    if (!userRow) return res.status(404).json({ message: "User not found" });

    const currentRoles = await resolveUserRoles(userRow.id, userRow.email);
    if (currentRoles.includes(requestedRole)) {
      return res.status(409).json({
        message: `You already have ${requestedRole} access.`,
        status: "approved",
      });
    }

    // Check existing request first (avoids requiring DB unique constraint for upsert)
    const { data: existing, error: existingErr } = await supabaseAdmin
      .from("role_requests")
      .select("id, status")
      .eq("user_id", userRow.id)
      .eq("requested_role", requestedRole)
      .order("requested_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (existingErr) throw existingErr;

    if (existing?.status === "pending" || existing?.status === "approved") {
      if (requestedRole === "composer" && existing.status === "pending") {
        await supabaseAdmin
          .from("users")
          .update({ composer_request: true })
          .eq("id", userRow.id);
      }
      return res.status(409).json({
        message: `You already have a ${existing.status} ${requestedRole} request.`,
        requestId: existing.id,
        status: existing.status,
      });
    }

    let approvedPayment = null;
    if (requestedRole === "composer") {
      const regulations = await ensureActiveRegistrationRegulations(supabaseAdmin);
      const requiredComposerFee = getRequiredRegistrationFee(
        regulations,
        REGISTRATION_TYPES.COMPOSER_REQUEST,
      );

      if (requiredComposerFee > 0) {
        approvedPayment = await findApprovedUnconsumedRegistrationPayment(
          supabaseAdmin,
          userRow.id,
          REGISTRATION_TYPES.COMPOSER_REQUEST,
        );
        if (!approvedPayment?.id) {
          return res.status(402).json({
            code: "REGISTRATION_PAYMENT_REQUIRED",
            message:
              "Composer request payment is required before submitting this role request.",
            registrationType: REGISTRATION_TYPES.COMPOSER_REQUEST,
            requiredFee: requiredComposerFee,
            bankName: regulations.bank_name || "I&M Bank",
            bankAccountNumber:
              regulations.bank_account_number || "0030 7335 5161 50",
            accountName: regulations.account_name || "Murekefu Music Hub",
          });
        }
      }
    }

    // Re-open rejected request if it exists, otherwise create a new one.
    if (existing?.id) {
      const { data: updated, error: updateErr } = await supabaseAdmin
        .from("role_requests")
        .update({
          status: "pending",
          requested_at: new Date().toISOString(),
        })
        .eq("id", existing.id)
        .select()
        .maybeSingle();

      if (updateErr) throw updateErr;

      if (requestedRole === "composer") {
        await supabaseAdmin
          .from("users")
          .update({ composer_request: true })
          .eq("id", userRow.id);

        if (approvedPayment?.id) {
          try {
            const consumedPayment = await consumeRegistrationPaymentSubmission(
              supabaseAdmin,
              approvedPayment.id,
              REGISTRATION_TYPES.COMPOSER_REQUEST,
              updated?.id || existing.id,
            );
            if (!consumedPayment?.id) {
              await supabaseAdmin
                .from("role_requests")
                .update({ status: "rejected" })
                .eq("id", updated?.id || existing.id);
              await supabaseAdmin
                .from("users")
                .update({ composer_request: false })
                .eq("id", userRow.id);
              return res.status(409).json({
                code: "REGISTRATION_PAYMENT_ALREADY_USED",
                message:
                  "The approved composer registration payment was already used. Submit a new payment and try again.",
              });
            }
          } catch (consumeErr) {
            await supabaseAdmin
              .from("role_requests")
              .update({ status: "rejected" })
              .eq("id", updated?.id || existing.id);
            await supabaseAdmin
              .from("users")
              .update({ composer_request: false })
              .eq("id", userRow.id);
            throw consumeErr;
          }
        }
      }

      return res.status(200).json({
        success: true,
        message: `${requestedRole} request resubmitted successfully. Awaiting admin approval.`,
        requestId: updated?.id || existing.id,
        status: updated?.status || "pending",
      });
    }

    const { data: created, error: createErr } = await supabaseAdmin
      .from("role_requests")
      .insert({
        user_id: userRow.id,
        requested_role: requestedRole,
        status: "pending",
        requested_at: new Date().toISOString(),
      })
      .select()
      .maybeSingle();

    if (createErr) throw createErr;

    if (requestedRole === "composer") {
      await supabaseAdmin
        .from("users")
        .update({ composer_request: true })
        .eq("id", userRow.id);

      if (approvedPayment?.id) {
        try {
          const consumedPayment = await consumeRegistrationPaymentSubmission(
            supabaseAdmin,
            approvedPayment.id,
            REGISTRATION_TYPES.COMPOSER_REQUEST,
            created?.id || null,
          );
          if (!consumedPayment?.id) {
            if (created?.id) {
              await supabaseAdmin.from("role_requests").delete().eq("id", created.id);
            }
            await supabaseAdmin
              .from("users")
              .update({ composer_request: false })
              .eq("id", userRow.id);
            return res.status(409).json({
              code: "REGISTRATION_PAYMENT_ALREADY_USED",
              message:
                "The approved composer registration payment was already used. Submit a new payment and try again.",
            });
          }
        } catch (consumeErr) {
          if (created?.id) {
            await supabaseAdmin.from("role_requests").delete().eq("id", created.id);
          }
          await supabaseAdmin
            .from("users")
            .update({ composer_request: false })
            .eq("id", userRow.id);
          throw consumeErr;
        }
      }
    }

    return res.status(201).json({
      success: true,
      message: `${requestedRole} request submitted successfully. Awaiting admin approval.`,
      requestId: created?.id,
      status: created?.status || "pending",
    });
  } catch (err) {
    if (isMissingRegistrationTablesError(err)) {
      return res.status(500).json({
        message:
          "Registration payment tables are missing. Run migration 022_create_registration_payment_controls.sql and retry.",
      });
    }
    return serverError(res, err);
  }
});

export default router;
