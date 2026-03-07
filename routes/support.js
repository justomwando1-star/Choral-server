import express from "express";
import { supabaseAdmin } from "../lib/supabaseServer.js";
import {
  verifySupabaseToken,
  adminOnly,
} from "../middleware/verifySupabaseToken.js";
import { withNormalizedAvatar } from "../utils/avatarUrl.js";

const router = express.Router();

const OPEN_TICKET_STATUSES = ["pending", "open", "active"];
const CLOSED_TICKET_STATUSES = new Set([
  "expired",
  "rejected",
  "deleted",
  "resolved",
]);
const TICKET_LIFETIME_DAYS = 30;
const TICKET_REJECTED_MESSAGE =
  "Your ticket was rejected by all available admins. Please open a new ticket if you still need help.";
const TICKET_EXPIRED_MESSAGE =
  "This ticket expired after 30 days. Please open a new ticket if your issue is still unresolved.";

function normalizeText(value, max = 2000) {
  return String(value || "")
    .trim()
    .slice(0, max);
}

function parseLimit(raw, fallback = 50, max = 500) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}

function isOpenTicketStatus(status) {
  return OPEN_TICKET_STATUSES.includes(String(status || "").toLowerCase());
}

function isClosedTicketStatus(status) {
  return CLOSED_TICKET_STATUSES.has(String(status || "").toLowerCase());
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
    message.includes("support_chat_messages") ||
    message.includes("support_chat_rejections") ||
    message.includes("assigned_admin_user_id") ||
    message.includes("assigned_at") ||
    message.includes("expires_at")
  );
}

function missingMigrationResponse(res) {
  return res.status(500).json({
    message:
      "Support ticket tables/columns are missing. Run migrations 018 and 019, then retry.",
  });
}

function mapThreadForResponse(thread, requester = null, rejectionCount = 0) {
  if (!thread) return null;

  return {
    id: thread.id,
    requester_user_id: thread.requester_user_id,
    subject: thread.subject,
    context: thread.context,
    status: thread.status,
    is_admin_unread: Boolean(thread.is_admin_unread),
    is_user_unread: Boolean(thread.is_user_unread),
    last_message_preview: thread.last_message_preview || "",
    last_sender_role: thread.last_sender_role || null,
    last_message_at: thread.last_message_at,
    deleted_by_admin: Boolean(thread.deleted_by_admin),
    assigned_admin_user_id: thread.assigned_admin_user_id || null,
    assigned_at: thread.assigned_at || null,
    expires_at: thread.expires_at || null,
    ticket_rejection_count: Number(rejectionCount || 0),
    is_closed: isClosedTicketStatus(thread.status),
    created_at: thread.created_at,
    updated_at: thread.updated_at,
    requester,
  };
}

async function resolveDbUser(authUid) {
  const { data, error } = await supabaseAdmin
    .from("users")
    .select("id, auth_uid, email, display_name, avatar_url, is_active")
    .eq("auth_uid", authUid)
    .maybeSingle();

  if (error) throw error;
  return data ? withNormalizedAvatar(data) : null;
}

async function isAdminUser(user) {
  if (!user?.id) return false;

  const { data: roleRows, error: roleErr } = await supabaseAdmin
    .from("user_roles")
    .select("roles(name)")
    .eq("user_id", user.id);

  if (!roleErr) {
    const hasAdminRole = (roleRows || []).some(
      (row) => String(row?.roles?.name || "").toLowerCase() === "admin",
    );
    if (hasAdminRole) return true;
  }

  const normalizedEmail = String(user?.email || "").trim().toLowerCase();
  if (!normalizedEmail) return false;

  const { data: adminEmail, error: adminErr } = await supabaseAdmin
    .from("admin_emails")
    .select("id")
    .ilike("email", normalizedEmail)
    .eq("is_active", true)
    .maybeSingle();

  if (adminErr) throw adminErr;
  return Boolean(adminEmail);
}

async function getActiveAdminUserIds() {
  const adminIds = new Set();

  const { data: roleRows, error: roleErr } = await supabaseAdmin
    .from("user_roles")
    .select("user_id, roles(name)");
  if (roleErr) throw roleErr;

  const roleAdminIds = [
    ...new Set(
      (roleRows || [])
        .filter((row) => String(row?.roles?.name || "").toLowerCase() === "admin")
        .map((row) => row.user_id)
        .filter(Boolean),
    ),
  ];

  if (roleAdminIds.length > 0) {
    const { data: usersByRole, error: usersByRoleErr } = await supabaseAdmin
      .from("users")
      .select("id, is_active")
      .in("id", roleAdminIds);
    if (usersByRoleErr) throw usersByRoleErr;

    (usersByRole || []).forEach((user) => {
      if (user?.id && user?.is_active !== false) {
        adminIds.add(user.id);
      }
    });
  }

  const { data: adminEmails, error: adminEmailsErr } = await supabaseAdmin
    .from("admin_emails")
    .select("email")
    .eq("is_active", true);
  if (adminEmailsErr) throw adminEmailsErr;

  const emailList = (adminEmails || [])
    .map((row) => String(row?.email || "").trim().toLowerCase())
    .filter(Boolean);

  if (emailList.length > 0) {
    const { data: usersByEmail, error: usersByEmailErr } = await supabaseAdmin
      .from("users")
      .select("id, email, is_active")
      .in("email", emailList);
    if (usersByEmailErr) throw usersByEmailErr;

    (usersByEmail || []).forEach((user) => {
      if (user?.id && user?.is_active !== false) {
        adminIds.add(user.id);
      }
    });
  }

  return [...adminIds];
}

async function loadRequesterMap(rows) {
  const requesterIds = [
    ...new Set((rows || []).map((row) => row.requester_user_id).filter(Boolean)),
  ];

  if (requesterIds.length === 0) return {};

  const { data: users, error } = await supabaseAdmin
    .from("users")
    .select("id, email, display_name, avatar_url")
    .in("id", requesterIds);
  if (error) throw error;

  const map = {};
  (users || []).forEach((user) => {
    map[user.id] = withNormalizedAvatar(user);
  });
  return map;
}

async function loadRejectionCountMap(threadIds) {
  if (!threadIds || threadIds.length === 0) return {};

  const { data: rows, error } = await supabaseAdmin
    .from("support_chat_rejections")
    .select("thread_id")
    .in("thread_id", threadIds);
  if (error) throw error;

  const map = {};
  (rows || []).forEach((row) => {
    if (!row?.thread_id) return;
    map[row.thread_id] = Number(map[row.thread_id] || 0) + 1;
  });
  return map;
}

async function getThreadById(threadId) {
  const { data, error } = await supabaseAdmin
    .from("support_chat_threads")
    .select("*")
    .eq("id", threadId)
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

function canAccessThread(thread, user, isAdmin) {
  if (!thread || !user?.id) return false;
  if (thread.deleted_by_admin) return false;

  if (isAdmin) {
    return thread.assigned_admin_user_id === user.id;
  }

  return thread.requester_user_id === user.id;
}

async function expireOverdueTickets() {
  const nowIso = new Date().toISOString();

  const { data: overdueRows, error: overdueErr } = await supabaseAdmin
    .from("support_chat_threads")
    .select("id")
    .eq("deleted_by_admin", false)
    .lt("expires_at", nowIso)
    .in("status", OPEN_TICKET_STATUSES)
    .limit(1000);

  if (overdueErr) throw overdueErr;
  if (!overdueRows || overdueRows.length === 0) return;

  const overdueIds = overdueRows.map((row) => row.id).filter(Boolean);
  if (overdueIds.length === 0) return;

  const { data: expiredRows, error: expireErr } = await supabaseAdmin
    .from("support_chat_threads")
    .update({
      status: "expired",
      is_admin_unread: false,
      is_user_unread: true,
      last_sender_role: "admin",
      last_message_preview: TICKET_EXPIRED_MESSAGE,
      last_message_at: nowIso,
      updated_at: nowIso,
    })
    .in("id", overdueIds)
    .in("status", OPEN_TICKET_STATUSES)
    .select("id");

  if (expireErr) throw expireErr;

  const newlyExpiredIds = (expiredRows || []).map((row) => row.id).filter(Boolean);
  if (newlyExpiredIds.length === 0) return;

  const messageRows = newlyExpiredIds.map((threadId) => ({
    thread_id: threadId,
    sender_user_id: null,
    sender_role: "admin",
    message: TICKET_EXPIRED_MESSAGE,
    created_at: nowIso,
  }));

  const { error: messageErr } = await supabaseAdmin
    .from("support_chat_messages")
    .insert(messageRows);

  if (messageErr) {
    console.warn("[support-expire] failed to insert expiry messages:", messageErr);
  }
}

async function createThreadWithInitialMessage({
  requesterUserId,
  subject,
  message,
  context,
}) {
  const now = new Date();
  const nowIso = now.toISOString();
  const expiresAtIso = new Date(
    now.getTime() + TICKET_LIFETIME_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();

  const normalizedSubject = normalizeText(subject, 160) || "Support Request";
  const normalizedMessage = normalizeText(message, 4000);
  const normalizedContext = normalizeText(context, 120) || "dashboard";

  if (!normalizedMessage) {
    const error = new Error("Issue message is required");
    error.statusCode = 400;
    throw error;
  }

  const { data: thread, error: threadErr } = await supabaseAdmin
    .from("support_chat_threads")
    .insert({
      requester_user_id: requesterUserId,
      subject: normalizedSubject,
      context: normalizedContext,
      status: "pending",
      assigned_admin_user_id: null,
      assigned_at: null,
      expires_at: expiresAtIso,
      is_admin_unread: true,
      is_user_unread: false,
      last_message_preview: normalizedMessage.slice(0, 500),
      last_sender_role: "member",
      last_message_at: nowIso,
      created_at: nowIso,
      updated_at: nowIso,
    })
    .select("*")
    .single();

  if (threadErr) throw threadErr;

  const { data: insertedMessage, error: msgErr } = await supabaseAdmin
    .from("support_chat_messages")
    .insert({
      thread_id: thread.id,
      sender_user_id: requesterUserId,
      sender_role: "member",
      message: normalizedMessage,
      created_at: nowIso,
    })
    .select("*")
    .single();

  if (msgErr) throw msgErr;

  return { thread, insertedMessage };
}

async function loadMemberThreadsForUser(userId, limit = 100) {
  const { data: rows, error } = await supabaseAdmin
    .from("support_chat_threads")
    .select("*")
    .eq("requester_user_id", userId)
    .eq("deleted_by_admin", false)
    .order("last_message_at", { ascending: false })
    .limit(limit);
  if (error) throw error;

  const threadIds = (rows || []).map((row) => row.id).filter(Boolean);
  const rejectionCountMap = await loadRejectionCountMap(threadIds);

  return (rows || []).map((row) =>
    mapThreadForResponse(row, null, rejectionCountMap[row.id] || 0),
  );
}

function normalizeAdminThreadType(value) {
  const normalized = normalizeText(value, 24).toLowerCase();
  if (
    normalized === "notification" ||
    normalized === "ticket" ||
    normalized === "direct"
  ) {
    return normalized;
  }
  return "direct";
}

function defaultAdminThreadSubject(threadType) {
  if (threadType === "notification") return "Admin Notification";
  if (threadType === "ticket") return "Support Ticket Follow-up";
  return "Direct Admin Chat";
}

function defaultAdminThreadContext(threadType) {
  if (threadType === "notification") return "admin-notification";
  if (threadType === "ticket") return "admin-ticket";
  return "admin-direct";
}

router.use(verifySupabaseToken);
// Backward-compatible issue endpoint.
router.post("/issues", async (req, res) => {
  try {
    const authUid = req.authUid;
    if (!authUid) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const user = await resolveDbUser(authUid);
    if (!user) {
      return res.status(404).json({ message: "User profile not found" });
    }

    const { thread } = await createThreadWithInitialMessage({
      requesterUserId: user.id,
      subject: req.body?.subject,
      message: req.body?.message,
      context: req.body?.context,
    });

    return res.status(201).json({
      success: true,
      message: "Support issue submitted successfully",
      issueId: thread.id,
      threadId: thread.id,
    });
  } catch (err) {
    console.error("[support-issues] Error:", err);

    if (isMissingSupportChatTablesError(err)) {
      return missingMigrationResponse(res);
    }

    const statusCode = Number(err?.statusCode || 500);
    return res.status(statusCode).json({
      message: err?.message || "Failed to submit support issue",
      error: err?.message || "UNKNOWN_ERROR",
    });
  }
});

// Create a new support chat thread with initial message.
router.post("/threads", async (req, res) => {
  try {
    const authUid = req.authUid;
    if (!authUid) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const user = await resolveDbUser(authUid);
    if (!user) {
      return res.status(404).json({ message: "User profile not found" });
    }

    const { thread, insertedMessage } = await createThreadWithInitialMessage({
      requesterUserId: user.id,
      subject: req.body?.subject,
      message: req.body?.message,
      context: req.body?.context,
    });

    return res.status(201).json({
      success: true,
      thread: mapThreadForResponse(thread),
      message: insertedMessage,
    });
  } catch (err) {
    console.error("[support-threads-create] Error:", err);

    if (isMissingSupportChatTablesError(err)) {
      return missingMigrationResponse(res);
    }

    const statusCode = Number(err?.statusCode || 500);
    return res.status(statusCode).json({
      message: err?.message || "Failed to create support chat thread",
      error: err?.message || "UNKNOWN_ERROR",
    });
  }
});

// Admin creates and assigns a support thread directly to self for a selected user.
router.post("/admin/threads", adminOnly, async (req, res) => {
  try {
    await expireOverdueTickets();

    const adminUser = await resolveDbUser(req.authUid);
    if (!adminUser?.id) {
      return res.status(404).json({ message: "Admin profile not found" });
    }

    const targetUserId = normalizeText(
      req.body?.targetUserId || req.body?.requesterUserId,
      120,
    );
    if (!targetUserId) {
      return res.status(400).json({ message: "targetUserId is required" });
    }
    if (targetUserId === adminUser.id) {
      return res.status(400).json({
        message: "Cannot start an admin support thread with yourself",
      });
    }

    const normalizedMessage = normalizeText(req.body?.message, 4000);
    if (!normalizedMessage) {
      return res.status(400).json({ message: "Message is required" });
    }

    const threadType = normalizeAdminThreadType(req.body?.threadType);
    const normalizedSubject =
      normalizeText(req.body?.subject, 160) ||
      defaultAdminThreadSubject(threadType);
    const normalizedContext =
      normalizeText(req.body?.context, 120) ||
      defaultAdminThreadContext(threadType);
    const now = new Date();
    const nowIso = now.toISOString();
    const expiresAtIso = new Date(
      now.getTime() + TICKET_LIFETIME_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();

    const { data: targetUser, error: targetErr } = await supabaseAdmin
      .from("users")
      .select("id, email, display_name, avatar_url, is_active")
      .eq("id", targetUserId)
      .maybeSingle();
    if (targetErr) throw targetErr;
    if (!targetUser) {
      return res.status(404).json({ message: "Target user not found" });
    }
    if (targetUser.is_active === false) {
      return res.status(409).json({
        message: "Cannot start a chat with a suspended user",
      });
    }

    const { data: thread, error: threadErr } = await supabaseAdmin
      .from("support_chat_threads")
      .insert({
        requester_user_id: targetUser.id,
        subject: normalizedSubject,
        context: normalizedContext,
        status: "active",
        assigned_admin_user_id: adminUser.id,
        assigned_at: nowIso,
        expires_at: expiresAtIso,
        is_admin_unread: false,
        is_user_unread: true,
        last_message_preview: normalizedMessage.slice(0, 500),
        last_sender_role: "admin",
        last_message_at: nowIso,
        created_at: nowIso,
        updated_at: nowIso,
      })
      .select("*")
      .single();
    if (threadErr) throw threadErr;

    const { data: insertedMessage, error: msgErr } = await supabaseAdmin
      .from("support_chat_messages")
      .insert({
        thread_id: thread.id,
        sender_user_id: adminUser.id,
        sender_role: "admin",
        message: normalizedMessage,
        created_at: nowIso,
      })
      .select("*")
      .single();
    if (msgErr) throw msgErr;

    return res.status(201).json({
      success: true,
      threadType,
      thread: mapThreadForResponse(
        thread,
        withNormalizedAvatar(targetUser),
        0,
      ),
      message: insertedMessage,
    });
  } catch (err) {
    console.error("[support-admin-thread-create] Error:", err);

    if (isMissingSupportChatTablesError(err)) {
      return missingMigrationResponse(res);
    }

    return res.status(500).json({
      message: "Failed to create admin support thread",
      error: err?.message || "UNKNOWN_ERROR",
    });
  }
});

// Unified inbox payload for current member messenger + navbar unread indicators.
router.get("/inbox", async (req, res) => {
  try {
    const authUid = req.authUid;
    if (!authUid) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    await expireOverdueTickets();

    const user = await resolveDbUser(authUid);
    if (!user) {
      return res.status(404).json({ message: "User profile not found" });
    }

    const limit = parseLimit(req.query.limit, 100, 500);
    const threads = await loadMemberThreadsForUser(user.id, limit);
    const unreadThreads = threads.filter((thread) => Boolean(thread.is_user_unread));

    return res.json({
      threads,
      unreadThreads,
      unreadCount: unreadThreads.length,
      lastUpdatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error("[support-inbox] Error:", err);

    if (isMissingSupportChatTablesError(err)) {
      return missingMigrationResponse(res);
    }

    return res.status(500).json({
      message: "Failed to fetch support inbox",
      error: err?.message || "UNKNOWN_ERROR",
    });
  }
});

// List support threads for authenticated member.
router.get("/threads/my", async (req, res) => {
  try {
    const authUid = req.authUid;
    if (!authUid) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    await expireOverdueTickets();

    const user = await resolveDbUser(authUid);
    if (!user) {
      return res.status(404).json({ message: "User profile not found" });
    }

    const limit = parseLimit(req.query.limit, 100, 500);
    const threads = await loadMemberThreadsForUser(user.id, limit);

    return res.json(threads);
  } catch (err) {
    console.error("[support-threads-my] Error:", err);

    if (isMissingSupportChatTablesError(err)) {
      return missingMigrationResponse(res);
    }

    return res.status(500).json({
      message: "Failed to fetch support threads",
      error: err?.message || "UNKNOWN_ERROR",
    });
  }
});

// Fetch messages in a thread. Accessible by requester and assigned admin.
router.get("/threads/:threadId/messages", async (req, res) => {
  try {
    const authUid = req.authUid;
    const { threadId } = req.params;
    if (!authUid) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    await expireOverdueTickets();

    const user = await resolveDbUser(authUid);
    if (!user) {
      return res.status(404).json({ message: "User profile not found" });
    }

    const thread = await getThreadById(threadId);
    if (!thread) {
      return res.status(404).json({ message: "Thread not found" });
    }

    const admin = await isAdminUser(user);
    if (!canAccessThread(thread, user, admin)) {
      const message = admin
        ? "Access denied. Pick the ticket first or ask the assigned admin."
        : "Access denied";
      return res.status(403).json({ message });
    }

    const { data: messages, error: msgErr } = await supabaseAdmin
      .from("support_chat_messages")
      .select("*")
      .eq("thread_id", threadId)
      .order("created_at", { ascending: true })
      .limit(2000);

    if (msgErr) throw msgErr;

    return res.json({
      thread: mapThreadForResponse(thread),
      messages: messages || [],
      admin,
    });
  } catch (err) {
    console.error("[support-thread-messages] Error:", err);

    if (isMissingSupportChatTablesError(err)) {
      return missingMigrationResponse(res);
    }

    return res.status(500).json({
      message: "Failed to fetch support thread messages",
      error: err?.message || "UNKNOWN_ERROR",
    });
  }
});

// Send a new message in an existing thread.
router.post("/threads/:threadId/messages", async (req, res) => {
  try {
    const authUid = req.authUid;
    const { threadId } = req.params;
    if (!authUid) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    await expireOverdueTickets();

    const user = await resolveDbUser(authUid);
    if (!user) {
      return res.status(404).json({ message: "User profile not found" });
    }

    const thread = await getThreadById(threadId);
    if (!thread) {
      return res.status(404).json({ message: "Thread not found" });
    }

    const admin = await isAdminUser(user);
    if (!canAccessThread(thread, user, admin)) {
      const message = admin
        ? "Access denied. Pick the ticket first or ask the assigned admin."
        : "Access denied";
      return res.status(403).json({ message });
    }

    if (isClosedTicketStatus(thread.status)) {
      return res.status(409).json({
        message: "This ticket is closed. Start a new ticket to continue.",
      });
    }

    const normalizedMessage = normalizeText(req.body?.message, 4000);
    if (!normalizedMessage) {
      return res.status(400).json({ message: "Message is required" });
    }

    const senderRole = admin ? "admin" : "member";
    const now = new Date().toISOString();

    const { data: insertedMessage, error: msgErr } = await supabaseAdmin
      .from("support_chat_messages")
      .insert({
        thread_id: threadId,
        sender_user_id: user.id,
        sender_role: senderRole,
        message: normalizedMessage,
        created_at: now,
      })
      .select("*")
      .single();

    if (msgErr) throw msgErr;

    const nextStatus =
      senderRole === "admin"
        ? "active"
        : thread.assigned_admin_user_id
          ? "active"
          : "pending";

    const updatePayload = {
      status: nextStatus,
      last_message_preview: normalizedMessage.slice(0, 500),
      last_sender_role: senderRole,
      last_message_at: now,
      is_admin_unread: senderRole === "member",
      is_user_unread: senderRole === "admin",
      updated_at: now,
    };

    const { data: updatedThread, error: updateErr } = await supabaseAdmin
      .from("support_chat_threads")
      .update(updatePayload)
      .eq("id", threadId)
      .select("*")
      .single();

    if (updateErr) throw updateErr;

    return res.status(201).json({
      success: true,
      thread: mapThreadForResponse(updatedThread),
      message: insertedMessage,
      senderRole,
    });
  } catch (err) {
    console.error("[support-thread-send-message] Error:", err);

    if (isMissingSupportChatTablesError(err)) {
      return missingMigrationResponse(res);
    }

    return res.status(500).json({
      message: "Failed to send support chat message",
      error: err?.message || "UNKNOWN_ERROR",
    });
  }
});

// Mark a thread as read by current actor (member or assigned admin).
router.post("/threads/:threadId/read", async (req, res) => {
  try {
    const authUid = req.authUid;
    const { threadId } = req.params;
    if (!authUid) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    await expireOverdueTickets();

    const user = await resolveDbUser(authUid);
    if (!user) {
      return res.status(404).json({ message: "User profile not found" });
    }

    const thread = await getThreadById(threadId);
    if (!thread) {
      return res.status(404).json({ message: "Thread not found" });
    }

    const admin = await isAdminUser(user);
    if (!canAccessThread(thread, user, admin)) {
      const message = admin
        ? "Access denied. Pick the ticket first or ask the assigned admin."
        : "Access denied";
      return res.status(403).json({ message });
    }

    const updates = admin ? { is_admin_unread: false } : { is_user_unread: false };

    const { data: updatedThread, error: updateErr } = await supabaseAdmin
      .from("support_chat_threads")
      .update(updates)
      .eq("id", threadId)
      .select("*")
      .single();

    if (updateErr) throw updateErr;

    return res.json({
      success: true,
      thread: mapThreadForResponse(updatedThread),
      admin,
    });
  } catch (err) {
    console.error("[support-thread-mark-read] Error:", err);

    if (isMissingSupportChatTablesError(err)) {
      return missingMigrationResponse(res);
    }

    return res.status(500).json({
      message: "Failed to mark support thread as read",
      error: err?.message || "UNKNOWN_ERROR",
    });
  }
});
// Admin ticket queue: unassigned tickets available for pickup.
router.get("/admin/tickets", adminOnly, async (req, res) => {
  try {
    await expireOverdueTickets();

    const adminUser = await resolveDbUser(req.authUid);
    if (!adminUser?.id) {
      return res.status(404).json({ message: "Admin profile not found" });
    }

    const limit = parseLimit(req.query.limit, 200, 1000);

    const { data: rows, error } = await supabaseAdmin
      .from("support_chat_threads")
      .select("*")
      .eq("deleted_by_admin", false)
      .is("assigned_admin_user_id", null)
      .in("status", ["pending", "open"])
      .order("last_message_at", { ascending: false })
      .limit(limit);

    if (error) throw error;

    const threadIds = (rows || []).map((row) => row.id).filter(Boolean);

    let myRejectedIds = new Set();
    if (threadIds.length > 0) {
      const { data: myRejections, error: myRejectErr } = await supabaseAdmin
        .from("support_chat_rejections")
        .select("thread_id")
        .eq("admin_user_id", adminUser.id)
        .in("thread_id", threadIds);
      if (myRejectErr) throw myRejectErr;
      myRejectedIds = new Set((myRejections || []).map((row) => row.thread_id));
    }

    const visibleRows = (rows || []).filter((row) => !myRejectedIds.has(row.id));
    const visibleThreadIds = visibleRows.map((row) => row.id).filter(Boolean);
    const requesterMap = await loadRequesterMap(visibleRows);
    const rejectionCountMap = await loadRejectionCountMap(visibleThreadIds);

    return res.json(
      visibleRows.map((row) =>
        mapThreadForResponse(
          row,
          requesterMap[row.requester_user_id] || null,
          rejectionCountMap[row.id] || 0,
        ),
      ),
    );
  } catch (err) {
    console.error("[support-admin-ticket-queue] Error:", err);

    if (isMissingSupportChatTablesError(err)) {
      return missingMigrationResponse(res);
    }

    return res.status(500).json({
      message: "Failed to fetch support ticket queue",
      error: err?.message || "UNKNOWN_ERROR",
    });
  }
});

// Admin picks a ticket. Once picked, ticket is private to that admin.
router.post("/admin/tickets/:threadId/pick", adminOnly, async (req, res) => {
  try {
    await expireOverdueTickets();

    const { threadId } = req.params;
    const adminUser = await resolveDbUser(req.authUid);
    if (!adminUser?.id) {
      return res.status(404).json({ message: "Admin profile not found" });
    }

    const thread = await getThreadById(threadId);
    if (!thread) {
      return res.status(404).json({ message: "Ticket not found" });
    }

    if (thread.deleted_by_admin) {
      return res.status(409).json({ message: "Ticket is not available" });
    }

    if (isClosedTicketStatus(thread.status)) {
      return res.status(409).json({ message: "Ticket is closed and cannot be picked" });
    }

    if (thread.assigned_admin_user_id && thread.assigned_admin_user_id !== adminUser.id) {
      return res.status(409).json({ message: "Ticket already assigned to another admin" });
    }

    if (thread.assigned_admin_user_id === adminUser.id) {
      const requesterMap = await loadRequesterMap([thread]);
      const rejectionCountMap = await loadRejectionCountMap([thread.id]);
      return res.json({
        success: true,
        alreadyAssigned: true,
        thread: mapThreadForResponse(
          thread,
          requesterMap[thread.requester_user_id] || null,
          rejectionCountMap[thread.id] || 0,
        ),
      });
    }

    if (!isOpenTicketStatus(thread.status)) {
      return res.status(409).json({ message: "Ticket cannot be picked in its current state" });
    }

    // If the same admin previously rejected the ticket, remove that decision.
    await supabaseAdmin
      .from("support_chat_rejections")
      .delete()
      .eq("thread_id", threadId)
      .eq("admin_user_id", adminUser.id);

    const nowIso = new Date().toISOString();

    const { data: pickedThread, error: pickErr } = await supabaseAdmin
      .from("support_chat_threads")
      .update({
        assigned_admin_user_id: adminUser.id,
        assigned_at: nowIso,
        status: "active",
        updated_at: nowIso,
      })
      .eq("id", threadId)
      .eq("deleted_by_admin", false)
      .is("assigned_admin_user_id", null)
      .in("status", ["pending", "open", "active"])
      .select("*")
      .maybeSingle();

    if (pickErr) throw pickErr;

    if (!pickedThread) {
      const latest = await getThreadById(threadId);
      if (!latest) {
        return res.status(404).json({ message: "Ticket not found" });
      }

      const message = latest.assigned_admin_user_id
        ? "Ticket was picked by another admin"
        : "Ticket is no longer available";
      return res.status(409).json({ message, thread: mapThreadForResponse(latest) });
    }

    const requesterMap = await loadRequesterMap([pickedThread]);
    const rejectionCountMap = await loadRejectionCountMap([pickedThread.id]);

    return res.json({
      success: true,
      thread: mapThreadForResponse(
        pickedThread,
        requesterMap[pickedThread.requester_user_id] || null,
        rejectionCountMap[pickedThread.id] || 0,
      ),
    });
  } catch (err) {
    console.error("[support-admin-ticket-pick] Error:", err);

    if (isMissingSupportChatTablesError(err)) {
      return missingMigrationResponse(res);
    }

    return res.status(500).json({
      message: "Failed to pick support ticket",
      error: err?.message || "UNKNOWN_ERROR",
    });
  }
});

// Admin rejects a queue ticket.
// If all active admins reject the same ticket, user gets a rejection notification message.
router.post("/admin/tickets/:threadId/reject", adminOnly, async (req, res) => {
  try {
    await expireOverdueTickets();

    const { threadId } = req.params;
    const adminUser = await resolveDbUser(req.authUid);
    if (!adminUser?.id) {
      return res.status(404).json({ message: "Admin profile not found" });
    }

    const thread = await getThreadById(threadId);
    if (!thread) {
      return res.status(404).json({ message: "Ticket not found" });
    }

    if (thread.deleted_by_admin) {
      return res.status(409).json({ message: "Ticket is not available" });
    }

    if (isClosedTicketStatus(thread.status)) {
      return res.status(409).json({ message: "Ticket is already closed" });
    }

    if (thread.assigned_admin_user_id) {
      if (thread.assigned_admin_user_id === adminUser.id) {
        return res.status(409).json({
          message: "Ticket is already assigned to you. Use delete/resolve actions instead.",
        });
      }

      return res.status(409).json({ message: "Ticket is already assigned to another admin" });
    }

    if (!isOpenTicketStatus(thread.status)) {
      return res.status(409).json({ message: "Ticket cannot be rejected in its current state" });
    }

    const nowIso = new Date().toISOString();

    const { error: rejectErr } = await supabaseAdmin
      .from("support_chat_rejections")
      .upsert(
        {
          thread_id: threadId,
          admin_user_id: adminUser.id,
          created_at: nowIso,
        },
        {
          onConflict: "thread_id,admin_user_id",
          ignoreDuplicates: true,
        },
      );

    if (rejectErr) throw rejectErr;

    const [allAdminUserIds, rejectionRows] = await Promise.all([
      getActiveAdminUserIds(),
      supabaseAdmin
        .from("support_chat_rejections")
        .select("admin_user_id")
        .eq("thread_id", threadId),
    ]);

    if (rejectionRows.error) throw rejectionRows.error;

    const effectiveAdminIds = allAdminUserIds.length > 0 ? allAdminUserIds : [adminUser.id];
    const rejectedByIds = new Set(
      (rejectionRows.data || []).map((row) => row.admin_user_id).filter(Boolean),
    );
    const rejectedByAllAdmins = effectiveAdminIds.every((adminId) =>
      rejectedByIds.has(adminId),
    );

    let updatedThread = thread;
    let notifyUser = false;

    if (rejectedByAllAdmins) {
      const { data: rejectedThread, error: rejectedThreadErr } = await supabaseAdmin
        .from("support_chat_threads")
        .update({
          status: "rejected",
          is_admin_unread: false,
          is_user_unread: true,
          last_sender_role: "admin",
          last_message_preview: TICKET_REJECTED_MESSAGE,
          last_message_at: nowIso,
          updated_at: nowIso,
        })
        .eq("id", threadId)
        .eq("deleted_by_admin", false)
        .is("assigned_admin_user_id", null)
        .in("status", OPEN_TICKET_STATUSES)
        .select("*")
        .maybeSingle();

      if (rejectedThreadErr) throw rejectedThreadErr;

      if (rejectedThread) {
        updatedThread = rejectedThread;
        notifyUser = true;

        const { error: messageErr } = await supabaseAdmin
          .from("support_chat_messages")
          .insert({
            thread_id: threadId,
            sender_user_id: null,
            sender_role: "admin",
            message: TICKET_REJECTED_MESSAGE,
            created_at: nowIso,
          });

        if (messageErr) {
          console.warn(
            "[support-admin-ticket-reject] failed to insert rejection notice message:",
            messageErr,
          );
        }
      }
    }

    const requesterMap = await loadRequesterMap([updatedThread]);

    return res.json({
      success: true,
      rejectedByAllAdmins: notifyUser,
      notifyUser,
      thread: mapThreadForResponse(
        updatedThread,
        requesterMap[updatedThread.requester_user_id] || null,
        rejectedByIds.size,
      ),
      rejectionCount: rejectedByIds.size,
      requiredRejections: effectiveAdminIds.length,
    });
  } catch (err) {
    console.error("[support-admin-ticket-reject] Error:", err);

    if (isMissingSupportChatTablesError(err)) {
      return missingMigrationResponse(res);
    }

    return res.status(500).json({
      message: "Failed to reject support ticket",
      error: err?.message || "UNKNOWN_ERROR",
    });
  }
});

// Admin's private assigned threads.
router.get("/admin/threads", adminOnly, async (req, res) => {
  try {
    await expireOverdueTickets();

    const adminUser = await resolveDbUser(req.authUid);
    if (!adminUser?.id) {
      return res.status(404).json({ message: "Admin profile not found" });
    }

    const state = normalizeText(req.query.state, 20).toLowerCase() || "all";
    const limit = parseLimit(req.query.limit, 200, 1000);

    let query = supabaseAdmin
      .from("support_chat_threads")
      .select("*")
      .eq("deleted_by_admin", false)
      .eq("assigned_admin_user_id", adminUser.id)
      .order("assigned_at", { ascending: false, nullsFirst: false })
      .order("last_message_at", { ascending: false })
      .limit(limit);

    if (state === "unread") {
      query = query.eq("is_admin_unread", true);
    } else if (state === "read") {
      query = query.eq("is_admin_unread", false);
    }

    const { data: rows, error } = await query;
    if (error) throw error;

    const threadIds = (rows || []).map((row) => row.id).filter(Boolean);
    const requesterMap = await loadRequesterMap(rows || []);
    const rejectionCountMap = await loadRejectionCountMap(threadIds);

    return res.json(
      (rows || []).map((row) =>
        mapThreadForResponse(
          row,
          requesterMap[row.requester_user_id] || null,
          rejectionCountMap[row.id] || 0,
        ),
      ),
    );
  } catch (err) {
    console.error("[support-admin-threads] Error:", err);

    if (isMissingSupportChatTablesError(err)) {
      return missingMigrationResponse(res);
    }

    return res.status(500).json({
      message: "Failed to fetch admin support threads",
      error: err?.message || "UNKNOWN_ERROR",
    });
  }
});

// Assigned admin can soft-delete thread from own queue.
router.delete("/admin/threads/:threadId", adminOnly, async (req, res) => {
  try {
    const { threadId } = req.params;
    if (!threadId) {
      return res.status(400).json({ message: "threadId is required" });
    }

    const adminUser = await resolveDbUser(req.authUid);
    if (!adminUser?.id) {
      return res.status(404).json({ message: "Admin profile not found" });
    }

    const thread = await getThreadById(threadId);
    if (!thread) {
      return res.status(404).json({ message: "Thread not found" });
    }

    if (thread.assigned_admin_user_id !== adminUser.id) {
      return res.status(403).json({
        message: "Only the assigned admin can delete this ticket",
      });
    }

    const { data: updatedThread, error } = await supabaseAdmin
      .from("support_chat_threads")
      .update({
        deleted_by_admin: true,
        status: "deleted",
        is_admin_unread: false,
        is_user_unread: false,
      })
      .eq("id", threadId)
      .eq("assigned_admin_user_id", adminUser.id)
      .select("*")
      .maybeSingle();

    if (error) throw error;
    if (!updatedThread) {
      return res.status(404).json({ message: "Thread not found" });
    }

    return res.json({
      success: true,
      message: "Support chat deleted",
      thread: mapThreadForResponse(updatedThread),
    });
  } catch (err) {
    console.error("[support-admin-delete-thread] Error:", err);

    if (isMissingSupportChatTablesError(err)) {
      return missingMigrationResponse(res);
    }

    return res.status(500).json({
      message: "Failed to delete support thread",
      error: err?.message || "UNKNOWN_ERROR",
    });
  }
});

export default router;

