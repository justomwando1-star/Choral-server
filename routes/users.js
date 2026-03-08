import express from "express";
import { supabaseAdmin } from "../lib/supabaseServer.js";
import { verifySupabaseToken } from "../middleware/verifySupabaseToken.js";
import { serverError } from "../utils/errors.js";
import {
  isValidAvatarUrl,
  normalizeAvatarUrl,
  withNormalizedAvatar,
} from "../utils/avatarUrl.js";
import { refreshAvatarUrl } from "../utils/avatarSignedUrl.js";

const router = express.Router();
const ADMIN_IDENTIFIERS = new Set(
  String(process.env.ADMIN_IDENTIFIERS || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean),
);

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

async function hasActiveComposerProfile(userId) {
  let { data, error } = await supabaseAdmin
    .from("composers")
    .select("id, is_active")
    .eq("user_id", userId)
    .eq("is_active", true)
    .maybeSingle();

  if (error && isMissingComposerActivationColumnError(error)) {
    const fallback = await supabaseAdmin
      .from("composers")
      .select("id")
      .eq("user_id", userId)
      .maybeSingle();
    if (fallback.error) throw fallback.error;
    return Boolean(fallback.data);
  }

  if (error) throw error;
  return Boolean(data);
}

async function prepareUserResponse(userRow) {
  return await refreshAvatarUrl(withNormalizedAvatar(userRow));
}

async function resolveUserRoles(userRow) {
  const roles = ["buyer"];
  const userId = userRow?.id;
  const normalizedEmail = String(userRow?.email || "")
    .trim()
    .toLowerCase();

  if (!userId) {
    if (normalizedEmail && ADMIN_IDENTIFIERS.has(normalizedEmail)) {
      roles.push("admin");
    }
    return roles;
  }

  // Primary source: explicit role assignments
  const { data: roleRows, error: roleRowsErr } = await supabaseAdmin
    .from("user_roles")
    .select("roles(name)")
    .eq("user_id", userId);
  if (roleRowsErr) throw roleRowsErr;

  (roleRows || []).forEach((row) => {
    const roleName = row?.roles?.name;
    if (roleName && !roles.includes(roleName)) roles.push(roleName);
  });

  // Safety check for composer legacy compatibility.
  const composerActive = await hasActiveComposerProfile(userId);
  if (composerActive && !roles.includes("composer")) roles.push("composer");

  // Admin via env allowlist / admin_emails fallback.
  if (normalizedEmail && ADMIN_IDENTIFIERS.has(normalizedEmail)) {
    if (!roles.includes("admin")) roles.push("admin");
  } else if (normalizedEmail) {
    const { data: adminEmail } = await supabaseAdmin
      .from("admin_emails")
      .select("id")
      .ilike("email", normalizedEmail)
      .eq("is_active", true)
      .maybeSingle();
    if (adminEmail && !roles.includes("admin")) roles.push("admin");
  }

  return roles;
}

// GET /api/users/:id
router.get("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    if (!id) return res.status(400).json({ message: "id is required" });

    const { data, error } = await supabaseAdmin
      .from("users")
      // select user profile
      .select(
        `id, auth_uid, email, display_name, phone, avatar_url, theme_settings, created_at`,
      )
      .eq("id", id)
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ message: "User not found" });

    const roles = await resolveUserRoles(data);

    const prepared = await prepareUserResponse(data);
    return res.json({ ...prepared, roles });
  } catch (err) {
    console.error("[get-user] Error:", err);
    return serverError(res, err);
  }
});

// GET /api/users/by-auth-uid/:authUid
router.get("/by-auth-uid/:authUid", async (req, res) => {
  try {
    const { authUid } = req.params;
    if (!authUid) return res.status(400).json({ message: "authUid is required" });

    const { data, error } = await supabaseAdmin
      .from("users")
      // select user profile
      .select(
        `id, auth_uid, email, display_name, phone, avatar_url, theme_settings, created_at`,
      )
      .eq("auth_uid", authUid)
      .maybeSingle();

    if (error) throw error;
    if (!data) return res.status(404).json({ message: "User not found" });

    const roles = await resolveUserRoles(data);

    const prepared = await prepareUserResponse(data);
    return res.json({ ...prepared, roles });
  } catch (err) {
    console.error("[get-user-by-auth-uid] Error:", err);
    return serverError(res, err);
  }
});

// POST /api/users/ensure
router.post("/ensure", async (req, res) => {
  try {
    const { auth_uid, email, display_name, phone, avatar_url, theme_settings } =
      req.body;
    if (!auth_uid) return res.status(400).json({ message: "auth_uid required" });
    const normalizedEmail = email ? String(email).trim().toLowerCase() : null;
    const normalizedAvatarUrl = normalizeAvatarUrl(avatar_url);

    const { data: existing, error: existingErr } = await supabaseAdmin
      .from("users")
      .select(
        "id, auth_uid, email, display_name, phone, avatar_url, theme_settings",
      )
      .eq("auth_uid", auth_uid)
      .maybeSingle();

    if (existingErr) throw existingErr;
    if (existing) return res.json(await prepareUserResponse(existing));

    // Handle existing user rows by email to avoid unique constraint violations
    if (normalizedEmail) {
      const { data: emailMatch, error: emailErr } = await supabaseAdmin
        .from("users")
        .select(
          "id, auth_uid, email, display_name, phone, avatar_url, theme_settings",
        )
        .eq("email", normalizedEmail)
        .maybeSingle();

      if (emailErr) throw emailErr;

      if (emailMatch) {
        const { data: updated, error: updateErr } = await supabaseAdmin
          .from("users")
          .update({
            auth_uid,
            display_name: display_name || emailMatch.display_name || null,
            phone: phone || emailMatch.phone || null,
            avatar_url: normalizedAvatarUrl || emailMatch.avatar_url || null,
            theme_settings: theme_settings || emailMatch.theme_settings || null,
          })
          .eq("id", emailMatch.id)
          .select(
            "id, auth_uid, email, display_name, phone, avatar_url, theme_settings",
          )
          .maybeSingle();

        if (updateErr) throw updateErr;
        return res.json(await prepareUserResponse(updated || emailMatch));
      }
    }

    const { data: created, error: createErr } = await supabaseAdmin
      .from("users")
      .insert({
        auth_uid,
        email: normalizedEmail || null,
        display_name: display_name || null,
        phone: phone || null,
        avatar_url: normalizedAvatarUrl || null,
        theme_settings:
          theme_settings && typeof theme_settings === "object"
            ? theme_settings
            : { preset: "emerald" },
      })
      .select()
      .maybeSingle();

    if (createErr) {
      // Race-safe fallback: if another request inserted concurrently, return that row.
      if (createErr.code === "23505") {
        const { data: conflictRow, error: conflictErr } = await supabaseAdmin
          .from("users")
          .select(
            "id, auth_uid, email, display_name, phone, avatar_url, theme_settings",
          )
          .or(
            normalizedEmail
              ? `auth_uid.eq.${auth_uid},email.eq.${normalizedEmail}`
              : `auth_uid.eq.${auth_uid}`,
          )
          .limit(1)
          .maybeSingle();
        if (conflictErr) throw conflictErr;

        if (
          conflictRow &&
          normalizedEmail &&
          conflictRow.email === normalizedEmail &&
          conflictRow.auth_uid !== auth_uid
        ) {
          const { data: remapped, error: remapErr } = await supabaseAdmin
            .from("users")
            .update({
              auth_uid,
              display_name: display_name || conflictRow.display_name || null,
              phone: phone || conflictRow.phone || null,
              avatar_url: normalizedAvatarUrl || conflictRow.avatar_url || null,
              theme_settings: theme_settings || conflictRow.theme_settings || null,
            })
            .eq("id", conflictRow.id)
            .select(
              "id, auth_uid, email, display_name, phone, avatar_url, theme_settings",
            )
            .maybeSingle();
          if (remapErr) throw remapErr;
          if (remapped) return res.json(withNormalizedAvatar(remapped));
        }

        if (conflictRow) return res.json(await prepareUserResponse(conflictRow));
      }
      throw createErr;
    }
    return res.status(201).json(await prepareUserResponse(created));
  } catch (err) {
    return serverError(res, err);
  }
});

// PUT /api/users/:id
router.put("/:id", verifySupabaseToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { display_name, phone, avatar_url, email } = req.body;
    if (!id) return res.status(400).json({ message: "id is required" });

    // Validate avatar URL - only accept Supabase URLs or null
    if (avatar_url !== undefined) {
      if (!isValidAvatarUrl(avatar_url)) {
        console.warn("[update-user] Invalid avatar URL rejected:", avatar_url);
        return res.status(400).json({
          message:
            "Invalid avatar URL. Only Supabase storage URLs are accepted.",
        });
      }
    }

    const payload = {};
    if (display_name !== undefined) payload.display_name = display_name || null;
    if (phone !== undefined) payload.phone = phone || null;
    if (avatar_url !== undefined) payload.avatar_url = normalizeAvatarUrl(avatar_url);
    if (email !== undefined) payload.email = email || null;
    if (Object.keys(payload).length === 0)
      return res.status(400).json({ message: "No updatable fields provided" });
    const { data, error } = await supabaseAdmin
      .from("users")
      .update(payload)
      .eq("id", id)
      .select()
      .single();
    if (error) throw error;
    const prepared = await prepareUserResponse(data);
    return res.json({ message: "User updated", user: prepared });
  } catch (err) {
    console.error("[update-user] Error:", err);
    return serverError(res, err);
  }
});

export default router;
