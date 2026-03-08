import express from "express";
import { supabaseAdmin } from "../lib/supabaseServer.js";
import { verifySupabaseToken } from "../middleware/verifySupabaseToken.js";

const router = express.Router();

router.use(verifySupabaseToken);

function isMissingNotificationReadsTableError(err) {
  const code = String(err?.code || "").toUpperCase();
  const message = String(err?.message || "").toLowerCase();
  return (
    code === "42P01" ||
    code === "PGRST204" ||
    code === "PGRST205" ||
    message.includes("user_notification_reads")
  );
}

async function resolveCurrentUser(authUid) {
  if (!authUid) return null;
  const { data, error } = await supabaseAdmin
    .from("users")
    .select("id, auth_uid, email")
    .eq("auth_uid", String(authUid).trim())
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

function normalizeNotificationIds(input) {
  if (!Array.isArray(input)) return [];
  return [...new Set(
    input
      .map((value) => String(value || "").trim())
      .filter(Boolean),
  )];
}

router.get("/read", async (req, res) => {
  try {
    const user = await resolveCurrentUser(req.authUid);
    if (!user?.id) {
      return res.status(404).json({ message: "User profile not found", ids: [] });
    }

    const { data, error } = await supabaseAdmin
      .from("user_notification_reads")
      .select("notification_id")
      .eq("user_id", user.id);

    if (error) {
      if (isMissingNotificationReadsTableError(error)) {
        console.warn(
          "[notification-reads] user_notification_reads table missing; run migration 025 to enable persisted notification dismissal",
        );
        return res.json({ ids: [] });
      }
      throw error;
    }

    return res.json({
      ids: (data || [])
        .map((row) => String(row?.notification_id || "").trim())
        .filter(Boolean),
    });
  } catch (err) {
    console.error("[notification-reads-fetch] Error:", err);
    return res.status(500).json({
      message: "Failed to load notification read state",
      error: err?.message || "UNKNOWN_ERROR",
    });
  }
});

router.post("/mark-read", async (req, res) => {
  try {
    const user = await resolveCurrentUser(req.authUid);
    if (!user?.id) {
      return res.status(404).json({ message: "User profile not found" });
    }

    const notificationIds = normalizeNotificationIds(
      req.body?.notificationIds || req.body?.ids,
    );

    if (notificationIds.length === 0) {
      return res.json({ success: true, markedCount: 0, notificationIds: [] });
    }

    const payload = notificationIds.map((notificationId) => ({
      user_id: user.id,
      notification_id: notificationId,
      read_at: new Date().toISOString(),
    }));

    const { error } = await supabaseAdmin
      .from("user_notification_reads")
      .upsert(payload, {
        onConflict: "user_id,notification_id",
      });

    if (error) {
      if (isMissingNotificationReadsTableError(error)) {
        return res.status(503).json({
          message:
            "Notification read tracking is not available yet. Run migration 025_create_user_notification_reads_table.sql and retry.",
        });
      }
      throw error;
    }

    return res.json({
      success: true,
      markedCount: notificationIds.length,
      notificationIds,
    });
  } catch (err) {
    console.error("[notification-reads-mark] Error:", err);
    return res.status(500).json({
      message: "Failed to mark notifications as read",
      error: err?.message || "UNKNOWN_ERROR",
    });
  }
});

export default router;
