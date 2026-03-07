// server/lib/googleTokenVerifier.js
// Verifies Google Identity Services ID tokens using the OAuth2 library

import { OAuth2Client } from "google-auth-library";
import dotenv from "dotenv";

dotenv.config();

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.warn(
    "[googleTokenVerifier] GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET not set; token verification disabled",
  );
}

const client = new OAuth2Client(CLIENT_ID, CLIENT_SECRET);

/**
 * Verify a Google ID token and return the decoded payload
 * @param {string} idToken - The JWT ID token from the frontend
 * @returns {Promise<object>} The decoded token payload including sub, email, name, picture
 */
export async function verifyGoogleToken(idToken) {
  try {
    if (!CLIENT_ID) {
      throw new Error("GOOGLE_CLIENT_ID not configured; cannot verify tokens");
    }

    const ticket = await client.verifyIdToken({
      idToken,
      audience: CLIENT_ID,
    });

    return ticket.getPayload();
  } catch (err) {
    console.error(
      "[googleTokenVerifier] verification error:",
      err?.message || err,
    );
    throw new Error("Invalid or expired Google ID token");
  }
}

/**
 * Extract the Google user ID (sub claim)
 */
export function getGoogleUserId(payload) {
  return payload.sub;
}

/**
 * Extract user info from the verified token payload
 */
export function extractUserInfo(payload) {
  return {
    googleSub: payload.sub,
    email: payload.email,
    name: payload.name,
    picture: payload.picture,
  };
}
