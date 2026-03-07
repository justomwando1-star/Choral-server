// server/middleware/supabaseAuth.js
// Middleware for verifying Supabase auth tokens

import { supabase } from "../lib/supabaseClient.js";

/**
 * Verify Supabase session from Authorization header
 * Expects: Bearer <access_token>
 */
export async function verifySupabaseToken(req, res, next) {
  const authHeader = req.get("Authorization") || req.get("authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res
      .status(401)
      .json({ message: "Missing or invalid Authorization header" });
  }

  const accessToken = authHeader.split(" ")[1];

  try {
    // Verify the token with Supabase
    const { data, error } = await supabase.auth.getUser(accessToken);

    if (error || !data.user) {
      console.error(
        "[verifySupabaseToken] auth error:",
        error?.message || "no user",
      );
      return res.status(401).json({ message: "Invalid or expired token" });
    }

    // Attach user info to request
    req.supabaseUser = {
      id: data.user.id,
      email: data.user.email,
      user_metadata: data.user.user_metadata || {},
      app_metadata: data.user.app_metadata || {},
    };

    return next();
  } catch (err) {
    console.error("[verifySupabaseToken] error:", err?.message || err);
    return res.status(401).json({ message: "Token verification failed" });
  }
}

/**
 * Verify admin role by checking admin_emails table
 */
export async function adminOnly(req, res, next) {
  try {
    const userId = req.supabaseUser?.id;
    const email = req.supabaseUser?.email;

    if (!userId || !email) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    // Check if email is in admin_emails table
    const { data: adminEmail, error } = await supabase
      .from("admin_emails")
      .select("id")
      .eq("email", email)
      .eq("is_active", true)
      .maybeSingle();

    if (error) {
      console.warn("[adminOnly] lookup error:", error);
    }

    if (adminEmail) {
      console.log("[adminOnly] Admin access granted for:", email);
      return next();
    }

    return res.status(403).json({ message: "Admin access required" });
  } catch (err) {
    console.error("[adminOnly] Error:", err);
    return res.status(500).json({ message: "Failed to verify admin role" });
  }
}

export default { verifySupabaseToken, adminOnly };
