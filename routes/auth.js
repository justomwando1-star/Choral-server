import express from "express";
import { supabase } from "../lib/supabaseClient.js";
import { verifySupabaseToken } from "../middleware/supabaseAuth.js";
import { isValidAvatarUrl, normalizeAvatarUrl } from "../utils/avatarUrl.js";

const router = express.Router();

// POST /api/auth/register
// Create a new Supabase auth user and sync to users table
router.post("/register", async (req, res) => {
  try {
    const { email, password, displayName, phone, avatarUrl } = req.body;
    const normalizedAvatarUrl = normalizeAvatarUrl(avatarUrl);

    if (!email)
      return res
        .status(400)
        .json({ message: "email is required", error: "MISSING_EMAIL" });
    if (!password)
      return res
        .status(400)
        .json({ message: "password is required", error: "MISSING_PASSWORD" });

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email))
      return res
        .status(400)
        .json({ message: "email is not valid", error: "INVALID_EMAIL" });

    // Validate avatar URL
    if (avatarUrl !== undefined) {
      if (!isValidAvatarUrl(avatarUrl)) {
        console.warn("[register] Invalid avatar URL rejected:", avatarUrl);
        return res.status(400).json({
          message:
            "Invalid avatar URL. Only Supabase storage URLs are accepted.",
          error: "INVALID_AVATAR_URL",
        });
      }
    }

    // Check if user already exists
    const { data: existingUser } = await supabase
      .from("users")
      .select("id")
      .eq("email", email)
      .maybeSingle();

    if (existingUser)
      return res.status(409).json({
        message: "User with this email already exists",
        error: "USER_EXISTS",
        id: existingUser.id,
      });

    // Create Supabase auth user
    const { data: authData, error: authError } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: {
          display_name: displayName || null,
        },
      },
    });

    if (authError || !authData.user) {
      console.error("[register] Supabase auth error:", authError);
      return res.status(400).json({
        message: "Failed to create auth user",
        error: authError?.message || "SIGNUP_FAILED",
      });
    }

    const authUid = authData.user.id;

    // Create user profile in users table
    const { data: newUser, error: dbError } = await supabase
      .from("users")
      .insert({
        auth_uid: authUid,
        email,
        display_name: displayName || null,
        phone: phone || null,
        avatar_url: normalizedAvatarUrl || null,
        is_active: true,
        created_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (dbError) {
      console.error("[register] DB error:", dbError);
      throw dbError;
    }

    // Check if email is in admin_emails table and auto-assign admin role
    let roles = ["user"];
    try {
      const { data: adminEmail } = await supabase
        .from("admin_emails")
        .select("id")
        .eq("email", email)
        .eq("is_active", true)
        .maybeSingle();

      if (adminEmail) {
        console.log(
          "[register] Email found in admin_emails, assigning admin role:",
          email,
        );
        const { data: adminRole } = await supabase
          .from("roles")
          .select("id")
          .eq("name", "admin")
          .maybeSingle();

        if (adminRole?.id) {
          await supabase
            .from("user_roles")
            .insert({ user_id: newUser.id, role_id: adminRole.id });
          roles.push("admin");
        }
      }
    } catch (e) {
      console.warn("[register] admin email check failed:", e?.message || e);
    }

    return res.status(201).json({
      ...newUser,
      roles,
      message:
        "User registered successfully. Please check your email to confirm.",
    });
  } catch (error) {
    console.error("[register] Error:", error);
    return res.status(500).json({
      message: "Failed to register user",
      error: error?.message || "Internal server error",
    });
  }
});

// POST /api/auth/login - Already handled by Supabase client SDK on frontend
// This endpoint is here for reference if backend needs to issue tokens
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res
        .status(400)
        .json({ message: "email and password are required" });
    }

    // Authenticate with Supabase
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error || !data.session) {
      return res.status(401).json({
        message: "Invalid email or password",
        error: error?.message || "LOGIN_FAILED",
      });
    }

    // Get user profile
    const { data: userProfile } = await supabase
      .from("users")
      .select("*")
      .eq("auth_uid", data.user.id)
      .maybeSingle();

    // Fetch roles
    const roles = await fetchUserRoles(data.user.id);

    return res.status(200).json({
      user: userProfile || {
        auth_uid: data.user.id,
        email: data.user.email,
      },
      roles,
      session: data.session,
      message: "Login successful",
    });
  } catch (error) {
    console.error("[login] Error:", error);
    return res.status(500).json({
      message: "Failed to login",
      error: error?.message || "Internal server error",
    });
  }
});

// POST /api/auth/logout - Handled by frontend, this is optional
router.post("/logout", verifySupabaseToken, async (req, res) => {
  try {
    // Supabase handles logout on frontend via signOut()
    // Backend just needs to acknowledge
    return res.status(200).json({ message: "Logout successful" });
  } catch (error) {
    console.error("[logout] Error:", error);
    return res.status(500).json({
      message: "Failed to logout",
      error: error?.message || "Internal server error",
    });
  }
});

// POST /api/auth/sync-user - Sync authenticated user to users table
router.post("/sync-user", verifySupabaseToken, async (req, res) => {
  try {
    const authUid = req.supabaseUser.id;
    const email = req.supabaseUser.email;
    const { displayName, phone, avatarUrl } = req.body;
    const normalizedAvatarUrl = normalizeAvatarUrl(avatarUrl);

    if (!authUid || !email) {
      return res.status(400).json({
        message: "User info missing from auth token",
        error: "INVALID_TOKEN",
      });
    }

    // Check if user already exists in users table
    const { data: existingUser, error: findError } = await supabase
      .from("users")
      .select("id")
      .eq("auth_uid", authUid)
      .maybeSingle();

    if (findError && findError.code !== "PGRST116") throw findError;

    let userId;
    let isNewUser = false;

    if (existingUser) {
      // Update existing user
      const { data: updatedUser, error: updateError } = await supabase
        .from("users")
        .update({
          email,
          display_name: displayName || null,
          avatar_url: normalizedAvatarUrl || null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", existingUser.id)
        .select()
        .single();

      if (updateError) throw updateError;
      userId = existingUser.id;
    } else {
      // Create new user profile
      const { data: newUser, error: createError } = await supabase
        .from("users")
        .insert({
          auth_uid: authUid,
          email,
          display_name: displayName || null,
          phone: phone || null,
          avatar_url: normalizedAvatarUrl || null,
          is_active: true,
          created_at: new Date().toISOString(),
        })
        .select()
        .single();

      if (createError) throw createError;
      userId = newUser.id;
      isNewUser = true;

      // Check if email is in admin_emails table and auto-assign admin role
      try {
        const { data: adminEmail } = await supabase
          .from("admin_emails")
          .select("id")
          .eq("email", email)
          .eq("is_active", true)
          .maybeSingle();

        if (adminEmail) {
          console.log(
            "[sync-user] Email found in admin_emails, assigning admin role:",
            email,
          );
          const { data: adminRole } = await supabase
            .from("roles")
            .select("id")
            .eq("name", "admin")
            .maybeSingle();

          if (adminRole?.id) {
            await supabase
              .from("user_roles")
              .insert({ user_id: userId, role_id: adminRole.id });
          }
        }
      } catch (e) {
        console.warn("[sync-user] admin email check failed:", e?.message || e);
      }
    }

    // Fetch user data and roles
    const { data: userData } = await supabase
      .from("users")
      .select("id, auth_uid, email, display_name, avatar_url, created_at")
      .eq("id", userId)
      .maybeSingle();

    const roles = await fetchUserRoles(authUid);

    return res.status(isNewUser ? 201 : 200).json({
      ...userData,
      roles,
      message: isNewUser
        ? "User created and synced successfully"
        : "User synced successfully",
    });
  } catch (error) {
    console.error("[sync-user] Error:", error);
    return res.status(500).json({
      message: "Failed to sync user",
      error: error?.message || "Internal server error",
    });
  }
});

// Helper: Fetch user roles by auth_uid
async function fetchUserRoles(authUid) {
  try {
    // Get user ID from auth_uid
    const { data: user } = await supabase
      .from("users")
      .select("id, email")
      .eq("auth_uid", authUid)
      .maybeSingle();

    if (!user) return ["user"];

    const roles = ["user"];

    // Check if user is admin via admin_emails table
    const { data: adminEmail } = await supabase
      .from("admin_emails")
      .select("id")
      .eq("email", user.email)
      .eq("is_active", true)
      .maybeSingle();

    if (adminEmail) {
      roles.push("admin");
    } else {
      // Check if user has composer record
      const { data: composer } = await supabase
        .from("composers")
        .select("id")
        .eq("user_id", user.id)
        .maybeSingle();

      if (composer) {
        roles.push("composer");
      }
    }

    return roles;
  } catch (err) {
    console.warn("[fetchUserRoles] error:", err?.message || err);
    return ["user"];
  }
}

// GET /api/auth/me - Get current authenticated user
router.get("/me", verifySupabaseToken, async (req, res) => {
  try {
    const authUid = req.supabaseUser.id;

    const { data: user } = await supabase
      .from("users")
      .select("*")
      .eq("auth_uid", authUid)
      .maybeSingle();

    if (!user) {
      return res.status(404).json({ message: "User profile not found" });
    }

    const roles = await fetchUserRoles(authUid);

    return res.status(200).json({
      ...user,
      roles,
    });
  } catch (error) {
    console.error("[me] Error:", error);
    return res.status(500).json({
      message: "Failed to fetch user",
      error: error?.message || "Internal server error",
    });
  }
});

// POST /api/auth/request-role
router.post("/request-role", verifySupabaseToken, async (req, res) => {
  try {
    const { requestedRole } = req.body;
    const authUid = req.supabaseUser.id;

    if (!["composer", "admin"].includes(requestedRole)) {
      return res
        .status(400)
        .json({ message: 'requestedRole must be "composer" or "admin"' });
    }

    // Get user ID from auth_uid
    const { data: user } = await supabase
      .from("users")
      .select("id")
      .eq("auth_uid", authUid)
      .maybeSingle();

    if (!user) {
      return res
        .status(404)
        .json({ message: "User profile not found. Please sync first." });
    }

    // Check for existing request
    const { data: existing } = await supabase
      .from("role_requests")
      .select("id, status")
      .eq("user_id", user.id)
      .eq("requested_role", requestedRole)
      .in("status", ["pending", "approved"])
      .maybeSingle();

    if (existing) {
      return res.status(409).json({
        message: `You already have a ${existing.status} ${requestedRole} request.`,
        requestId: existing.id,
        status: existing.status,
      });
    }

    // Create role request
    const { data: newRequest, error: createErr } = await supabase
      .from("role_requests")
      .insert({
        user_id: user.id,
        requested_role: requestedRole,
        status: "pending",
        requested_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (createErr) throw createErr;

    // Note: composer_request flag no longer used; rely on role_requests table instead

    return res.status(201).json({
      message: `${requestedRole} request submitted successfully. Awaiting admin approval.`,
      requestId: newRequest.id,
      status: newRequest.status,
    });
  } catch (error) {
    console.error("[request-role] Error:", error);
    return res.status(500).json({
      message: "Failed to submit request",
      error: error?.message || "Internal server error",
    });
  }
});

export default router;
