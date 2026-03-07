import jwt from "jsonwebtoken";
import dotenv from "dotenv";
import { supabaseAdmin } from "../lib/supabaseServer.js";

dotenv.config();

const JWT_SECRET = process.env.SUPABASE_JWT_SECRET?.trim();
let missingSecretLogged = false;
const ADMIN_IDENTIFIERS = new Set(
  String(process.env.ADMIN_IDENTIFIERS || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean),
);

function getJwtAlg(token) {
  try {
    const decoded = jwt.decode(token, { complete: true });
    return decoded?.header?.alg || null;
  } catch {
    return null;
  }
}

function decodeJwtPayload(token) {
  try {
    const [, payload] = token.split(".");
    if (!payload) return null;
    const b64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
    return JSON.parse(Buffer.from(`${b64}${pad}`, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

function getTokenMeta(token) {
  const payload = decodeJwtPayload(token) || {};
  return {
    alg: getJwtAlg(token),
    iss: payload.iss || null,
    aud: payload.aud || null,
    sub: payload.sub || null,
    exp: payload.exp || null,
  };
}

export async function verifySupabaseToken(req, res, next) {
  try {
    const header = req.get("Authorization") || req.get("authorization");
    if (!header || !header.startsWith("Bearer ")) {
      return res.status(401).json({ message: "No bearer token provided" });
    }

    const token = header.slice("Bearer ".length);
    const tokenAlg = getJwtAlg(token);
    const tokenMeta = getTokenMeta(token);
    const isHsToken = typeof tokenAlg === "string" && tokenAlg.startsWith("HS");

    // Prefer local verification for HS* tokens when JWT secret exists.
    // For non-HS tokens (e.g. RS*/ES*), fall back to Supabase Auth introspection.
    if (isHsToken) {
      if (!JWT_SECRET) {
        if (!missingSecretLogged) {
          console.error(
            "[verifySupabaseToken] SUPABASE_JWT_SECRET is missing for HS token verification.",
          );
          missingSecretLogged = true;
        }
        return res.status(500).json({
          message:
            "Server JWT secret is not configured. Set SUPABASE_JWT_SECRET in server/.env and restart the API.",
        });
      }

      try {
        const decoded = jwt.verify(token, JWT_SECRET, { algorithms: ["HS256"] });
        req.auth = decoded;
        req.authUid = decoded?.sub || null;
        if (!req.authUid) {
          return res.status(401).json({ message: "Invalid token payload" });
        }
        return next();
      } catch (verifyErr) {
        console.warn(
          "[verifySupabaseToken] HS JWT verification failed, falling back to Supabase auth:",
          verifyErr?.message || verifyErr,
        );
      }
    } else {
      console.log(
        "[verifySupabaseToken] non-HS token algorithm detected, using Supabase auth fallback:",
        tokenAlg || "unknown",
      );
    }

    try {
      const { data, error } = await supabaseAdmin.auth.getUser(token);
      if (error || !data?.user?.id) {
        console.warn("[verifySupabaseToken] getUser rejected token", {
          message: error?.message || "No user returned",
          status: error?.status || null,
          code: error?.code || null,
          token: tokenMeta,
        });
        return res.status(401).json({ message: "Invalid or expired token" });
      }

      req.authUid = data.user.id;
      req.auth = {
        sub: data.user.id,
        email: data.user.email || null,
        user_metadata: data.user.user_metadata || {},
        app_metadata: data.user.app_metadata || {},
      };

      return next();
    } catch (networkErr) {
      console.error(
        "[verifySupabaseToken] auth fallback network error:",
        networkErr?.message || networkErr,
      );
      return res.status(503).json({
        message:
          "Token verification fallback is unavailable. Check network/DNS to Supabase or disable fallback.",
      });
    }
  } catch (err) {
    console.error("[verifySupabaseToken] error:", err?.message || err);
    return res.status(401).json({ message: "Invalid or expired token" });
  }
}

export async function adminOnly(req, res, next) {
  try {
    const authUid = req.authUid;
    if (!authUid) return res.status(401).json({ message: "Unauthorized" });

    const { data: user, error: userErr } = await supabaseAdmin
      .from("users")
      .select("id, email")
      .eq("auth_uid", authUid)
      .maybeSingle();

    if (userErr) throw userErr;
    const normalizedEmail = String(user?.email || req.auth?.email || "")
      .trim()
      .toLowerCase();
    if (!normalizedEmail) {
      return res.status(403).json({ message: "Admin access required" });
    }

    if (ADMIN_IDENTIFIERS.has(normalizedEmail)) {
      return next();
    }

    if (user?.id) {
      const { data: roleRows, error: roleErr } = await supabaseAdmin
        .from("user_roles")
        .select("roles(name)")
        .eq("user_id", user.id);
      if (roleErr) throw roleErr;

      const hasAdminRole = (roleRows || []).some(
        (row) => String(row?.roles?.name || "").toLowerCase() === "admin",
      );
      if (hasAdminRole) return next();
    }

    const { data: adminEmail, error: adminErr } = await supabaseAdmin
      .from("admin_emails")
      .select("id")
      .ilike("email", normalizedEmail)
      .eq("is_active", true)
      .maybeSingle();

    if (adminErr) throw adminErr;
    if (!adminEmail) return res.status(403).json({ message: "Admin access required" });

    return next();
  } catch (err) {
    console.error("[adminOnly] Error:", err?.message || err);
    return res.status(500).json({ message: "Failed to verify admin role" });
  }
}

export default { verifySupabaseToken, adminOnly };
