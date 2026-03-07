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

async function ensureUserRoleAssignment(userId, roleName) {
  const { data: roleRow, error: roleErr } = await supabaseAdmin
    .from("roles")
    .select("id")
    .eq("name", roleName)
    .maybeSingle();
  if (roleErr) throw roleErr;
  if (!roleRow?.id) return;

  const { data: existingUserRole, error: existingErr } = await supabaseAdmin
    .from("user_roles")
    .select("user_id")
    .eq("user_id", userId)
    .eq("role_id", roleRow.id)
    .maybeSingle();
  if (existingErr) throw existingErr;

  if (!existingUserRole) {
    const { error: insertErr } = await supabaseAdmin
      .from("user_roles")
      .insert({ user_id: userId, role_id: roleRow.id });
    if (insertErr && String(insertErr.code || "").toUpperCase() !== "23505") {
      throw insertErr;
    }
  }
}

async function ensureComposerProfile(userId) {
  const { data: composerRow, error: composerErr } = await supabaseAdmin
    .from("composers")
    .select("id")
    .eq("user_id", userId)
    .maybeSingle();
  if (composerErr) throw composerErr;

  if (!composerRow) {
    const { error: createComposerErr } = await supabaseAdmin
      .from("composers")
      .insert({ user_id: userId });
    if (
      createComposerErr &&
      String(createComposerErr.code || "").toUpperCase() !== "23505"
    ) {
      throw createComposerErr;
    }
  }
}

async function markRoleRequestApproved(userId, requestedRole) {
  const { data: existingRequest, error: existingReqErr } = await supabaseAdmin
    .from("role_requests")
    .select("id")
    .eq("user_id", userId)
    .eq("requested_role", requestedRole)
    .order("requested_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (existingReqErr) throw existingReqErr;

  if (existingRequest?.id) {
    const { error: approveErr } = await supabaseAdmin
      .from("role_requests")
      .update({ status: "approved" })
      .eq("id", existingRequest.id);
    if (approveErr) throw approveErr;
    return existingRequest.id;
  }

  const { data: createdRequest, error: createReqErr } = await supabaseAdmin
    .from("role_requests")
    .insert({
      user_id: userId,
      requested_role: requestedRole,
      status: "approved",
      requested_at: new Date().toISOString(),
    })
    .select("id")
    .maybeSingle();
  if (createReqErr) throw createReqErr;
  return createdRequest?.id || null;
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
 * GET /api/request-role/invite-status
 * Returns invite availability for the authenticated user's email.
 */
router.get("/request-role/invite-status", verifySupabaseToken, async (req, res) => {
  try {
    const authUid = req.authUid;
    const requestedRole =
      req.query?.requestedRole === "admin" ? "admin" : "composer";

    const { data: userRow, error: userErr } = await supabaseAdmin
      .from("users")
      .select("id, email")
      .eq("auth_uid", authUid)
      .maybeSingle();
    if (userErr) throw userErr;
    if (!userRow) return res.status(404).json({ message: "User not found" });

    const normalizedEmail = String(userRow.email || "")
      .trim()
      .toLowerCase();
    if (!normalizedEmail) {
      return res.json({
        available: false,
        requestedRole,
      });
    }

    const { data: invite, error: inviteErr } = await supabaseAdmin
      .from("invites")
      .select("id, email, requested_role, created_at, used, used_by, used_at")
      .ilike("email", normalizedEmail)
      .eq("requested_role", requestedRole)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (inviteErr) throw inviteErr;
    if (!invite) {
      return res.json({
        available: false,
        requestedRole,
      });
    }

    const usedBy = invite.used_by || null;
    const acceptedByCurrentUser = Boolean(invite.used && usedBy === userRow.id);
    const canAccept = !invite.used || acceptedByCurrentUser;

    return res.json({
      available: true,
      requestedRole,
      canAccept,
      accepted: acceptedByCurrentUser,
      invite: {
        id: invite.id,
        email: invite.email,
        used: Boolean(invite.used),
        usedBy,
        usedAt: invite.used_at || null,
        createdAt: invite.created_at || null,
      },
    });
  } catch (err) {
    return serverError(res, err);
  }
});

/**
 * POST /api/request-role/accept-invite
 * Accept a role invite tied to the authenticated user's email.
 */
router.post("/request-role/accept-invite", verifySupabaseToken, async (req, res) => {
  try {
    const authUid = req.authUid;
    const requestedRole = req.body?.requestedRole === "admin" ? "admin" : "composer";

    const { data: userRow, error: userErr } = await supabaseAdmin
      .from("users")
      .select("id, email")
      .eq("auth_uid", authUid)
      .maybeSingle();
    if (userErr) throw userErr;
    if (!userRow) return res.status(404).json({ message: "User not found" });

    const normalizedEmail = String(userRow.email || "")
      .trim()
      .toLowerCase();
    if (!normalizedEmail) {
      return res.status(400).json({ message: "User email is required to accept invites" });
    }

    const { data: invite, error: inviteErr } = await supabaseAdmin
      .from("invites")
      .select("id, email, used, used_by")
      .ilike("email", normalizedEmail)
      .eq("requested_role", requestedRole)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (inviteErr) throw inviteErr;
    if (!invite) {
      return res
        .status(404)
        .json({ message: `No active ${requestedRole} invite found for your account.` });
    }

    if (invite.used && invite.used_by && invite.used_by !== userRow.id) {
      return res
        .status(409)
        .json({ message: "This invite was already accepted by another user." });
    }

    await ensureUserRoleAssignment(userRow.id, requestedRole);
    if (requestedRole === "composer") {
      await ensureComposerProfile(userRow.id);
      await supabaseAdmin
        .from("users")
        .update({ composer_request: false })
        .eq("id", userRow.id);
    }

    await markRoleRequestApproved(userRow.id, requestedRole);

    const usedAt = new Date().toISOString();
    const { data: updatedInvite, error: updateInviteErr } = await supabaseAdmin
      .from("invites")
      .update({
        used: true,
        used_by: userRow.id,
        used_at: usedAt,
      })
      .eq("id", invite.id)
      .select("id, email, requested_role, used, used_by, used_at, created_at")
      .maybeSingle();
    if (updateInviteErr) throw updateInviteErr;

    const roles = await resolveUserRoles(userRow.id, userRow.email);

    return res.json({
      success: true,
      message: `${requestedRole} invite accepted successfully.`,
      requestedRole,
      roles,
      invite: updatedInvite
        ? {
            id: updatedInvite.id,
            email: updatedInvite.email,
            used: Boolean(updatedInvite.used),
            usedBy: updatedInvite.used_by || null,
            usedAt: updatedInvite.used_at || null,
            createdAt: updatedInvite.created_at || null,
          }
        : null,
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
