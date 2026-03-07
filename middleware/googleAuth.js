// server/middleware/googleAuth.js
// Middleware for verifying Google ID tokens

import {
  verifyGoogleToken,
  extractUserInfo,
} from "../lib/googleTokenVerifier.js";
import { supabase } from "../lib/supabaseClient.js";

export async function verifyGoogleToken_Middleware(req, res, next) {
  const authHeader = req.get("Authorization") || req.get("authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res
      .status(401)
      .json({ message: "Missing or invalid Authorization header" });
  }

  const idToken = authHeader.split(" ")[1];

  try {
    const payload = await verifyGoogleToken(idToken);
    req.googleDecoded = payload;
    req.googleUser = extractUserInfo(payload);
    return next();
  } catch (err) {
    console.error(
      "[verifyGoogleToken_Middleware] token verify error:",
      err?.message || err,
    );
    return res.status(401).json({ message: "Invalid or expired token" });
  }
}

export async function adminOnly(req, res, next) {
  try {
    const googleSub = req.googleUser?.googleSub;
    if (!googleSub) return res.status(401).json({ message: "Unauthorized" });

    // Check if user is an admin by looking up their email or google_sub in admin_emails table
    const email = req.googleUser?.email;

    if (email) {
      const { data: adminEmail, error } = await supabase
        .from("admin_emails")
        .select("id")
        .eq("email", email)
        .eq("is_active", true)
        .maybeSingle();

      if (error) {
        console.warn("[adminOnly] admin_emails lookup error:", error);
      }

      if (adminEmail) {
        console.log("[adminOnly] Admin access granted for:", email);
        return next();
      }
    }

    return res.status(403).json({ message: "Admin access required" });
  } catch (err) {
    console.error("[adminOnly] Error:", err);
    return res.status(500).json({ message: "Failed to verify admin role" });
  }
}

export default { verifyGoogleToken_Middleware, adminOnly };
