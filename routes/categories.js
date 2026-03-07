import express from "express";
import { supabaseAdmin } from "../lib/supabaseServer.js";
import {
  verifySupabaseToken,
  adminOnly,
} from "../middleware/verifySupabaseToken.js";

const router = express.Router();

// GET /api/categories - get all categories
router.get("/", async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from("categories")
      .select("*")
      .order("name");

    if (error) throw error;

    return res.json(data || []);
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

    if (!name) {
      return res.status(400).json({ message: "name is required" });
    }

    const { data, error } = await supabaseAdmin
      .from("categories")
      .insert({ name, description })
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
