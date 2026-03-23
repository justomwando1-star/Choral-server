// routes/account.js
import express from "express";
import { supabaseAdmin } from "../lib/supabaseServer.js";
import { verifySupabaseToken } from "../middleware/verifySupabaseToken.js";
import { serverError } from "../utils/errors.js";
import {
  normalizeAvatarUrl,
  withNormalizedAvatar,
} from "../utils/avatarUrl.js";
import { refreshAvatarUrl } from "../utils/avatarSignedUrl.js";

const router = express.Router();

const ALLOWED_THEME_PRESETS = new Set([
  "emerald",
  "aurora",
  "ocean",
  "sunset",
  "forest",
]);
const ALLOWED_THEME_MODES = new Set(["light", "dark"]);
const ALLOWED_DARK_HUES = new Set([
  "plum",
  "midnight",
  "graphite",
  "forest-night",
  "ember",
]);
const ALLOWED_UI_SCALES = new Set(["compact", "standard", "large"]);
const ALLOWED_ICON_SCALES = new Set(["small", "medium", "large"]);
const ALLOWED_LAYOUT_DENSITIES = new Set(["compact", "balanced", "spacious"]);
const ALLOWED_SURFACE_STYLES = new Set(["soft", "glass", "solid"]);

function normalizeThemeSettings(themeSettings, existingThemeSettings = null) {
  if (!themeSettings || typeof themeSettings !== "object") return null;

  const existingPresetRaw = String(existingThemeSettings?.preset || "")
    .trim()
    .toLowerCase();
  const existingModeRaw = String(existingThemeSettings?.mode || "")
    .trim()
    .toLowerCase();
  const existingDarkHueRaw = String(existingThemeSettings?.darkHue || "")
    .trim()
    .toLowerCase();
  const existingUiScaleRaw = String(existingThemeSettings?.uiScale || "")
    .trim()
    .toLowerCase();
  const existingIconScaleRaw = String(existingThemeSettings?.iconScale || "")
    .trim()
    .toLowerCase();
  const existingLayoutDensityRaw = String(existingThemeSettings?.layoutDensity || "")
    .trim()
    .toLowerCase();
  const existingSurfaceStyleRaw = String(existingThemeSettings?.surfaceStyle || "")
    .trim()
    .toLowerCase();

  let preset = ALLOWED_THEME_PRESETS.has(existingPresetRaw)
    ? existingPresetRaw
    : "emerald";
  let mode = ALLOWED_THEME_MODES.has(existingModeRaw) ? existingModeRaw : "light";
  let darkHue = ALLOWED_DARK_HUES.has(existingDarkHueRaw)
    ? existingDarkHueRaw
    : "plum";
  let uiScale = ALLOWED_UI_SCALES.has(existingUiScaleRaw)
    ? existingUiScaleRaw
    : "standard";
  let iconScale = ALLOWED_ICON_SCALES.has(existingIconScaleRaw)
    ? existingIconScaleRaw
    : "medium";
  let layoutDensity = ALLOWED_LAYOUT_DENSITIES.has(existingLayoutDensityRaw)
    ? existingLayoutDensityRaw
    : "balanced";
  let surfaceStyle = ALLOWED_SURFACE_STYLES.has(existingSurfaceStyleRaw)
    ? existingSurfaceStyleRaw
    : "soft";

  const hasPreset = Object.prototype.hasOwnProperty.call(themeSettings, "preset");
  const hasMode = Object.prototype.hasOwnProperty.call(themeSettings, "mode");
  const hasUiScale = Object.prototype.hasOwnProperty.call(themeSettings, "uiScale");
  const hasDarkHue = Object.prototype.hasOwnProperty.call(themeSettings, "darkHue");
  const hasIconScale = Object.prototype.hasOwnProperty.call(themeSettings, "iconScale");
  const hasLayoutDensity = Object.prototype.hasOwnProperty.call(
    themeSettings,
    "layoutDensity",
  );
  const hasSurfaceStyle = Object.prototype.hasOwnProperty.call(
    themeSettings,
    "surfaceStyle",
  );
  if (
    !hasPreset &&
    !hasMode &&
    !hasDarkHue &&
    !hasUiScale &&
    !hasIconScale &&
    !hasLayoutDensity &&
    !hasSurfaceStyle
  ) {
    return null;
  }

  if (hasPreset) {
    const presetRaw = String(themeSettings.preset || "")
      .trim()
      .toLowerCase();
    if (!ALLOWED_THEME_PRESETS.has(presetRaw)) return null;
    preset = presetRaw;
  }

  if (hasMode) {
    const modeRaw = String(themeSettings.mode || "")
      .trim()
      .toLowerCase();
    if (!ALLOWED_THEME_MODES.has(modeRaw)) return null;
    mode = modeRaw;
  }

  if (hasDarkHue) {
    const darkHueRaw = String(themeSettings.darkHue || "")
      .trim()
      .toLowerCase();
    if (!ALLOWED_DARK_HUES.has(darkHueRaw)) return null;
    darkHue = darkHueRaw;
  }

  if (hasUiScale) {
    const uiScaleRaw = String(themeSettings.uiScale || "")
      .trim()
      .toLowerCase();
    if (!ALLOWED_UI_SCALES.has(uiScaleRaw)) return null;
    uiScale = uiScaleRaw;
  }

  if (hasIconScale) {
    const iconScaleRaw = String(themeSettings.iconScale || "")
      .trim()
      .toLowerCase();
    if (!ALLOWED_ICON_SCALES.has(iconScaleRaw)) return null;
    iconScale = iconScaleRaw;
  }

  if (hasLayoutDensity) {
    const layoutDensityRaw = String(themeSettings.layoutDensity || "")
      .trim()
      .toLowerCase();
    if (!ALLOWED_LAYOUT_DENSITIES.has(layoutDensityRaw)) return null;
    layoutDensity = layoutDensityRaw;
  }

  if (hasSurfaceStyle) {
    const surfaceStyleRaw = String(themeSettings.surfaceStyle || "")
      .trim()
      .toLowerCase();
    if (!ALLOWED_SURFACE_STYLES.has(surfaceStyleRaw)) return null;
    surfaceStyle = surfaceStyleRaw;
  }

  return { preset, mode, darkHue, uiScale, iconScale, layoutDensity, surfaceStyle };
}

/**
 * PUT /api/account
 * Update current user's profile (display_name, phone, avatar_url, theme_settings).
 * Protected: requires Authorization Bearer token
 */
router.put("/", verifySupabaseToken, async (req, res) => {
  try {
    const authUid = req.authUid;
    if (!authUid) return res.status(401).json({ message: "No auth uid" });

    const { displayName, phone, avatarUrl, themeSettings } = req.body;

    // Find DB user by auth_uid
    const { data: userRow, error: userError } = await supabaseAdmin
      .from("users")
      .select("id, auth_uid, theme_settings")
      .eq("auth_uid", authUid)
      .maybeSingle();

    if (userError) throw userError;
    if (!userRow)
      return res.status(404).json({ message: "User row not found" });

    const updates = {};
    if (displayName !== undefined) updates.display_name = displayName || null;
    if (phone !== undefined) {
      const normalizedPhone = String(phone || "")
        .trim()
        .slice(0, 32);
      updates.phone = normalizedPhone || null;
    }
    if (avatarUrl !== undefined) {
      updates.avatar_url = normalizeAvatarUrl(avatarUrl);
    }
    if (themeSettings !== undefined) {
      const normalizedTheme = normalizeThemeSettings(
        themeSettings,
        userRow.theme_settings || null,
      );
      if (!normalizedTheme) {
        return res.status(400).json({
          message:
            "Invalid theme settings. Allowed presets: emerald, aurora, ocean, sunset, forest. Allowed modes: light, dark. Allowed darkHue: plum, midnight, graphite, forest-night, ember. Allowed uiScale: compact, standard, large. Allowed iconScale: small, medium, large. Allowed layoutDensity: compact, balanced, spacious. Allowed surfaceStyle: soft, glass, solid.",
        });
      }
      updates.theme_settings = normalizedTheme;
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ message: "No updatable fields provided" });
    }

    const { data: updated, error: updateErr } = await supabaseAdmin
      .from("users")
      .update(updates)
      .eq("id", userRow.id)
      .select()
      .maybeSingle();

    if (updateErr) throw updateErr;
    const prepared = await refreshAvatarUrl(withNormalizedAvatar(updated));
    return res.json(prepared);
  } catch (err) {
    return serverError(res, err);
  }
});

/**
 * DELETE /api/account
 * Delete current user (both auth and DB records). Protected; only acts on current session user.
 */
router.delete("/", verifySupabaseToken, async (req, res) => {
  try {
    const authUid = req.authUid;
    if (!authUid) return res.status(401).json({ message: "No auth uid" });

    // find user row
    const { data: userRow, error } = await supabaseAdmin
      .from("users")
      .select("id, auth_uid")
      .eq("auth_uid", authUid)
      .maybeSingle();

    if (error) throw error;
    if (!userRow) return res.status(404).json({ message: "User not found" });

    // delete user-related rows first (cascade depending on your schema)
    // e.g., delete composers, user_roles, purchases, etc. Adjust to your schema.
    await supabaseAdmin.from("composers").delete().eq("user_id", userRow.id);
    await supabaseAdmin.from("user_roles").delete().eq("user_id", userRow.id);
    // ... other cleanup as needed

    // delete the DB user row
    await supabaseAdmin.from("users").delete().eq("id", userRow.id);

    // delete the auth user using admin API
    // supabaseAdmin.auth.admin.deleteUser is available in supabase-js v2+
    if (typeof supabaseAdmin.auth.admin?.deleteUser === "function") {
      await supabaseAdmin.auth.admin.deleteUser(userRow.auth_uid);
    } else {
      console.warn(
        "supabaseAdmin.auth.admin.deleteUser not available in this sdk version",
      );
    }

    return res.json({ success: true });
  } catch (err) {
    return serverError(res, err);
  }
});

export default router;
