// routes/roles.js
import express from "express";
import { supabaseAdmin } from "../lib/supabaseServer.js";
import { serverError } from "../utils/errors.js";
const router = express.Router();
const ADMIN_IDENTIFIERS = new Set(
  String(process.env.ADMIN_IDENTIFIERS || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean),
);

function isMissingSchemaObjectError(err) {
  const code = String(err?.code || "").toUpperCase();
  const message = String(err?.message || "").toLowerCase();
  return (
    code === "42P01" ||
    code === "PGRST200" ||
    code === "PGRST201" ||
    code === "PGRST202" ||
    code === "PGRST204" ||
    code === "PGRST205" ||
    message.includes("does not exist") ||
    message.includes("schema cache")
  );
}

function isTransientSupabaseError(err) {
  const code = String(err?.code || "").toUpperCase();
  const message = String(err?.message || "").toLowerCase();
  return (
    code === "ECONNRESET" ||
    code === "ENOTFOUND" ||
    code === "ECONNREFUSED" ||
    code === "ETIMEDOUT" ||
    code === "UND_ERR_CONNECT_TIMEOUT" ||
    message.includes("fetch failed") ||
    message.includes("network") ||
    message.includes("connect timeout")
  );
}

// GET /api/user/roles/:authUid
router.get("/roles/:authUid", async (req, res) => {
  try {
    const { authUid } = req.params;
    if (!authUid)
      return res.status(400).json({ error: "Auth UID is required" });

    const { data: userData, error: userError } = await supabaseAdmin
      .from("users")
      .select("id, auth_uid, email")
      .eq("auth_uid", authUid)
      .maybeSingle();

    if (userError) throw userError;
    // Keep baseline access even if profile sync is delayed.
    if (!userData) return res.json(["buyer"]);
    const normalizedEmail = String(userData.email || "")
      .trim()
      .toLowerCase();

    const roles = [];
    const addRole = (roleName) => {
      if (roleName && !roles.includes(roleName)) roles.push(roleName);
    };

    // user_roles join
    try {
      const { data: userRoleRows, error: userRoleErr } = await supabaseAdmin
        .from("user_roles")
        .select("roles(name)")
        .eq("user_id", userData.id);
      if (userRoleErr) {
        if (!isMissingSchemaObjectError(userRoleErr)) throw userRoleErr;
        console.warn("[roles] user_roles relation unavailable:", userRoleErr.message);
      } else if (userRoleRows && userRoleRows.length > 0) {
        userRoleRows.forEach((r) => {
          if (r.roles && r.roles.name) addRole(r.roles.name);
        });
      }
    } catch (roleJoinErr) {
      if (!isMissingSchemaObjectError(roleJoinErr)) throw roleJoinErr;
      console.warn(
        "[roles] user_roles relation unavailable:",
        roleJoinErr?.message || roleJoinErr,
      );
    }

    // check composers table
    try {
      const { data: composerData, error: composerErr } = await supabaseAdmin
        .from("composers")
        .select("id")
        .eq("user_id", userData.id)
        .maybeSingle();
      if (composerErr) {
        if (!isMissingSchemaObjectError(composerErr)) throw composerErr;
        console.warn("[roles] composers table unavailable:", composerErr.message);
      } else if (composerData) {
        addRole("composer");
      }
    } catch (composerLookupErr) {
      if (!isMissingSchemaObjectError(composerLookupErr)) throw composerLookupErr;
      console.warn(
        "[roles] composers table unavailable:",
        composerLookupErr?.message || composerLookupErr,
      );
    }

    // check admin_emails table
    if (normalizedEmail && ADMIN_IDENTIFIERS.has(normalizedEmail)) {
      addRole("admin");
    }

    if (!roles.includes("admin") && normalizedEmail) {
      try {
        const { data: adminEmail, error: adminEmailErr } = await supabaseAdmin
          .from("admin_emails")
          .select("id")
          .ilike("email", normalizedEmail)
          .eq("is_active", true)
          .maybeSingle();
        if (adminEmailErr) {
          if (!isMissingSchemaObjectError(adminEmailErr)) throw adminEmailErr;
          console.warn(
            "[roles] admin_emails table unavailable:",
            adminEmailErr.message,
          );
        } else if (adminEmail) {
          addRole("admin");
        }
      } catch (adminLookupErr) {
        if (!isMissingSchemaObjectError(adminLookupErr)) throw adminLookupErr;
        console.warn(
          "[roles] admin_emails table unavailable:",
          adminLookupErr?.message || adminLookupErr,
        );
      }
    }

    // Every authenticated user is a buyer by default.
    addRole("buyer");

    // Best effort: persist buyer role mapping to user_roles for consistency.
    try {
      const { data: buyerRole, error: buyerRoleErr } = await supabaseAdmin
        .from("roles")
        .select("id")
        .eq("name", "buyer")
        .maybeSingle();

      if (buyerRoleErr) throw buyerRoleErr;

      if (buyerRole?.id) {
        const { data: existingBuyer, error: existingBuyerErr } =
          await supabaseAdmin
            .from("user_roles")
            .select("user_id")
            .eq("user_id", userData.id)
            .eq("role_id", buyerRole.id)
            .maybeSingle();

        if (existingBuyerErr) throw existingBuyerErr;

        if (!existingBuyer) {
          const { error: insertBuyerErr } = await supabaseAdmin
            .from("user_roles")
            .insert({ user_id: userData.id, role_id: buyerRole.id });
          if (insertBuyerErr && insertBuyerErr.code !== "23505") {
            throw insertBuyerErr;
          }
        }
      }
    } catch (buyerAssignErr) {
      console.warn(
        "[roles] Failed to persist buyer role mapping:",
        buyerAssignErr?.message || buyerAssignErr,
      );
    }

    return res.json(roles);
  } catch (err) {
    if (isTransientSupabaseError(err)) {
      console.warn(
        "[roles] transient supabase error; returning buyer fallback:",
        err?.message || err,
      );
      return res.json(["buyer"]);
    }
    return serverError(res, err);
  }
});

export default router;
