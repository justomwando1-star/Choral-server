import express from "express";
import { supabaseAdmin } from "../lib/supabaseServer.js";
import { verifySupabaseToken } from "../middleware/verifySupabaseToken.js";

const router = express.Router();

const PRIMARY_ROOM = {
  slug: "murekefu-community",
  name: "Murekefu Community",
  description:
    "A shared lounge for learners, composers, buyers, and the Murekefu team.",
};

const BUBBLE_TONES = new Set(["theme", "ocean", "sunset"]);
const DENSITIES = new Set(["comfortable", "compact"]);
const WALLPAPERS = new Set(["aurora", "graphite", "sunrise"]);

function normalizeText(value, max = 5000) {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .trim()
    .slice(0, max);
}

function normalizeOptionalText(value, max = 255) {
  const normalized = normalizeText(value, max);
  return normalized || null;
}

function isMissingCommunityTablesError(err) {
  const code = String(err?.code || "").toUpperCase();
  const message = String(err?.message || "").toLowerCase();
  return (
    code === "42P01" ||
    code === "PGRST204" ||
    code === "PGRST205" ||
    message.includes("community_rooms") ||
    message.includes("community_messages") ||
    message.includes("community_user_settings")
  );
}

function missingCommunityMigrationResponse(res) {
  return res.status(500).json({
    message:
      "Community chat tables are missing. Run migration 029_create_community_chat_tables.sql, then retry.",
  });
}

async function resolveDbUser(authUid) {
  if (!authUid) return null;
  const { data, error } = await supabaseAdmin
    .from("users")
    .select("id, email, display_name, avatar_url")
    .eq("auth_uid", authUid)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

async function ensurePrimaryRoom() {
  const { data: existing, error: selectErr } = await supabaseAdmin
    .from("community_rooms")
    .select("id, slug, name, description, is_public, created_at, updated_at")
    .eq("slug", PRIMARY_ROOM.slug)
    .maybeSingle();
  if (selectErr) throw selectErr;
  if (existing?.id) return existing;

  const { data: created, error: insertErr } = await supabaseAdmin
    .from("community_rooms")
    .insert({
      slug: PRIMARY_ROOM.slug,
      name: PRIMARY_ROOM.name,
      description: PRIMARY_ROOM.description,
      is_public: true,
    })
    .select("id, slug, name, description, is_public, created_at, updated_at")
    .single();
  if (insertErr) throw insertErr;
  return created;
}

async function resolveRoomById(roomId) {
  const { data, error } = await supabaseAdmin
    .from("community_rooms")
    .select("id, slug, name, description, is_public, created_at, updated_at")
    .eq("id", roomId)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

async function enrichMessages(messages) {
  const senderIds = [
    ...new Set(
      (messages || [])
        .map((message) => String(message?.sender_user_id || "").trim())
        .filter(Boolean),
    ),
  ];

  let userMap = new Map();
  if (senderIds.length > 0) {
    const { data: users, error: usersErr } = await supabaseAdmin
      .from("users")
      .select("id, display_name, email, avatar_url")
      .in("id", senderIds);
    if (usersErr) throw usersErr;
    userMap = new Map((users || []).map((user) => [user.id, user]));
  }

  return (messages || []).map((message) => ({
    ...message,
    sender: message?.sender_user_id ? userMap.get(message.sender_user_id) || null : null,
  }));
}

router.use(verifySupabaseToken);

router.get("/rooms/primary", async (_req, res) => {
  try {
    const room = await ensurePrimaryRoom();
    const { count, error: countErr } = await supabaseAdmin
      .from("community_messages")
      .select("id", { count: "exact", head: true })
      .eq("room_id", room.id)
      .is("deleted_at", null);
    if (countErr) throw countErr;

    return res.json({
      room,
      messageCount: Number(count || 0),
    });
  } catch (err) {
    console.error("[community-primary-room] Error:", err);
    if (isMissingCommunityTablesError(err)) {
      return missingCommunityMigrationResponse(res);
    }
    return res.status(500).json({
      message: err?.message || "Failed to load community room.",
    });
  }
});

router.get("/rooms/:roomId/messages", async (req, res) => {
  try {
    const roomId = String(req.params.roomId || "").trim();
    if (!roomId) {
      return res.status(400).json({ message: "Room ID is required." });
    }

    const room = await resolveRoomById(roomId);
    if (!room?.id) {
      return res.status(404).json({ message: "Community room not found." });
    }

    const limit = Math.min(Math.max(Number(req.query.limit) || 150, 1), 300);
    const { data, error } = await supabaseAdmin
      .from("community_messages")
      .select(
        "id, room_id, sender_user_id, message, attachment_url, attachment_name, attachment_kind, metadata, created_at, updated_at",
      )
      .eq("room_id", room.id)
      .is("deleted_at", null)
      .order("created_at", { ascending: true })
      .limit(limit);
    if (error) throw error;

    return res.json({
      room,
      messages: await enrichMessages(data || []),
    });
  } catch (err) {
    console.error("[community-room-messages] Error:", err);
    if (isMissingCommunityTablesError(err)) {
      return missingCommunityMigrationResponse(res);
    }
    return res.status(500).json({
      message: err?.message || "Failed to load community messages.",
    });
  }
});

router.post("/rooms/:roomId/messages", async (req, res) => {
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

    const roomId = String(req.params.roomId || "").trim();
    const room = await resolveRoomById(roomId);
    if (!room?.id) {
      return res.status(404).json({ message: "Community room not found." });
    }

    const message = normalizeOptionalText(req.body?.message, 5000);
    const attachmentUrl = normalizeOptionalText(
      req.body?.attachmentUrl || req.body?.attachment_url,
      2000,
    );
    const attachmentName = normalizeOptionalText(
      req.body?.attachmentName || req.body?.attachment_name,
      255,
    );
    const attachmentKindRaw = String(
      req.body?.attachmentKind || req.body?.attachment_kind || "text",
    )
      .trim()
      .toLowerCase();
    const attachmentKind = attachmentKindRaw === "image" ? "image" : "text";
    const metadata =
      req.body?.metadata && typeof req.body.metadata === "object"
        ? req.body.metadata
        : {};

    if (!message && !attachmentUrl) {
      return res.status(400).json({
        message: "Add a message or an attachment before sending.",
      });
    }

    const { data: created, error: insertErr } = await supabaseAdmin
      .from("community_messages")
      .insert({
        room_id: room.id,
        sender_user_id: user.id,
        message,
        attachment_url: attachmentUrl,
        attachment_name: attachmentName,
        attachment_kind: attachmentKind,
        metadata,
      })
      .select(
        "id, room_id, sender_user_id, message, attachment_url, attachment_name, attachment_kind, metadata, created_at, updated_at",
      )
      .single();
    if (insertErr) throw insertErr;

    const [messageWithSender] = await enrichMessages([created]);
    return res.status(201).json({
      success: true,
      message: messageWithSender,
    });
  } catch (err) {
    console.error("[community-send-message] Error:", err);
    if (isMissingCommunityTablesError(err)) {
      return missingCommunityMigrationResponse(res);
    }
    return res.status(500).json({
      message: err?.message || "Failed to send community message.",
    });
  }
});

router.get("/settings/me", async (req, res) => {
  try {
    const authUid = req.authUid;
    if (!authUid) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const user = await resolveDbUser(authUid);
    if (!user?.id) {
      return res.status(404).json({ message: "User profile not found." });
    }

    const { data, error } = await supabaseAdmin
      .from("community_user_settings")
      .select("bubble_tone, density, wallpaper")
      .eq("user_id", user.id)
      .maybeSingle();
    if (error) throw error;

    return res.json({
      settings: {
        bubbleTone: data?.bubble_tone || "theme",
        density: data?.density || "comfortable",
        wallpaper: data?.wallpaper || "aurora",
      },
    });
  } catch (err) {
    console.error("[community-settings-get] Error:", err);
    if (isMissingCommunityTablesError(err)) {
      return missingCommunityMigrationResponse(res);
    }
    return res.status(500).json({
      message: err?.message || "Failed to load community settings.",
    });
  }
});

router.put("/settings/me", async (req, res) => {
  try {
    const authUid = req.authUid;
    if (!authUid) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const user = await resolveDbUser(authUid);
    if (!user?.id) {
      return res.status(404).json({ message: "User profile not found." });
    }

    const bubbleTone = String(req.body?.bubbleTone || req.body?.bubble_tone || "theme")
      .trim()
      .toLowerCase();
    const density = String(req.body?.density || "comfortable")
      .trim()
      .toLowerCase();
    const wallpaper = String(req.body?.wallpaper || "aurora")
      .trim()
      .toLowerCase();

    if (!BUBBLE_TONES.has(bubbleTone)) {
      return res.status(400).json({ message: "Unsupported bubble tone." });
    }
    if (!DENSITIES.has(density)) {
      return res.status(400).json({ message: "Unsupported chat density." });
    }
    if (!WALLPAPERS.has(wallpaper)) {
      return res.status(400).json({ message: "Unsupported wallpaper option." });
    }

    const { data, error } = await supabaseAdmin
      .from("community_user_settings")
      .upsert(
        {
          user_id: user.id,
          bubble_tone: bubbleTone,
          density,
          wallpaper,
        },
        { onConflict: "user_id" },
      )
      .select("bubble_tone, density, wallpaper")
      .single();
    if (error) throw error;

    return res.json({
      success: true,
      settings: {
        bubbleTone: data?.bubble_tone || "theme",
        density: data?.density || "comfortable",
        wallpaper: data?.wallpaper || "aurora",
      },
    });
  } catch (err) {
    console.error("[community-settings-update] Error:", err);
    if (isMissingCommunityTablesError(err)) {
      return missingCommunityMigrationResponse(res);
    }
    return res.status(500).json({
      message: err?.message || "Failed to save community settings.",
    });
  }
});

export default router;
