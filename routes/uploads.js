// routes/upload.js
import express from "express";
import multer from "multer";
import { supabaseAdmin } from "../lib/supabaseServer.js";
import { verifySupabaseToken } from "../middleware/verifySupabaseToken.js";
import { serverError } from "../utils/errors.js";
import path from "path";
import crypto from "crypto";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 30 * 1024 * 1024, // hard cap across all buckets
  },
});
const router = express.Router();

const BUCKET_MAX_SIZE_BYTES = {
  avatars: 8 * 1024 * 1024,
  thumbnails: 10 * 1024 * 1024,
  compositions: 30 * 1024 * 1024,
  community: 30 * 1024 * 1024,
};

const COMMUNITY_DOCUMENT_MIME_TYPES = new Set([
  "application/pdf",
  "text/plain",
  "text/csv",
  "application/rtf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
]);

const COMMUNITY_DOCUMENT_EXTENSIONS = new Set([
  ".pdf",
  ".doc",
  ".docx",
  ".txt",
  ".rtf",
  ".csv",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
]);

async function ensureBucketExists(bucket) {
  if (bucket !== "community") return;

  const { data: existingBucket, error: lookupErr } = await supabaseAdmin.storage.getBucket(
    bucket,
  );

  if (!lookupErr && existingBucket?.id) {
    return;
  }

  const lookupMessage = String(lookupErr?.message || "").toLowerCase();
  if (
    lookupErr &&
    !lookupMessage.includes("not found") &&
    !lookupMessage.includes("does not exist")
  ) {
    throw lookupErr;
  }

  const { error: createErr } = await supabaseAdmin.storage.createBucket(bucket, {
    public: true,
    fileSizeLimit: `${Math.floor((BUCKET_MAX_SIZE_BYTES[bucket] || 30 * 1024 * 1024) / (1024 * 1024))}MB`,
  });

  if (createErr) {
    const createMessage = String(createErr?.message || "").toLowerCase();
    if (!createMessage.includes("already exists")) {
      throw createErr;
    }
  }
}

function runSingleUpload(req, res, next) {
  upload.single("file")(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      if (err.code === "LIMIT_FILE_SIZE") {
        return res
          .status(413)
          .json({ message: "File is too large for upload limits." });
      }
      return res.status(400).json({ message: err.message || "Upload failed." });
    }
    return next(err);
  });
}

// POST /api/upload/:bucket
// Protected: we expect caller to be authenticated (so we can name files under user id)
router.post(
  "/:bucket",
  verifySupabaseToken,
  runSingleUpload,
  async (req, res) => {
    try {
      const { bucket } = req.params;
      const authUid = req.authUid;
      console.log("[upload] incoming request", {
        bucket,
        authUid: authUid || null,
        hasFile: Boolean(req.file),
        filename: req.file?.originalname || null,
        mimetype: req.file?.mimetype || null,
        size: req.file?.size || 0,
      });

      if (!["avatars", "compositions", "thumbnails", "community"].includes(bucket)) {
        return res.status(400).json({ message: "Invalid bucket" });
      }
      if (!req.file) return res.status(400).json({ message: "File required" });

      const maxBytes = BUCKET_MAX_SIZE_BYTES[bucket] || 30 * 1024 * 1024;
      if (req.file.size > maxBytes) {
        return res.status(413).json({
          message: `File too large for ${bucket}. Max size is ${Math.floor(maxBytes / (1024 * 1024))}MB.`,
        });
      }

      const mimeType = String(req.file.mimetype || "").toLowerCase();
      if (
        (bucket === "avatars" || bucket === "thumbnails") &&
        !mimeType.startsWith("image/")
      ) {
        return res
          .status(400)
          .json({ message: "Only image files are allowed for this bucket." });
      }

      if (bucket === "compositions") {
        const allowedCompositionTypes = new Set([
          "application/pdf",
          "application/octet-stream",
          "audio/midi",
          "audio/x-midi",
          "audio/mid",
          "application/x-midi",
        ]);
        if (!allowedCompositionTypes.has(mimeType)) {
          return res.status(400).json({
            message: "Only PDF or MIDI files are allowed for compositions.",
          });
        }
      }

      if (bucket === "community") {
        const extension = String(path.extname(req.file.originalname) || "").toLowerCase();
        const isSupportedCommunityAttachment =
          mimeType.startsWith("image/") ||
          mimeType.startsWith("video/") ||
          mimeType.startsWith("audio/") ||
          COMMUNITY_DOCUMENT_MIME_TYPES.has(mimeType) ||
          COMMUNITY_DOCUMENT_EXTENSIONS.has(extension);

        if (!isSupportedCommunityAttachment) {
          return res.status(400).json({
            message:
              "Community attachments must be an image, video, audio file, or supported document.",
          });
        }
      }

      const ext = path.extname(req.file.originalname) || "";
      const filename = `${authUid}/${Date.now()}-${crypto.randomBytes(6).toString("hex")}${ext}`;

      await ensureBucketExists(bucket);

      // upload using admin client (service role)
      const { error } = await supabaseAdmin.storage
        .from(bucket)
        .upload(filename, req.file.buffer, { upsert: false });

      if (error) throw error;

      if (bucket === "avatars" || bucket === "community") {
        const { data: publicData } = supabaseAdmin.storage
          .from(bucket)
          .getPublicUrl(filename);

        if (publicData?.publicUrl) {
          console.log("[upload] success with public avatar URL", {
            bucket,
            filename,
          });
          return res.json({
            success: true,
            url: publicData.publicUrl,
            path: filename,
            bucket,
            mimeType,
          });
        }

        console.warn("[upload] public URL missing, falling back to signed URL", {
          bucket,
          filename,
        });
      }

      // Private assets still use signed URLs.
      const { data: signedData, error: signedErr } = await supabaseAdmin.storage
        .from(bucket)
        .createSignedUrl(filename, 3600);

      if (signedErr) {
        console.warn("[upload] createSignedUrl failed, falling back to public URL", {
          bucket,
          filename,
          error: signedErr?.message || signedErr,
        });
        const { data: pub } = supabaseAdmin.storage
          .from(bucket)
          .getPublicUrl(filename);
        return res.json({
          success: true,
          url: pub.publicUrl,
          path: filename,
          bucket,
          mimeType,
        });
      }

      return res.json({
        success: true,
        url: signedData?.signedUrl || null,
        path: filename,
        bucket,
        mimeType,
      });
    } catch (err) {
      console.error("[upload] failed", err);
      return serverError(res, err);
    }
  },
);

export default router;
