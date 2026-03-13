import express from "express";
import { supabaseAdmin as supabase } from "../lib/supabaseServer.js";
import {
  verifySupabaseToken,
  adminOnly,
} from "../middleware/verifySupabaseToken.js";
import { withNormalizedAvatar } from "../utils/avatarUrl.js";
import { refreshAvatarUrl } from "../utils/avatarSignedUrl.js";
import {
  REGISTRATION_TYPES,
  ensureActiveRegistrationRegulations,
  isMissingRegistrationTablesError,
  missingRegistrationTablesResponse,
  isRegulationsControllerUser,
} from "../utils/registrationPayments.js";

const router = express.Router();
const ADMIN_IDENTIFIERS = new Set(
  String(process.env.ADMIN_IDENTIFIERS || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean),
);
const ROLE_PRIORITY = {
  buyer: 1,
  composer: 2,
  admin: 3,
};

// Protect all admin routes
router.use(verifySupabaseToken, adminOnly);

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

function isMissingEnrollmentsError(err) {
  const code = String(err?.code || "").toUpperCase();
  const message = String(err?.message || "").toLowerCase();
  return (
    code === "42P01" ||
    code === "PGRST204" ||
    code === "PGRST205" ||
    code === "42703" ||
    message.includes("enrollments") ||
    message.includes("admitted_by") ||
    message.includes("admitted_at")
  );
}

function isMissingCompositionVerificationColumnError(err) {
  const code = String(err?.code || "").toUpperCase();
  const message = String(err?.message || "").toLowerCase();
  return (
    code === "42703" ||
    code === "PGRST204" ||
    code === "PGRST205" ||
    message.includes("is_verified") ||
    message.includes("verified_at") ||
    message.includes("verified_by") ||
    message.includes("verification_notes")
  );
}

function isMissingSupportChatTablesError(err) {
  const code = String(err?.code || "").toUpperCase();
  const message = String(err?.message || "").toLowerCase();
  return (
    code === "42P01" ||
    code === "PGRST204" ||
    code === "PGRST205" ||
    code === "42703" ||
    message.includes("support_chat_threads") ||
    message.includes("support_chat_messages")
  );
}

function isMissingComposerActivationColumnError(err) {
  const code = String(err?.code || "").toUpperCase();
  const message = String(err?.message || "").toLowerCase();
  return (
    code === "42703" ||
    code === "PGRST204" ||
    code === "PGRST205" ||
    message.includes("is_active")
  );
}

function missingEnrollmentsResponse(res) {
  return res.status(500).json({
    message:
      "Enrollments table/columns are missing. Run migration 021_create_enrollments_table.sql, then retry.",
  });
}

function parseLimit(raw, fallback = 200, max = 1000) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}

async function fetchComposerProfiles(userIds = []) {
  const normalizedUserIds = [...new Set((userIds || []).filter(Boolean))];
  let query = supabase.from("composers").select("id, user_id, is_active");
  if (normalizedUserIds.length > 0) {
    query = query.in("user_id", normalizedUserIds);
  }

  const { data, error } = await query;
  if (!error) {
    return {
      rows: data || [],
      activationColumnMissing: false,
    };
  }

  if (!isMissingComposerActivationColumnError(error)) {
    throw error;
  }

  let fallbackQuery = supabase.from("composers").select("id, user_id");
  if (normalizedUserIds.length > 0) {
    fallbackQuery = fallbackQuery.in("user_id", normalizedUserIds);
  }

  const fallback = await fallbackQuery;
  if (fallback.error) throw fallback.error;

  return {
    rows: (fallback.data || []).map((row) => ({ ...row, is_active: true })),
    activationColumnMissing: true,
  };
}

async function fetchComposerProfileByUserId(userId) {
  const { rows, activationColumnMissing } = await fetchComposerProfiles([userId]);
  return {
    profile: rows[0] || null,
    activationColumnMissing,
  };
}

async function resolveRoleId(roleName) {
  const normalizedRole = String(roleName || "").trim().toLowerCase();
  if (!normalizedRole) return null;

  const { data: roleRow, error } = await supabase
    .from("roles")
    .select("id")
    .eq("name", normalizedRole)
    .maybeSingle();
  if (error) throw error;
  return roleRow?.id || null;
}

async function removeUserRoleAssignment(userId, roleName) {
  const roleId = await resolveRoleId(roleName);
  if (!roleId) return 0;

  const { error, count } = await supabase
    .from("user_roles")
    .delete({ count: "exact" })
    .eq("user_id", userId)
    .eq("role_id", roleId);
  if (error) throw error;
  return Number(count || 0);
}

async function resolveDbUser(userIdentifier) {
  if (!userIdentifier) return null;
  const normalized = String(userIdentifier).trim();
  if (!normalized) return null;

  const { data: byId, error: byIdErr } = await supabase
    .from("users")
    .select("id, auth_uid, email, display_name")
    .eq("id", normalized)
    .maybeSingle();
  if (byIdErr) throw byIdErr;
  if (byId) return byId;

  const { data: byAuthUid, error: byAuthErr } = await supabase
    .from("users")
    .select("id, auth_uid, email, display_name")
    .eq("auth_uid", normalized)
    .maybeSingle();
  if (byAuthErr) throw byAuthErr;
  if (byAuthUid) return byAuthUid;

  return null;
}

function sameUserId(a, b) {
  return (
    String(a || "").trim().length > 0 &&
    String(b || "").trim().length > 0 &&
    String(a).trim() === String(b).trim()
  );
}

function sameEmail(a, b) {
  const left = String(a || "").trim().toLowerCase();
  const right = String(b || "").trim().toLowerCase();
  return Boolean(left && right && left === right);
}

const REGULATIONS_CONTROLLER_FALLBACK = String(
  process.env.REGISTRATION_CONTROLLER_IDENTIFIER || "fredrickmakori102",
)
  .trim()
  .toLowerCase();

async function requireRegulationsController(req, res) {
  const adminUser = await resolveDbUser(req.authUid);
  if (!adminUser?.id) {
    res.status(404).json({ error: "Admin user not found" });
    return null;
  }

  const regulations = await ensureActiveRegistrationRegulations(supabase);
  const controllingIdentifier =
    regulations?.controlling_admin_identifier ||
    REGULATIONS_CONTROLLER_FALLBACK;
  const canManage = isRegulationsControllerUser(
    adminUser,
    controllingIdentifier,
  );

  if (!canManage) {
    res.status(403).json({
      error: `Only ${controllingIdentifier} can manage registration regulations.`,
      controllingAdminIdentifier: controllingIdentifier,
    });
    return null;
  }

  return {
    adminUser,
    regulations,
    controllingIdentifier,
  };
}

async function insertPurchaseWithFallback(payload) {
  const primary = await supabase
    .from("purchases")
    .insert(payload)
    .select("*")
    .maybeSingle();
  if (!primary.error) return primary;

  const maybePaymentRefColumnMissing =
    primary.error.code === "PGRST204" ||
    String(primary.error.message || "")
      .toLowerCase()
      .includes("payment_ref");

  if (!maybePaymentRefColumnMissing) return primary;

  const fallbackPayload = { ...payload };
  delete fallbackPayload.payment_ref;
  return await supabase
    .from("purchases")
    .insert(fallbackPayload)
    .select("*")
    .maybeSingle();
}


function isMissingBuyersTableError(err) {
  const code = String(err?.code || "").toUpperCase();
  const message = String(err?.message || "").toLowerCase();
  return (
    code === "42P01" ||
    code === "PGRST204" ||
    code === "PGRST205" ||
    message.includes('relation "buyers" does not exist') ||
    message.includes("could not find the table 'buyers'")
  );
}

function isPurchasesBuyerForeignKeyError(err) {
  const code = String(err?.code || "").toUpperCase();
  const constraint = String(err?.constraint || "").toLowerCase();
  const details = String(err?.details || "").toLowerCase();
  const message = String(err?.message || "").toLowerCase();
  return (
    code === "23503" &&
    (constraint.includes("purchases_buyer_id_fkey") ||
      details.includes('table "buyers"') ||
      message.includes("purchases_buyer_id_fkey") ||
      message.includes('table "buyers"'))
  );
}

async function resolveBuyerIdForPurchases(rawBuyerId) {
  const normalized = String(rawBuyerId || "").trim();
  if (!normalized) return null;

  const byBuyerIdRes = await supabase
    .from("buyers")
    .select("id")
    .eq("id", normalized)
    .maybeSingle();
  if (byBuyerIdRes.error) {
    if (isMissingBuyersTableError(byBuyerIdRes.error)) return normalized;
    throw byBuyerIdRes.error;
  }
  if (byBuyerIdRes.data?.id) return byBuyerIdRes.data.id;

  const byUserIdRes = await supabase
    .from("buyers")
    .select("id")
    .eq("user_id", normalized)
    .maybeSingle();
  if (byUserIdRes.error) throw byUserIdRes.error;
  if (byUserIdRes.data?.id) return byUserIdRes.data.id;

  const dbUser = await resolveDbUser(normalized);
  if (!dbUser?.id) return null;

  const createBuyerRes = await supabase
    .from("buyers")
    .insert({ user_id: dbUser.id })
    .select("id")
    .maybeSingle();
  if (!createBuyerRes.error) return createBuyerRes.data?.id || null;

  if (String(createBuyerRes.error?.code || "").toUpperCase() === "23505") {
    const retryBuyerRes = await supabase
      .from("buyers")
      .select("id")
      .eq("user_id", dbUser.id)
      .maybeSingle();
    if (retryBuyerRes.error) throw retryBuyerRes.error;
    return retryBuyerRes.data?.id || null;
  }

  throw createBuyerRes.error;
}

async function resolveBuyerOwnerUserId(rawBuyerId) {
  const normalized = String(rawBuyerId || "").trim();
  if (!normalized) return null;

  // Common schema path: payment_submissions.buyer_id references users.id directly.
  const directUser = await resolveDbUser(normalized).catch(() => null);
  if (directUser?.id) return directUser.id;

  // Legacy schema path: payment_submissions.buyer_id references buyers.id.
  const { data: buyerRow, error: buyerErr } = await supabase
    .from("buyers")
    .select("id, user_id")
    .eq("id", normalized)
    .maybeSingle();
  if (buyerErr) {
    if (isMissingBuyersTableError(buyerErr)) return null;
    throw buyerErr;
  }
  return buyerRow?.user_id || null;
}

router.get("/bootstrap", async (req, res) => {
  try {
    const [rolesRes, invitesRes, pendingReqRes, usersCountRes, compositionsCountRes, purchasesCountRes] =
      await Promise.all([
        supabase.from("roles").select("id, name"),
        supabase
          .from("invites")
          .select("id, email, invited_by, created_at, used")
          .order("created_at", { ascending: false })
          .limit(50),
        supabase
          .from("role_requests")
          .select("id, user_id, requested_role, status, requested_at")
          .eq("requested_role", "composer")
          .eq("status", "pending")
          .order("requested_at", { ascending: false })
          .limit(50),
        supabase.from("users").select("id", { count: "exact", head: true }),
        supabase
          .from("compositions")
          .select("id", { count: "exact", head: true })
          .eq("deleted", false),
        supabase
          .from("purchases")
          .select("id", { count: "exact", head: true }),
      ]);

    if (rolesRes.error) throw rolesRes.error;
    if (invitesRes.error) throw invitesRes.error;
    if (pendingReqRes.error) throw pendingReqRes.error;

    const pendingRequests = pendingReqRes.data || [];
    const reqUserIds = [
      ...new Set(pendingRequests.map((r) => r.user_id).filter(Boolean)),
    ];

    let requestUsersById = {};
    let requestRolesByUserId = {};
    if (reqUserIds.length > 0) {
      const [usersRes, roleRowsRes] = await Promise.all([
        supabase
          .from("users")
          .select("id, email, display_name")
          .in("id", reqUserIds),
        supabase
          .from("user_roles")
          .select("user_id, roles(name)")
          .in("user_id", reqUserIds),
      ]);

      if (usersRes.error) throw usersRes.error;
      if (roleRowsRes.error) throw roleRowsRes.error;

      (usersRes.data || []).forEach((u) => {
        requestUsersById[u.id] = u;
      });

      (roleRowsRes.data || []).forEach((row) => {
        const roleName = row.roles?.name;
        if (!roleName) return;
        if (!requestRolesByUserId[row.user_id]) requestRolesByUserId[row.user_id] = [];
        if (!requestRolesByUserId[row.user_id].includes(roleName)) {
          requestRolesByUserId[row.user_id].push(roleName);
        }
      });
    }

    const formattedRequests = pendingRequests.map((r) => {
      const user = requestUsersById[r.user_id] || null;
      return {
        id: r.user_id,
        request_id: r.id,
        user_id: r.user_id,
        email: user?.email || null,
        display_name: user?.display_name || null,
        displayName: user?.display_name || null,
        requested_role: r.requested_role,
        status: r.status,
        created_at: r.requested_at,
        roles: requestRolesByUserId[r.user_id] || [],
      };
    });

    return res.json({
      roles: rolesRes.data || [],
      invites: invitesRes.data || [],
      requests: formattedRequests,
      stats: {
        totalUsers: usersCountRes.count || 0,
        totalCompositions: compositionsCountRes.count || 0,
        totalTransactions: purchasesCountRes.count || 0,
        totalRevenue: 0, // hydrated by /admin/stats asynchronously on the client
      },
    });
  } catch (err) {
    console.error("[admin-bootstrap] Error:", err);
    return res.status(500).json({ error: err.message });
  }
});

router.get("/roles", async (req, res) => {
  try {
    const { data, error } = await supabase.from("roles").select("*");
    if (error) throw error;
    return res.json(data || []);
  } catch (err) {
    console.error("[admin-roles] Error:", err);
    return res.status(500).json({ error: err.message });
  }
});

router.get("/users", async (req, res) => {
  try {
    const { data: users, error: usersErr } = await supabase
      .from("users")
      .select(
        "id, auth_uid, email, display_name, phone, avatar_url, is_active, composer_request, deleted, created_at, updated_at",
      )
      .order("created_at", { ascending: false });
    if (usersErr) throw usersErr;
    const { data: userRoles, error: userRolesErr } = await supabase
      .from("user_roles")
      .select("user_id, role_id, roles(name)");
    if (userRolesErr) console.warn("user_roles fetch warning:", userRolesErr);

    const refreshedUsers = await Promise.all(
      (users || []).map(async (user) =>
        await refreshAvatarUrl(withNormalizedAvatar(user)),
      ),
    );

    const userIds = refreshedUsers.map((user) => user.id).filter(Boolean);
    const [composerProfiles, activeAdminEmailsRes] = await Promise.all([
      fetchComposerProfiles(userIds),
      supabase
        .from("admin_emails")
        .select("email")
        .eq("is_active", true),
    ]);
    if (activeAdminEmailsRes.error) throw activeAdminEmailsRes.error;

    const explicitRolesByUserId = {};
    (userRoles || []).forEach((row) => {
      const roleName = String(row?.roles?.name || "")
        .trim()
        .toLowerCase();
      if (!row?.user_id || !roleName) return;
      if (!explicitRolesByUserId[row.user_id]) {
        explicitRolesByUserId[row.user_id] = new Set(["buyer"]);
      }
      explicitRolesByUserId[row.user_id].add(roleName);
    });

    const composerUserIds = new Set(
      (composerProfiles.rows || [])
        .filter((row) => row?.user_id && row?.is_active !== false)
        .map((row) => row.user_id),
    );
    const activeAdminEmails = new Set(
      (activeAdminEmailsRes.data || [])
        .map((row) => String(row?.email || "").trim().toLowerCase())
        .filter(Boolean),
    );

    const usersWithEffectiveRoles = refreshedUsers.map((user) => {
      const roles = explicitRolesByUserId[user.id] || new Set(["buyer"]);
      if (composerUserIds.has(user.id)) roles.add("composer");

      const normalizedEmail = String(user?.email || "").trim().toLowerCase();
      if (
        normalizedEmail &&
        (ADMIN_IDENTIFIERS.has(normalizedEmail) ||
          activeAdminEmails.has(normalizedEmail))
      ) {
        roles.add("admin");
      }

      return {
        ...user,
        roles: [...roles].sort(
          (a, b) => (ROLE_PRIORITY[b] || 0) - (ROLE_PRIORITY[a] || 0),
        ),
      };
    });

    return res.json({
      users: usersWithEffectiveRoles,
      userRoles: userRoles || [],
    });
  } catch (err) {
    console.error("[admin-users] Error:", err);
    return res.status(500).json({ error: err.message });
  }
});

router.get("/compositions", async (req, res) => {
  try {
    const limit = parseLimit(req.query.limit, 400, 1000);

    const selectBase = `
      id,
      title,
      description,
      price,
      pdf_url,
      created_at,
      composer_id,
      composers (
        id,
        user_id,
        users(display_name, email)
      )
    `;

    const selectWithVerification = `
      id,
      title,
      description,
      price,
      pdf_url,
      created_at,
      composer_id,
      is_verified,
      verified_at,
      verified_by,
      verification_notes,
      composers (
        id,
        user_id,
        users(display_name, email)
      )
    `;

    const runQuery = async (includeVerification) => {
      let query = supabase
        .from("compositions")
        .select(includeVerification ? selectWithVerification : selectBase)
        .eq("deleted", false)
        .order("created_at", { ascending: false });

      if (limit > 0) {
        query = query.limit(limit);
      }

      return await query;
    };

    let { data, error } = await runQuery(true);

    if (error && isMissingCompositionVerificationColumnError(error)) {
      console.warn(
        "[admin-compositions] verification columns missing; retrying without them",
      );
      const fallback = await runQuery(false);
      data = fallback.data;
      error = fallback.error;
      if (!error) {
        data = (data || []).map((row) => ({
          ...row,
          is_verified: false,
          verified_at: null,
          verified_by: null,
          verification_notes: null,
        }));
      }
    }

    if (error) throw error;
    return res.json(data || []);
  } catch (err) {
    console.error("[admin-compositions] Error:", err);
    return res.status(500).json({ error: err.message });
  }
});

router.post("/compositions/:compositionId/verify", async (req, res) => {
  try {
    const { compositionId } = req.params;
    if (!compositionId) {
      return res.status(400).json({ error: "compositionId is required" });
    }

    const reviewer = await resolveDbUser(req.authUid);
    if (!reviewer?.id) {
      return res.status(404).json({ error: "Admin user not found" });
    }

    const verificationNotes = req.body?.verificationNotes
      ? String(req.body.verificationNotes).trim().slice(0, 1200)
      : null;

    const { data: updated, error } = await supabase
      .from("compositions")
      .update({
        is_verified: true,
        verified_by: reviewer.id,
        verified_at: new Date().toISOString(),
        verification_notes: verificationNotes,
      })
      .eq("id", compositionId)
      .eq("deleted", false)
      .select("id, title, is_verified, verified_at, verified_by, verification_notes")
      .maybeSingle();

    if (error) {
      if (isMissingCompositionVerificationColumnError(error)) {
        return res.status(500).json({
          message:
            "Composition verification columns are missing. Run migration 023_add_composition_verification_columns.sql, then retry.",
        });
      }
      throw error;
    }
    if (!updated) {
      return res.status(404).json({ error: "Composition not found" });
    }

    return res.json({
      success: true,
      message: "Composition verified",
      composition: updated,
    });
  } catch (err) {
    console.error("[admin-verify-composition] Error:", err);
    return res.status(500).json({ error: err.message });
  }
});

router.post("/compositions/:compositionId/unverify", async (req, res) => {
  try {
    const { compositionId } = req.params;
    if (!compositionId) {
      return res.status(400).json({ error: "compositionId is required" });
    }

    const reviewer = await resolveDbUser(req.authUid);
    if (!reviewer?.id) {
      return res.status(404).json({ error: "Admin user not found" });
    }

    const reason = req.body?.reason
      ? String(req.body.reason).trim().slice(0, 1200)
      : null;

    const { data: updated, error } = await supabase
      .from("compositions")
      .update({
        is_verified: false,
        verified_by: null,
        verified_at: null,
        verification_notes: reason,
      })
      .eq("id", compositionId)
      .eq("deleted", false)
      .select("id, title, is_verified, verified_at, verified_by, verification_notes")
      .maybeSingle();

    if (error) {
      if (isMissingCompositionVerificationColumnError(error)) {
        return res.status(500).json({
          message:
            "Composition verification columns are missing. Run migration 023_add_composition_verification_columns.sql, then retry.",
        });
      }
      throw error;
    }
    if (!updated) {
      return res.status(404).json({ error: "Composition not found" });
    }

    return res.json({
      success: true,
      message: "Composition marked unverified",
      composition: updated,
    });
  } catch (err) {
    console.error("[admin-unverify-composition] Error:", err);
    return res.status(500).json({ error: err.message });
  }
});

router.get("/transactions", async (req, res) => {
  try {
    const limit = parseLimit(req.query.limit, 200, 1000);

    const [purchasesRes, submissionsRes] = await Promise.all([
      supabase
        .from("purchases")
        .select("*")
        .order("purchased_at", { ascending: false })
        .limit(limit),
      supabase
        .from("payment_submissions")
        .select(
          "id, checkout_batch_id, buyer_id, composition_id, amount, mpesa_code, status, purchase_id, reviewed_by, reviewed_at, admin_notes, submitted_at",
        )
        .order("submitted_at", { ascending: false })
        .limit(limit),
    ]);

    if (purchasesRes.error) throw purchasesRes.error;

    let paymentSubmissions = [];
    if (submissionsRes.error) {
      if (!isMissingPaymentSubmissionsError(submissionsRes.error)) {
        throw submissionsRes.error;
      }
      console.warn(
        "[admin-transactions] payment_submissions table missing; returning purchases only",
      );
    } else {
      paymentSubmissions = submissionsRes.data || [];
    }

    const purchases = purchasesRes.data || [];
    const compositionIds = [
      ...new Set(
        [...purchases, ...paymentSubmissions]
          .map((row) => row.composition_id)
          .filter(Boolean),
      ),
    ];
    const userIds = [
      ...new Set(
        [...purchases, ...paymentSubmissions]
          .flatMap((row) => [row.buyer_id, row.reviewed_by])
          .filter(Boolean),
      ),
    ];

    const [compositionsRes, usersRes] = await Promise.all([
      compositionIds.length > 0
        ? supabase
            .from("compositions")
            .select("id, title, composer_id")
            .in("id", compositionIds)
        : Promise.resolve({ data: [], error: null }),
      userIds.length > 0
        ? supabase
            .from("users")
            .select("id, display_name, email")
            .in("id", userIds)
        : Promise.resolve({ data: [], error: null }),
    ]);

    if (compositionsRes.error) throw compositionsRes.error;
    if (usersRes.error) throw usersRes.error;

    const compositionsById = {};
    (compositionsRes.data || []).forEach((c) => {
      compositionsById[c.id] = c;
    });

    const usersById = {};
    (usersRes.data || []).forEach((u) => {
      usersById[u.id] = u;
    });

    const purchaseRows = purchases.map((purchase) => ({
      ...purchase,
      id: `purchase:${purchase.id}`,
      source: "purchase",
      transaction_kind: "purchase",
      transaction_id: purchase.id,
      status: "approved",
      payment_ref: purchase.payment_ref || null,
      purchased_at:
        purchase.purchased_at || purchase.created_at || new Date().toISOString(),
      compositions: purchase.composition_id
        ? compositionsById[purchase.composition_id] || null
        : null,
      buyers: purchase.buyer_id
        ? {
            id: purchase.buyer_id,
            user_id: purchase.buyer_id,
            users: usersById[purchase.buyer_id] || null,
          }
        : null,
      can_approve: false,
      can_reject: false,
    }));

    const submissionRows = paymentSubmissions.map((submission) => ({
      ...submission,
      id: `submission:${submission.id}`,
      source: "payment_submission",
      transaction_kind: "manual_checkout",
      transaction_id: submission.id,
      payment_submission_id: submission.id,
      price_paid: Number(submission.amount || 0),
      payment_ref: submission.mpesa_code || null,
      purchased_at:
        submission.submitted_at ||
        submission.reviewed_at ||
        new Date().toISOString(),
      compositions: submission.composition_id
        ? compositionsById[submission.composition_id] || null
        : null,
      buyers: submission.buyer_id
        ? {
            id: submission.buyer_id,
            user_id: submission.buyer_id,
            users: usersById[submission.buyer_id] || null,
          }
        : null,
      reviewer: submission.reviewed_by
        ? usersById[submission.reviewed_by] || null
        : null,
      can_approve: submission.status === "pending",
      can_reject: submission.status === "pending",
    }));

    const formatted = [...submissionRows, ...purchaseRows]
      .sort((a, b) => {
        const aMs = new Date(a.purchased_at || 0).getTime();
        const bMs = new Date(b.purchased_at || 0).getTime();
        return bMs - aMs;
      })
      .slice(0, limit);

    return res.json(formatted);
  } catch (err) {
    console.error("[admin-transactions] Error:", err);
    return res.status(500).json({ error: err.message });
  }
});

router.get("/enrollments", async (req, res) => {
  try {
    const limit = parseLimit(req.query.limit, 300, 1000);
    const requestedStatus = String(req.query.status || "all")
      .trim()
      .toLowerCase();
    const allowedStatuses = new Set(["all", "pending", "admitted", "rejected"]);
    if (!allowedStatuses.has(requestedStatus)) {
      return res.status(400).json({
        message: "status must be one of: all, pending, admitted, rejected",
      });
    }

    let query = supabase
      .from("enrollments")
      .select(
        "id, user_id, full_name, email, music_class, skill_level, notes, status, admitted_by, admitted_at, created_at, updated_at",
      )
      .order("created_at", { ascending: false })
      .limit(limit);

    if (requestedStatus !== "all") {
      query = query.eq("status", requestedStatus);
    }

    const { data: rows, error } = await query;
    if (error) throw error;

    const enrollmentRows = rows || [];
    const relatedUserIds = [
      ...new Set(
        enrollmentRows
          .flatMap((row) => [row.user_id, row.admitted_by])
          .filter(Boolean),
      ),
    ];

    let usersById = {};
    if (relatedUserIds.length > 0) {
      const { data: usersData, error: usersErr } = await supabase
        .from("users")
        .select("id, email, display_name, avatar_url")
        .in("id", relatedUserIds);
      if (usersErr) throw usersErr;

      (usersData || []).forEach((user) => {
        usersById[user.id] = withNormalizedAvatar(user);
      });
    }

    const response = enrollmentRows.map((row) => ({
      ...row,
      requester: row.user_id ? usersById[row.user_id] || null : null,
      admitted_admin: row.admitted_by ? usersById[row.admitted_by] || null : null,
    }));

    return res.json(response);
  } catch (err) {
    console.error("[admin-enrollments] Error:", err);
    if (isMissingEnrollmentsError(err)) {
      return missingEnrollmentsResponse(res);
    }
    return res.status(500).json({ error: err.message });
  }
});

router.post("/enrollments/:enrollmentId/admit", async (req, res) => {
  try {
    const { enrollmentId } = req.params;
    if (!enrollmentId) {
      return res.status(400).json({ error: "enrollmentId is required" });
    }

    const adminUser = await resolveDbUser(req.authUid);
    if (!adminUser?.id) {
      return res.status(404).json({ error: "Admin user not found" });
    }

    const { data: current, error: currentErr } = await supabase
      .from("enrollments")
      .select("*")
      .eq("id", enrollmentId)
      .maybeSingle();
    if (currentErr) throw currentErr;
    if (!current) {
      return res.status(404).json({ error: "Enrollment not found" });
    }

    const isSelfEnrollment =
      sameUserId(current.user_id, adminUser.id) ||
      (!current.user_id && sameEmail(current.email, adminUser.email));
    if (isSelfEnrollment) {
      return res.status(403).json({
        error: "Admins cannot admit their own enrollment requests.",
      });
    }

    if (current.status === "admitted") {
      return res.json({
        success: true,
        alreadyAdmitted: true,
        enrollment: current,
      });
    }

    const nowIso = new Date().toISOString();
    const { data: updated, error: updateErr } = await supabase
      .from("enrollments")
      .update({
        status: "admitted",
        admitted_by: adminUser.id,
        admitted_at: nowIso,
      })
      .eq("id", enrollmentId)
      .select("*")
      .maybeSingle();
    if (updateErr) throw updateErr;
    if (!updated) {
      return res.status(404).json({ error: "Enrollment not found" });
    }

    return res.json({
      success: true,
      message: "Enrollment admitted",
      enrollment: {
        ...updated,
        admitted_admin: {
          id: adminUser.id,
          email: adminUser.email || null,
          display_name: adminUser.display_name || null,
        },
      },
    });
  } catch (err) {
    console.error("[admin-enrollments-admit] Error:", err);
    if (isMissingEnrollmentsError(err)) {
      return missingEnrollmentsResponse(res);
    }
    return res.status(500).json({ error: err.message });
  }
});

router.get("/registration/regulations", async (req, res) => {
  try {
    const context = await requireRegulationsController(req, res);
    if (!context) return;

    const regulations = context.regulations || {};
    return res.json({
      id: regulations.id || null,
      enrollmentFee: Number(regulations.enrollment_fee || 0),
      composerRequestFee: Number(regulations.composer_request_fee || 0),
      bankName: regulations.bank_name || "I&M Bank",
      bankAccountNumber:
        regulations.bank_account_number || "0030 7335 5161 50",
      accountName: regulations.account_name || "Murekefu Music Hub",
      controllingAdminIdentifier:
        regulations.controlling_admin_identifier ||
        REGULATIONS_CONTROLLER_FALLBACK,
      updatedAt: regulations.updated_at || null,
    });
  } catch (err) {
    console.error("[admin-registration-regulations-get] Error:", err);
    if (isMissingRegistrationTablesError(err)) {
      return missingRegistrationTablesResponse(res);
    }
    return res.status(500).json({ error: err.message });
  }
});

router.put("/registration/regulations", async (req, res) => {
  try {
    const context = await requireRegulationsController(req, res);
    if (!context) return;

    const toMoney = (value, fallback) => {
      const n = Number(value);
      if (!Number.isFinite(n) || n < 0) return fallback;
      return Number(n.toFixed(2));
    };
    const toText = (value, fallback, max = 160) => {
      const next = String(value || "")
        .trim()
        .slice(0, max);
      return next || fallback;
    };

    const nextEnrollmentFee = toMoney(
      req.body?.enrollmentFee ?? req.body?.enrollment_fee,
      Number(context.regulations?.enrollment_fee || 0),
    );
    const nextComposerRequestFee = toMoney(
      req.body?.composerRequestFee ?? req.body?.composer_request_fee,
      Number(context.regulations?.composer_request_fee || 0),
    );
    const nextBankName = toText(
      req.body?.bankName ?? req.body?.bank_name,
      context.regulations?.bank_name || "I&M Bank",
      120,
    );
    const nextBankAccountNumber = toText(
      req.body?.bankAccountNumber ?? req.body?.bank_account_number,
      context.regulations?.bank_account_number || "0030 7335 5161 50",
      64,
    );
    const nextAccountName = toText(
      req.body?.accountName ?? req.body?.account_name,
      context.regulations?.account_name || "Murekefu Music Hub",
      160,
    );

    const updatePayload = {
      enrollment_fee: nextEnrollmentFee,
      composer_request_fee: nextComposerRequestFee,
      bank_name: nextBankName,
      bank_account_number: nextBankAccountNumber,
      account_name: nextAccountName,
      controlling_admin_identifier: context.controllingIdentifier,
      is_active: true,
      updated_by: context.adminUser.id,
    };

    let updated = null;
    let updateErr = null;
    if (context.regulations?.id) {
      const updateRes = await supabase
        .from("registration_regulations")
        .update(updatePayload)
        .eq("id", context.regulations.id)
        .select("*")
        .maybeSingle();
      updated = updateRes.data;
      updateErr = updateRes.error;
    } else {
      const insertRes = await supabase
        .from("registration_regulations")
        .insert(updatePayload)
        .select("*")
        .maybeSingle();
      updated = insertRes.data;
      updateErr = insertRes.error;
    }
    if (updateErr) throw updateErr;

    return res.json({
      success: true,
      message: "Registration regulations updated",
      regulations: {
        id: updated?.id || context.regulations.id,
        enrollmentFee: Number(updated?.enrollment_fee || nextEnrollmentFee),
        composerRequestFee: Number(
          updated?.composer_request_fee || nextComposerRequestFee,
        ),
        bankName: updated?.bank_name || nextBankName,
        bankAccountNumber:
          updated?.bank_account_number || nextBankAccountNumber,
        accountName: updated?.account_name || nextAccountName,
        controllingAdminIdentifier:
          updated?.controlling_admin_identifier || context.controllingIdentifier,
        updatedAt: updated?.updated_at || new Date().toISOString(),
      },
    });
  } catch (err) {
    console.error("[admin-registration-regulations-update] Error:", err);
    if (isMissingRegistrationTablesError(err)) {
      return missingRegistrationTablesResponse(res);
    }
    return res.status(500).json({ error: err.message });
  }
});

router.get("/registration/payments", async (req, res) => {
  try {
    const context = await requireRegulationsController(req, res);
    if (!context) return;

    const statusFilter = String(req.query.status || "pending")
      .trim()
      .toLowerCase();
    const allowedStatuses = new Set(["all", "pending", "approved", "rejected"]);
    if (!allowedStatuses.has(statusFilter)) {
      return res.status(400).json({
        error: "status must be one of: all, pending, approved, rejected",
      });
    }

    const typeFilter = String(req.query.type || "all")
      .trim()
      .toLowerCase();
    const allowedTypes = new Set([
      "all",
      REGISTRATION_TYPES.ENROLLMENT,
      REGISTRATION_TYPES.COMPOSER_REQUEST,
    ]);
    if (!allowedTypes.has(typeFilter)) {
      return res.status(400).json({
        error: "type must be one of: all, enrollment, composer_request",
      });
    }

    const limit = parseLimit(req.query.limit, 300, 1000);
    let query = supabase
      .from("registration_payment_submissions")
      .select(
        "id, requester_id, registration_type, amount, payment_ref, status, is_consumed, consumed_for, consumed_target_id, consumed_at, reviewed_by, reviewed_at, admin_notes, submitted_at",
      )
      .order("submitted_at", { ascending: false })
      .limit(limit);

    if (statusFilter !== "all") query = query.eq("status", statusFilter);
    if (typeFilter !== "all") query = query.eq("registration_type", typeFilter);

    const { data: rows, error } = await query;
    if (error) throw error;

    const submissions = rows || [];
    const relatedUserIds = [
      ...new Set(
        submissions
          .flatMap((row) => [row.requester_id, row.reviewed_by])
          .filter(Boolean),
      ),
    ];

    let usersById = {};
    if (relatedUserIds.length > 0) {
      const { data: usersData, error: usersErr } = await supabase
        .from("users")
        .select("id, email, display_name, avatar_url")
        .in("id", relatedUserIds);
      if (usersErr) throw usersErr;
      (usersData || []).forEach((user) => {
        usersById[user.id] = withNormalizedAvatar(user);
      });
    }

    const response = submissions.map((row) => ({
      ...row,
      requester: row.requester_id ? usersById[row.requester_id] || null : null,
      reviewer: row.reviewed_by ? usersById[row.reviewed_by] || null : null,
    }));

    return res.json(response);
  } catch (err) {
    console.error("[admin-registration-payments] Error:", err);
    if (isMissingRegistrationTablesError(err)) {
      return missingRegistrationTablesResponse(res);
    }
    return res.status(500).json({ error: err.message });
  }
});

router.post("/registration/payments/:submissionId/approve", async (req, res) => {
  try {
    const context = await requireRegulationsController(req, res);
    if (!context) return;

    const { submissionId } = req.params;
    if (!submissionId) {
      return res.status(400).json({ error: "submissionId is required" });
    }

    const adminNotes = req.body?.adminNotes
      ? String(req.body.adminNotes).trim()
      : null;

    const { data: submission, error: submissionErr } = await supabase
      .from("registration_payment_submissions")
      .select("*")
      .eq("id", submissionId)
      .maybeSingle();
    if (submissionErr) throw submissionErr;
    if (!submission) {
      return res.status(404).json({ error: "Registration payment not found" });
    }
    if (sameUserId(submission.requester_id, context.adminUser.id)) {
      return res.status(403).json({
        error: "You cannot approve your own registration payment submission.",
      });
    }
    if (submission.status === "approved") {
      return res.json({
        success: true,
        alreadyApproved: true,
        submission,
      });
    }
    if (submission.status === "rejected") {
      return res
        .status(409)
        .json({ error: "Rejected submissions cannot be approved" });
    }

    const { data: updated, error: updateErr } = await supabase
      .from("registration_payment_submissions")
      .update({
        status: "approved",
        reviewed_by: context.adminUser.id,
        reviewed_at: new Date().toISOString(),
        admin_notes: adminNotes,
      })
      .eq("id", submissionId)
      .select("*")
      .maybeSingle();
    if (updateErr) throw updateErr;

    return res.json({
      success: true,
      message: "Registration payment approved",
      submission: updated,
    });
  } catch (err) {
    console.error("[admin-registration-payment-approve] Error:", err);
    if (isMissingRegistrationTablesError(err)) {
      return missingRegistrationTablesResponse(res);
    }
    return res.status(500).json({ error: err.message });
  }
});

router.post("/registration/payments/:submissionId/reject", async (req, res) => {
  try {
    const context = await requireRegulationsController(req, res);
    if (!context) return;

    const { submissionId } = req.params;
    if (!submissionId) {
      return res.status(400).json({ error: "submissionId is required" });
    }

    const adminNotes = req.body?.adminNotes
      ? String(req.body.adminNotes).trim()
      : null;

    const { data: submission, error: submissionErr } = await supabase
      .from("registration_payment_submissions")
      .select("id, status")
      .eq("id", submissionId)
      .maybeSingle();
    if (submissionErr) throw submissionErr;
    if (!submission) {
      return res.status(404).json({ error: "Registration payment not found" });
    }
    if (submission.status === "approved") {
      return res
        .status(409)
        .json({ error: "Approved submissions cannot be rejected" });
    }

    const { data: updated, error: updateErr } = await supabase
      .from("registration_payment_submissions")
      .update({
        status: "rejected",
        reviewed_by: context.adminUser.id,
        reviewed_at: new Date().toISOString(),
        admin_notes: adminNotes,
      })
      .eq("id", submissionId)
      .select("*")
      .maybeSingle();
    if (updateErr) throw updateErr;

    return res.json({
      success: true,
      message: "Registration payment rejected",
      submission: updated,
    });
  } catch (err) {
    console.error("[admin-registration-payment-reject] Error:", err);
    if (isMissingRegistrationTablesError(err)) {
      return missingRegistrationTablesResponse(res);
    }
    return res.status(500).json({ error: err.message });
  }
});

router.get("/invites", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("invites")
      .select("*")
      .order("created_at", { ascending: false });
    if (error) throw error;
    return res.json(data || []);
  } catch (err) {
    console.error("[admin-invites] Error:", err);
    return res.status(500).json({ error: err.message });
  }
});

router.get("/composer-requests", async (req, res) => {
  try {
    // Fetch ALL composer requests from role_requests table (not just pending).
    const { data: requests, error: requestsError } = await supabase
      .from("role_requests")
      .select("id, user_id, requested_role, status, requested_at")
      .eq("requested_role", "composer")
      .order("requested_at", { ascending: false });
    if (requestsError) throw requestsError;

    const userIds = [...new Set((requests || []).map((r) => r.user_id).filter(Boolean))];

    let usersById = {};
    if (userIds.length > 0) {
      const { data: usersData, error: usersError } = await supabase
        .from("users")
        .select("id, email, display_name")
        .in("id", userIds);
      if (usersError) throw usersError;
      (usersData || []).forEach((u) => {
        usersById[u.id] = u;
      });
    }

    let rolesByUserId = {};
    if (userIds.length > 0) {
      const { data: roleRows, error: rolesError } = await supabase
        .from("user_roles")
        .select("user_id, roles(name)")
        .in("user_id", userIds);
      if (rolesError) throw rolesError;
      (roleRows || []).forEach((row) => {
        const roleName = row.roles?.name;
        if (!roleName) return;
        if (!rolesByUserId[row.user_id]) rolesByUserId[row.user_id] = [];
        if (!rolesByUserId[row.user_id].includes(roleName)) {
          rolesByUserId[row.user_id].push(roleName);
        }
      });
    }

    const formattedData = (requests || []).map((req) => {
      const user = usersById[req.user_id] || null;
      return {
        id: req.user_id,
        request_id: req.id,
        user_id: req.user_id,
        email: user?.email || null,
        display_name: user?.display_name || null,
        displayName: user?.display_name || null,
        requested_role: req.requested_role,
        status: req.status,
        created_at: req.requested_at,
        roles: rolesByUserId[req.user_id] || [],
      };
    });

    return res.json(formattedData);
  } catch (err) {
    console.error("[admin-composer-requests] Error:", err);
    return res.status(500).json({ error: err.message });
  }
});

router.get("/stats", async (req, res) => {
  try {
    const { count: totalUsers } = await supabase
      .from("users")
      .select("id", { count: "exact", head: true });
    const { count: totalCompositions } = await supabase
      .from("compositions")
      .select("id", { count: "exact", head: true });
    const { data: purchases } = await supabase
      .from("purchases")
      .select("price_paid");
    const totalRevenue = (purchases || []).reduce(
      (sum, p) => sum + (parseFloat(p.price_paid) || 0),
      0,
    );
    console.log("[admin-stats] Stats fetched:", {
      totalUsers,
      totalCompositions,
      purchasesCount: purchases?.length,
      totalRevenue,
    });
    return res.json({
      totalUsers: totalUsers || 0,
      totalCompositions: totalCompositions || 0,
      totalRevenue,
      totalTransactions: purchases?.length || 0,
    });
  } catch (err) {
    console.error("[admin-stats] Error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// Debug endpoint to check all compositions in database
router.get("/debug/compositions", async (req, res) => {
  try {
    console.log("[debug-compositions] Querying compositions...");

    // Query without RLS restrictions
    const {
      data: allCompositions,
      error,
      count,
    } = await supabase
      .from("compositions")
      .select("id, title, composer_id, deleted, created_at", {
        count: "exact",
      });

    console.log("[debug-compositions] Query result:", {
      error,
      count,
      compositions: allCompositions?.length || 0,
      sample: allCompositions?.slice(0, 3),
    });

    if (error) {
      return res.status(500).json({
        error: error.message,
        details: error,
      });
    }

    return res.json({
      total: count || 0,
      data: allCompositions || [],
    });
  } catch (err) {
    console.error("[debug-compositions] Error:", err);
    return res.status(500).json({ error: err.message });
  }
});

router.post("/invites", async (req, res) => {
  try {
    const { email, invited_by } = req.body;
    if (!email) return res.status(400).json({ error: "Email is required" });
    const payload = {
      email: String(email).toLowerCase().trim(),
      invited_by,
      created_at: new Date().toISOString(),
      used: false,
    };
    const { data, error } = await supabase
      .from("invites")
      .insert([payload])
      .select()
      .single();
    if (error) throw error;
    return res.status(201).json(data);
  } catch (err) {
    console.error("[admin-create-invite] Error:", err);
    return res.status(500).json({ error: err.message });
  }
});

router.delete("/invites/:email", async (req, res) => {
  try {
    const { email } = req.params;
    const normalizedEmail = decodeURIComponent(email).toLowerCase().trim();
    const { error } = await supabase
      .from("invites")
      .delete()
      .eq("email", normalizedEmail);
    if (error) throw error;
    return res.json({ success: true, message: "Invite revoked" });
  } catch (err) {
    console.error("[admin-revoke-invite] Error:", err);
    return res.status(500).json({ error: err.message });
  }
});

router.post("/users/:userId/promote-composer", async (req, res) => {
  try {
    const { userId: userIdentifier } = req.params;
    const actingAdmin = await resolveDbUser(req.authUid);
    if (!actingAdmin?.id) {
      return res.status(404).json({ error: "Admin user not found" });
    }
    const user = await resolveDbUser(userIdentifier);
    if (!user)
      return res.status(404).json({ error: "User not found" });
    const userId = user.id;
    if (sameUserId(userId, actingAdmin.id)) {
      return res.status(403).json({
        error: "You cannot approve your own composer access request.",
      });
    }

    // Mark the composer request as approved in role_requests table
    const { error: updateReqErr } = await supabase
      .from("role_requests")
      .update({ status: "approved" })
      .eq("user_id", userId)
      .eq("requested_role", "composer")
      .eq("status", "pending");
    if (updateReqErr)
      console.warn(
        "[admin-promote-composer] Failed to update role_requests:",
        updateReqErr,
      );

    // Keep legacy composer_request flag in sync for UI compatibility.
    const { error: composerFlagErr } = await supabase
      .from("users")
      .update({ composer_request: false })
      .eq("id", userId);
    if (composerFlagErr)
      console.warn(
        "[admin-promote-composer] Failed to clear composer_request:",
        composerFlagErr,
      );

    try {
      const { data: roleRow } = await supabase
        .from("roles")
        .select("id")
        .eq("name", "composer")
        .maybeSingle();
      if (roleRow?.id) {
        const { data: exists } = await supabase
          .from("user_roles")
          .select("*")
          .eq("user_id", userId)
          .eq("role_id", roleRow.id)
          .maybeSingle();
        if (!exists) {
          const { error: urErr } = await supabase
            .from("user_roles")
            .insert({ user_id: userId, role_id: roleRow.id });
          if (urErr)
            console.warn(
              "[admin-promote-composer] user_roles insert warning:",
              urErr,
            );
        }
      }
    } catch (e) {
      console.warn(
        "[admin-promote-composer] role assignment failed:",
        e?.message || e,
      );
    }
    const { profile: existingComposer, activationColumnMissing } =
      await fetchComposerProfileByUserId(userId);

    if (existingComposer) {
      if (!activationColumnMissing && existingComposer.is_active === false) {
        const { error: reactivateComposerErr } = await supabase
          .from("composers")
          .update({
            is_active: true,
            updated_at: new Date().toISOString(),
          })
          .eq("id", existingComposer.id);
        if (reactivateComposerErr) throw reactivateComposerErr;
      }
    } else {
      const { error: composerInsertErr } = await supabase
        .from("composers")
        .insert([{ user_id: userId }]);
      if (
        composerInsertErr &&
        String(composerInsertErr.code || "").toUpperCase() !== "23505"
      ) {
        throw composerInsertErr;
      }
    }
    return res.json({ success: true, message: "User promoted to composer" });
  } catch (err) {
    console.error("[admin-promote-composer] Error:", err);
    return res.status(500).json({ error: err.message });
  }
});

router.post("/users/:userId/demote-composer", async (req, res) => {
  try {
    const { userId: userIdentifier } = req.params;
    const targetUser = await resolveDbUser(userIdentifier);
    if (!targetUser) {
      return res.status(404).json({ error: "User not found" });
    }

    const { profile: composerProfile, activationColumnMissing } =
      await fetchComposerProfileByUserId(targetUser.id);

    if (composerProfile && activationColumnMissing) {
      return res.status(500).json({
        message:
          "Composer activation column is missing. Run migration 027_add_composers_is_active.sql, then retry.",
      });
    }

    await removeUserRoleAssignment(targetUser.id, "composer");

    if (composerProfile?.id) {
      const { error: deactivateComposerErr } = await supabase
        .from("composers")
        .update({
          is_active: false,
          updated_at: new Date().toISOString(),
        })
        .eq("id", composerProfile.id);
      if (deactivateComposerErr) throw deactivateComposerErr;
    }

    return res.json({
      success: true,
      message: "Composer access removed",
      userId: targetUser.id,
    });
  } catch (err) {
    console.error("[admin-demote-composer] Error:", err);
    return res.status(500).json({ error: err.message });
  }
});

router.post("/users/:userId/promote-admin", async (req, res) => {
  try {
    const { userId: userIdentifier } = req.params;
    const actingAdmin = await resolveDbUser(req.authUid);
    if (!actingAdmin?.id) {
      return res.status(404).json({ error: "Admin user not found" });
    }
    const user = await resolveDbUser(userIdentifier);
    if (!user)
      return res.status(404).json({ error: "User not found" });
    const userId = user.id;
    if (sameUserId(userId, actingAdmin.id)) {
      return res.status(403).json({
        error: "You cannot approve your own admin access request.",
      });
    }

    const { data: roleRow } = await supabase
      .from("roles")
      .select("id")
      .eq("name", "admin")
      .maybeSingle();
    if (roleRow?.id) {
      const { data: exists } = await supabase
        .from("user_roles")
        .select("*")
        .eq("user_id", userId)
        .eq("role_id", roleRow.id)
        .maybeSingle();
      if (!exists) {
        const { error: urErr } = await supabase
          .from("user_roles")
          .insert({ user_id: userId, role_id: roleRow.id });
        if (urErr) throw urErr;
      }
    }

    const { error: adminReqErr } = await supabase
      .from("role_requests")
      .update({ status: "approved" })
      .eq("user_id", userId)
      .eq("requested_role", "admin")
      .eq("status", "pending");
    if (adminReqErr)
      console.warn(
        "[admin-promote-admin] Failed to update admin role request:",
        adminReqErr,
      );

    return res.json({ success: true, message: "User promoted to admin" });
  } catch (err) {
    console.error("[admin-promote-admin] Error:", err);
    return res.status(500).json({ error: err.message });
  }
});

router.post("/users/:userId/demote-admin", async (req, res) => {
  try {
    const { userId: userIdentifier } = req.params;
    const actingAdmin = await resolveDbUser(req.authUid);
    if (!actingAdmin?.id) {
      return res.status(404).json({ error: "Admin user not found" });
    }

    const targetUser = await resolveDbUser(userIdentifier);
    if (!targetUser) {
      return res.status(404).json({ error: "User not found" });
    }

    if (sameUserId(targetUser.id, actingAdmin.id)) {
      return res.status(403).json({
        error: "You cannot remove your own admin access.",
      });
    }

    const normalizedTargetEmail = String(targetUser.email || "")
      .trim()
      .toLowerCase();
    if (
      normalizedTargetEmail &&
      ADMIN_IDENTIFIERS.has(normalizedTargetEmail)
    ) {
      return res.status(403).json({
        error: "This admin is protected by the server allowlist and cannot be depromoted here.",
      });
    }

    await removeUserRoleAssignment(targetUser.id, "admin");

    if (normalizedTargetEmail) {
      const { error: deactivateAdminEmailErr } = await supabase
        .from("admin_emails")
        .update({ is_active: false })
        .ilike("email", normalizedTargetEmail)
        .eq("is_active", true);
      if (deactivateAdminEmailErr) throw deactivateAdminEmailErr;
    }

    return res.json({
      success: true,
      message: "Admin access removed",
      userId: targetUser.id,
    });
  } catch (err) {
    console.error("[admin-demote-admin] Error:", err);
    return res.status(500).json({ error: err.message });
  }
});

router.post("/users/:userId/suspend", async (req, res) => {
  try {
    const { userId: userIdentifier } = req.params;
    const user = await resolveDbUser(userIdentifier);
    if (!user) return res.status(404).json({ error: "User not found" });
    const userId = user.id;
    const { error } = await supabase
      .from("users")
      .update({ is_active: false })
      .eq("id", userId);
    if (error) throw error;
    return res.json({ success: true, message: "User suspended" });
  } catch (err) {
    console.error("[admin-suspend-user] Error:", err);
    return res.status(500).json({ error: err.message });
  }
});
router.post("/users/:userId/unsuspend", async (req, res) => {
  try {
    const { userId: userIdentifier } = req.params;
    const user = await resolveDbUser(userIdentifier);
    if (!user) return res.status(404).json({ error: "User not found" });
    const { error } = await supabase
      .from("users")
      .update({ is_active: true })
      .eq("id", user.id);
    if (error) throw error;
    return res.json({ success: true, message: "User unsuspended" });
  } catch (err) {
    console.error("[admin-unsuspend-user] Error:", err);
    return res.status(500).json({ error: err.message });
  }
});

router.delete("/users/:userId", async (req, res) => {
  try {
    const { userId: userIdentifier } = req.params;
    const targetUser = await resolveDbUser(userIdentifier);
    if (!targetUser) return res.status(404).json({ error: "User not found" });

    const userId = targetUser.id;
    const normalizedEmail = String(targetUser.email || "").trim().toLowerCase();

    await supabase.from("composers").delete().eq("user_id", userId);
    await supabase.from("user_roles").delete().eq("user_id", userId);
    await supabase.from("role_requests").delete().eq("user_id", userId);

    if (normalizedEmail) {
      const { error: deactivateAdminEmailErr } = await supabase
        .from("admin_emails")
        .update({ is_active: false })
        .ilike("email", normalizedEmail)
        .eq("is_active", true);
      if (deactivateAdminEmailErr)
        console.warn(
          "[admin-delete-user] Failed to deactivate admin email:",
          deactivateAdminEmailErr,
        );
    }

    const { error: deleteUserErr } = await supabase
      .from("users")
      .delete()
      .eq("id", userId);
    if (deleteUserErr) throw deleteUserErr;

    if (targetUser.auth_uid) {
      if (typeof supabase.auth.admin?.deleteUser === "function") {
        await supabase.auth.admin.deleteUser(targetUser.auth_uid);
      } else {
        console.warn(
          "[admin-delete-user] supabase auth admin deleteUser not available",
        );
      }
    }

    return res.json({
      success: true,
      message: "User deleted",
      userId,
    });
  } catch (err) {
    console.error("[admin-delete-user] Error:", err);
    return res.status(500).json({ error: err.message });
  }
});

router.post("/composer-requests/:userId/reject", async (req, res) => {
  try {
    const { userId: userIdentifier } = req.params;
    const user = await resolveDbUser(userIdentifier);
    const userId = user?.id || String(userIdentifier).trim();
    if (!userId) return res.status(400).json({ error: "Invalid user id" });
    // Update the pending composer request to rejected status
    const { error } = await supabase
      .from("role_requests")
      .update({ status: "rejected" })
      .eq("user_id", userId)
      .eq("requested_role", "composer")
      .eq("status", "pending");
    if (error) throw error;

    if (user?.id) {
      const { error: composerFlagErr } = await supabase
        .from("users")
        .update({ composer_request: false })
        .eq("id", user.id);
      if (composerFlagErr)
        console.warn(
          "[admin-reject-composer-request] Failed to clear composer_request:",
          composerFlagErr,
        );
    }

    return res.json({ success: true, message: "Composer request rejected" });
  } catch (err) {
    console.error("[admin-reject-composer-request] Error:", err);
    return res.status(500).json({ error: err.message });
  }
});

router.post("/role-requests/:userId/reject", async (req, res) => {
  try {
    const { userId: userIdentifier } = req.params;
    const requestedRole =
      req.body?.requestedRole === "admin" ? "admin" : "composer";
    const user = await resolveDbUser(userIdentifier);
    const userId = user?.id || String(userIdentifier).trim();
    if (!userId) return res.status(400).json({ error: "Invalid user id" });

    const { error } = await supabase
      .from("role_requests")
      .update({ status: "rejected" })
      .eq("user_id", userId)
      .eq("requested_role", requestedRole)
      .eq("status", "pending");
    if (error) throw error;

    if (requestedRole === "composer" && user?.id) {
      const { error: composerFlagErr } = await supabase
        .from("users")
        .update({ composer_request: false })
        .eq("id", user.id);
      if (composerFlagErr)
        console.warn(
          "[admin-reject-role-request] Failed to clear composer_request:",
          composerFlagErr,
        );
    }

    return res.json({
      success: true,
      message: `${requestedRole} request rejected`,
    });
  } catch (err) {
    console.error("[admin-reject-role-request] Error:", err);
    return res.status(500).json({ error: err.message });
  }
});

router.post("/payment-submissions/:submissionId/approve", async (req, res) => {
  try {
    const { submissionId } = req.params;
    const adminNotes = req.body?.adminNotes
      ? String(req.body.adminNotes).trim()
      : null;
    if (!submissionId) {
      return res.status(400).json({ error: "submissionId is required" });
    }

    const reviewer = await resolveDbUser(req.authUid);
    if (!reviewer) {
      return res.status(404).json({ error: "Reviewer user not found" });
    }

    const { data: submission, error: submissionErr } = await supabase
      .from("payment_submissions")
      .select("*")
      .eq("id", submissionId)
      .maybeSingle();
    if (submissionErr) throw submissionErr;
    if (!submission) {
      return res.status(404).json({ error: "Payment submission not found" });
    }

    const submissionOwnerUserId = await resolveBuyerOwnerUserId(
      submission.buyer_id,
    );
    if (sameUserId(submissionOwnerUserId, reviewer.id)) {
      return res.status(403).json({
        error: "You cannot approve your own payment submission.",
      });
    }

    if (submission.status === "approved") {
      return res.json({
        success: true,
        alreadyApproved: true,
        submission,
      });
    }
    if (submission.status === "rejected") {
      return res
        .status(409)
        .json({ error: "Rejected submissions cannot be approved" });
    }

    let purchaseBuyerId = submission.buyer_id;
    let { data: existingPurchase, error: existingPurchaseErr } = await supabase
      .from("purchases")
      .select("id, buyer_id, composition_id, is_active")
      .eq("buyer_id", purchaseBuyerId)
      .eq("composition_id", submission.composition_id)
      .eq("is_active", true)
      .maybeSingle();
    if (existingPurchaseErr) throw existingPurchaseErr;

    let purchase = existingPurchase || null;
    if (!purchase) {
      let purchasePayload = {
        buyer_id: purchaseBuyerId,
        composition_id: submission.composition_id,
        price_paid: Number(submission.amount || 0),
        payment_ref: submission.mpesa_code || null,
        purchased_at: new Date().toISOString(),
        is_active: true,
      };

      let insertPurchaseRes = await insertPurchaseWithFallback(purchasePayload);

      // Support schemas where purchases.buyer_id references buyers(id) instead of users(id).
      if (
        insertPurchaseRes.error &&
        isPurchasesBuyerForeignKeyError(insertPurchaseRes.error)
      ) {
        const resolvedBuyerId = await resolveBuyerIdForPurchases(
          submission.buyer_id,
        );
        if (resolvedBuyerId) {
          purchaseBuyerId = resolvedBuyerId;

          const existingByResolvedBuyerRes = await supabase
            .from("purchases")
            .select("id, buyer_id, composition_id, is_active")
            .eq("buyer_id", purchaseBuyerId)
            .eq("composition_id", submission.composition_id)
            .eq("is_active", true)
            .maybeSingle();
          if (existingByResolvedBuyerRes.error) {
            throw existingByResolvedBuyerRes.error;
          }

          purchase = existingByResolvedBuyerRes.data || null;
          if (!purchase) {
            purchasePayload = { ...purchasePayload, buyer_id: purchaseBuyerId };
            insertPurchaseRes = await insertPurchaseWithFallback(purchasePayload);
          }
        }
      }

      if (!purchase) {
        if (insertPurchaseRes.error) throw insertPurchaseRes.error;
        purchase = insertPurchaseRes.data;
      }
    }

    const { data: updatedSubmission, error: updateSubmissionErr } = await supabase
      .from("payment_submissions")
      .update({
        status: "approved",
        purchase_id: purchase?.id || null,
        reviewed_by: reviewer.id,
        reviewed_at: new Date().toISOString(),
        admin_notes: adminNotes,
      })
      .eq("id", submissionId)
      .select("*")
      .maybeSingle();
    if (updateSubmissionErr) throw updateSubmissionErr;

    // Best effort: increment composition purchases stats.
    try {
      const { data: existingStats, error: existingStatsErr } = await supabase
        .from("composition_stats")
        .select("id, purchases")
        .eq("composition_id", submission.composition_id)
        .maybeSingle();
      if (existingStatsErr) throw existingStatsErr;

      if (existingStats?.id) {
        await supabase
          .from("composition_stats")
          .update({ purchases: Number(existingStats.purchases || 0) + 1 })
          .eq("id", existingStats.id);
      } else {
        await supabase.from("composition_stats").insert({
          composition_id: submission.composition_id,
          views: 0,
          purchases: 1,
        });
      }
    } catch (statsErr) {
      console.warn(
        "[admin-approve-payment-submission] Failed to update composition stats:",
        statsErr?.message || statsErr,
      );
    }

    return res.json({
      success: true,
      message: "Payment submission approved",
      submission: updatedSubmission,
      purchase,
    });
  } catch (err) {
    console.error("[admin-approve-payment-submission] Error:", err);
    return res.status(500).json({ error: err.message });
  }
});

router.post("/payment-submissions/:submissionId/reject", async (req, res) => {
  try {
    const { submissionId } = req.params;
    const adminNotes = req.body?.adminNotes
      ? String(req.body.adminNotes).trim()
      : null;
    if (!submissionId) {
      return res.status(400).json({ error: "submissionId is required" });
    }

    const reviewer = await resolveDbUser(req.authUid);
    if (!reviewer) {
      return res.status(404).json({ error: "Reviewer user not found" });
    }

    const { data: submission, error: submissionErr } = await supabase
      .from("payment_submissions")
      .select("id, status")
      .eq("id", submissionId)
      .maybeSingle();
    if (submissionErr) throw submissionErr;
    if (!submission) {
      return res.status(404).json({ error: "Payment submission not found" });
    }

    if (submission.status === "approved") {
      return res
        .status(409)
        .json({ error: "Approved submissions cannot be rejected" });
    }

    const { data: updatedSubmission, error: updateSubmissionErr } = await supabase
      .from("payment_submissions")
      .update({
        status: "rejected",
        reviewed_by: reviewer.id,
        reviewed_at: new Date().toISOString(),
        admin_notes: adminNotes,
      })
      .eq("id", submissionId)
      .select("*")
      .maybeSingle();
    if (updateSubmissionErr) throw updateSubmissionErr;

    return res.json({
      success: true,
      message: "Payment submission rejected",
      submission: updatedSubmission,
    });
  } catch (err) {
    console.error("[admin-reject-payment-submission] Error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// Admin notifications endpoint
router.get("/notifications", async (req, res) => {
  try {
    const actingAdmin = await resolveDbUser(req.authUid);
    const actingAdminId = actingAdmin?.id || null;
    const actingAdminEmail = String(actingAdmin?.email || "")
      .trim()
      .toLowerCase();

    const [
      invitesRes,
      roleReqRes,
      paymentReqRes,
      enrollmentsRes,
      announcementThreadsRes,
    ] = await Promise.all([
      supabase
        .from("invites")
        .select("*")
        .eq("used", false)
        .order("created_at", { ascending: false })
        .limit(50),
      supabase
        .from("role_requests")
        .select("*")
        .eq("status", "pending")
        .order("requested_at", { ascending: false })
        .limit(50),
      supabase
        .from("payment_submissions")
        .select(
          "id, buyer_id, composition_id, amount, mpesa_code, status, submitted_at",
        )
        .eq("status", "pending")
        .order("submitted_at", { ascending: false })
        .limit(50),
      supabase
        .from("enrollments")
        .select(
          "id, user_id, full_name, email, music_class, skill_level, status, created_at",
        )
        .eq("status", "pending")
        .order("created_at", { ascending: false })
        .limit(50),
      supabase
        .from("support_chat_threads")
        .select(
          "id, requester_user_id, assigned_admin_user_id, subject, context, created_at, last_message_preview, deleted_by_admin",
        )
        .eq("deleted_by_admin", false)
        .ilike("context", "%announcement%")
        .order("created_at", { ascending: false })
        .limit(200),
    ]);

    if (invitesRes.error) throw invitesRes.error;
    if (roleReqRes.error) throw roleReqRes.error;

    let paymentReqData = [];
    if (paymentReqRes.error) {
      if (!isMissingPaymentSubmissionsError(paymentReqRes.error)) {
        throw paymentReqRes.error;
      }
      console.warn(
        "[admin-notifications] payment_submissions table missing; run migration 014/024 to enable payment notifications",
      );
    } else {
      paymentReqData = paymentReqRes.data || [];
    }

    let enrollmentReqData = [];
    if (enrollmentsRes.error) {
      if (!isMissingEnrollmentsError(enrollmentsRes.error)) {
        throw enrollmentsRes.error;
      }
      console.warn(
        "[admin-notifications] enrollments table missing; run migration 021 to enable enrollment notifications",
      );
    } else {
      enrollmentReqData = enrollmentsRes.data || [];
    }

    let announcementThreads = [];
    if (announcementThreadsRes.error) {
      if (!isMissingSupportChatTablesError(announcementThreadsRes.error)) {
        throw announcementThreadsRes.error;
      }
      console.warn(
        "[admin-notifications] support chat tables missing; announcement notifications disabled",
      );
    } else {
      announcementThreads = announcementThreadsRes.data || [];
    }

    const invitesData = invitesRes.data || [];
    const roleReqData = roleReqRes.data || [];

    const paymentReqDataWithOwner = await Promise.all(
      (paymentReqData || []).map(async (row) => {
        const ownerUserId = await resolveBuyerOwnerUserId(row.buyer_id).catch(
          () => null,
        );
        return {
          ...row,
          __owner_user_id: ownerUserId || null,
        };
      }),
    );

    const items = [];

    // Add invites as notifications
    (invitesData || []).forEach((invite) =>
      items.push({
        id: `invite:${invite.id}`,
        type: "invite",
        email: invite.email,
        invitedBy: invite.invited_by,
        createdAt: invite.created_at,
        used: invite.used,
      }),
    );

    // Fetch user details for all role requests.
    // Some legacy rows may store user_id as users.auth_uid instead of users.id.
    const roleUserIdentifiers = (roleReqData || [])
      .map((r) => r.user_id)
      .filter(Boolean);
    const paymentBuyerIds = (paymentReqDataWithOwner || [])
      .flatMap((p) => [p.buyer_id, p.__owner_user_id])
      .filter(Boolean);
    const enrollmentUserIds = (enrollmentReqData || [])
      .map((e) => e.user_id)
      .filter(Boolean);
    const enrollmentEmails = (enrollmentReqData || [])
      .map((e) => String(e?.email || "").trim().toLowerCase())
      .filter(Boolean);
    const announcementUserIds = (announcementThreads || [])
      .flatMap((thread) => [
        thread.requester_user_id,
        thread.assigned_admin_user_id,
      ])
      .filter(Boolean);
    const allUserIdentifiers = [
      ...new Set([
        ...roleUserIdentifiers,
        ...paymentBuyerIds,
        ...enrollmentUserIds,
        ...announcementUserIds,
      ]),
    ];
    let usersById = {};
    let usersByAuthUid = {};
    let usersByEmail = {};
    let rolesByUserId = {};
    if (allUserIdentifiers.length > 0) {
      try {
        const [usersByIdRes, usersByAuthUidRes, usersByEmailRes] =
          await Promise.all([
          supabase
            .from("users")
            .select("id, auth_uid, email, display_name")
            .in("id", allUserIdentifiers),
          supabase
            .from("users")
            .select("id, auth_uid, email, display_name")
            .in("auth_uid", allUserIdentifiers),
          enrollmentEmails.length > 0
            ? supabase
                .from("users")
                .select("id, auth_uid, email, display_name")
                .in("email", enrollmentEmails)
            : Promise.resolve({ data: [], error: null }),
          ]);

        if (usersByIdRes.error) throw usersByIdRes.error;
        if (usersByAuthUidRes.error) throw usersByAuthUidRes.error;
        if (usersByEmailRes.error) throw usersByEmailRes.error;

        const mergedUsers = [
          ...(usersByIdRes.data || []),
          ...(usersByAuthUidRes.data || []),
          ...(usersByEmailRes.data || []),
        ];

        mergedUsers.forEach((u) => {
          usersById[u.id] = u;
          if (u.auth_uid) usersByAuthUid[u.auth_uid] = u;
          const normalizedEmail = String(u.email || "").trim().toLowerCase();
          if (normalizedEmail) usersByEmail[normalizedEmail] = u;
        });

        const resolvedUserIds = [...new Set(mergedUsers.map((u) => u.id))];
        if (resolvedUserIds.length > 0) {
          const { data: roleRows, error: roleErr } = await supabase
            .from("user_roles")
            .select("user_id, roles(name)")
            .in("user_id", resolvedUserIds);
          if (roleErr) throw roleErr;

          (roleRows || []).forEach((row) => {
            const roleName = row.roles?.name;
            if (!roleName) return;
            if (!rolesByUserId[row.user_id]) rolesByUserId[row.user_id] = [];
            if (!rolesByUserId[row.user_id].includes(roleName)) {
              rolesByUserId[row.user_id].push(roleName);
            }
          });
        }
      } catch (e) {
        console.warn(
          "[admin-notifications] Failed to fetch users for role requests:",
          e?.message || e,
        );
      }
    }

    // Add role requests (composer and admin) as notifications
    (roleReqData || []).forEach((reqItem) => {
      const user =
        usersById[reqItem.user_id] || usersByAuthUid[reqItem.user_id] || null;
      if (!reqItem.user_id) return;
      const resolvedUserId = user?.id || reqItem.user_id;
      const isSelfRequest = sameUserId(resolvedUserId, actingAdminId);
      const fallbackDisplayName =
        user?.display_name ||
        user?.email ||
        `User (${String(reqItem.user_id).slice(0, 8)}...)`;
      items.push({
        id: `request:${reqItem.id}`,
        type: "request", // Generic request type for composer/admin requests
        userId: resolvedUserId,
        requestUserId: reqItem.user_id,
        canApprove: Boolean(user?.id) && !isSelfRequest,
        cannotApproveReason: !user?.id
          ? "User profile missing. You can reject this stale request."
          : isSelfRequest
            ? "You cannot approve your own role request."
            : null,
        email: user?.email || null,
        displayName: fallbackDisplayName,
        requestedRole: reqItem.requested_role,
        status: reqItem.status,
        createdAt: reqItem.requested_at,
        created_at: reqItem.requested_at,
        roles: user?.id ? rolesByUserId[user.id] || [] : [],
      });
    });

    // Add pending payment submissions as notifications
    (paymentReqDataWithOwner || []).forEach((paymentReq) => {
      const ownerUser =
        usersById[paymentReq.__owner_user_id] ||
        usersById[paymentReq.buyer_id] ||
        usersByAuthUid[paymentReq.buyer_id] ||
        null;
      const ownerUserId = ownerUser?.id || paymentReq.__owner_user_id || null;
      const isSelfPayment = sameUserId(ownerUserId, actingAdminId);
      items.push({
        id: `payment:${paymentReq.id}`,
        type: "payment_request",
        submissionId: paymentReq.id,
        userId: ownerUserId || paymentReq.buyer_id,
        canApprove: !isSelfPayment,
        cannotApproveReason: isSelfPayment
          ? "You cannot approve your own payment submission."
          : null,
        email: ownerUser?.email || null,
        displayName:
          ownerUser?.display_name ||
          ownerUser?.email ||
          `User (${String(paymentReq.buyer_id).slice(0, 8)}...)`,
        amount: Number(paymentReq.amount || 0),
        mpesaCode: paymentReq.mpesa_code || null,
        requestedRole: null,
        status: paymentReq.status,
        createdAt: paymentReq.submitted_at,
        created_at: paymentReq.submitted_at,
      });
    });

    // Add pending enrollments as notifications.
    (enrollmentReqData || []).forEach((enrollmentReq) => {
      const linkedUser =
        usersById[enrollmentReq.user_id] ||
        usersByAuthUid[enrollmentReq.user_id] ||
        usersByEmail[String(enrollmentReq.email || "").trim().toLowerCase()] ||
        null;
      const enrollmentOwnerUserId = linkedUser?.id || enrollmentReq.user_id || null;
      const isSelfEnrollment =
        sameUserId(enrollmentOwnerUserId, actingAdminId) ||
        (!enrollmentOwnerUserId &&
          sameEmail(enrollmentReq.email, actingAdminEmail));

      items.push({
        id: `enrollment:${enrollmentReq.id}`,
        type: "enrollment_request",
        enrollmentId: enrollmentReq.id,
        userId: enrollmentOwnerUserId,
        canApprove: !isSelfEnrollment,
        cannotApproveReason: isSelfEnrollment
          ? "You cannot admit your own enrollment request."
          : null,
        email: linkedUser?.email || enrollmentReq.email || null,
        displayName:
          linkedUser?.display_name ||
          enrollmentReq.full_name ||
          enrollmentReq.email ||
          "Enrollment Request",
        program: enrollmentReq.music_class || null,
        skillLevel: enrollmentReq.skill_level || null,
        status: enrollmentReq.status || "pending",
        createdAt: enrollmentReq.created_at,
        created_at: enrollmentReq.created_at,
      });
    });

    // Add announcement broadcasts as notifications (deduplicated by sender+subject+minute).
    const announcementGroups = new Map();
    (announcementThreads || []).forEach((thread) => {
      const senderUserId = thread.assigned_admin_user_id || null;
      const subject = String(thread.subject || "Platform Announcement").trim();
      const createdAt = thread.created_at || null;
      const minuteSlot = createdAt ? String(createdAt).slice(0, 16) : "";
      const key = `${senderUserId || "unknown"}|${subject}|${minuteSlot}`;
      const group = announcementGroups.get(key) || {
        id: thread.id,
        senderUserId,
        subject,
        preview: thread.last_message_preview || "",
        createdAt,
        recipientCount: 0,
      };
      group.recipientCount += 1;
      if (!group.createdAt || new Date(createdAt).getTime() > new Date(group.createdAt).getTime()) {
        group.createdAt = createdAt;
        group.id = thread.id;
        group.preview = thread.last_message_preview || group.preview;
      }
      announcementGroups.set(key, group);
    });

    [...announcementGroups.values()].forEach((announcement) => {
      const sender = announcement.senderUserId
        ? usersById[announcement.senderUserId] || null
        : null;
      items.push({
        id: `announcement:${announcement.id}`,
        type: "announcement",
        subject: announcement.subject || "Platform Announcement",
        preview: announcement.preview || "",
        displayName: sender?.display_name || sender?.email || "Admin",
        recipientCount: Number(announcement.recipientCount || 0),
        createdAt: announcement.createdAt,
        created_at: announcement.createdAt,
      });
    });

    return res.json(items);
  } catch (err) {
    console.error("[admin-notifications] Error:", err);
    return res.status(500).json({ error: err.message });
  }
});

export default router;


