import express from "express";
import { supabaseAdmin } from "../lib/supabaseServer.js";
import {
  verifySupabaseToken,
  adminOnly,
} from "../middleware/verifySupabaseToken.js";

const router = express.Router();
const ALLOWED_CATEGORY_NAMES = ["arrangements", "compositions"];

function normalizeCategoryName(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return "";
  if (normalized === "arrangements") return "Arrangements";
  if (normalized === "compositions") return "Compositions";
  return "";
}

function isAllowedCategoryName(value) {
  return ALLOWED_CATEGORY_NAMES.includes(String(value || "").trim().toLowerCase());
}

// GET /api/categories - get all categories
router.get("/", async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from("categories")
      .select("*")
      .order("name");

    if (error) throw error;

    const filtered = (data || []).filter((category) =>
      isAllowedCategoryName(category?.name),
    );

    return res.json(filtered);
  } catch (err) {
    console.error("[get-categories] Error:", err);
    return res
      .status(500)
      .json({ message: "Failed to fetch categories", error: err.message });
  }
});

// POST /api/categories - create a category (admin only)
router.post("/", verifySupabaseToken, adminOnly, async (req, res) => {
  try {
    const { name, description } = req.body;
    const normalizedName = normalizeCategoryName(name);

    if (!normalizedName) {
      return res.status(400).json({
        message: "Category name must be either Arrangements or Compositions",
      });
    }

    const { data, error } = await supabaseAdmin
      .from("categories")
      .upsert(
        { name: normalizedName, description },
        { onConflict: "name" },
      )
      .select()
      .maybeSingle();

    if (error) throw error;

    return res.status(201).json({
      message: "Category created",
      category: data,
    });
  } catch (err) {
    console.error("[create-category] Error:", err);
    return res
      .status(500)
      .json({ message: "Failed to create category", error: err.message });
  }
});

export default router;
