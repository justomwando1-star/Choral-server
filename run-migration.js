#!/usr/bin/env node
/**
 * Database setup checker for Supabase
 * Verifies required tables exist and provides setup instructions if needed
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

// Load environment variables
dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SUPABASE_URL = process.env.murekefu_music_hub_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY =
  process.env.murekefu_music_hub_SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error(
    "❌ Error: Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env",
  );
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function checkDatabase() {
  try {
    console.log("🔍 Checking database tables...\n");

    // Check if invites table exists
    const { data: invitesTable, error: invitesError } = await supabase
      .from("information_schema.tables")
      .select("table_name")
      .eq("table_schema", "public")
      .eq("table_name", "invites");

    if (invitesError && invitesError.code === "PGRST205") {
      console.log("⚠️  The 'invites' table does not exist in Supabase.\n");
      console.log("📋 To set up the table, follow these steps:\n");
      console.log("1. Go to your Supabase Dashboard: https://app.supabase.com");
      console.log('2. Select your project: "prime-media-7216b"');
      console.log('3. Navigate to "SQL Editor" in the left sidebar');
      console.log('4. Click "New Query"');
      console.log("5. Copy and paste the following SQL:\n");
      console.log("---BEGIN SQL---");

      // Read and display the migration SQL
      const migrationPath = path.join(
        __dirname,
        "../migrations/001_create_invites_table.sql",
      );
      const migrationSQL = fs.readFileSync(migrationPath, "utf-8");
      console.log(migrationSQL);

      console.log("---END SQL---\n");
      console.log('6. Click the "Run" button');
      console.log("7. Once complete, restart the backend server\n");
      console.log(
        "✨ That\'s it! The invites table will be created and ready to use.\n",
      );
      process.exit(0);
    } else if (!invitesTable || invitesTable.length === 0) {
      console.log("⚠️  The 'invites' table does not exist yet.");
      console.log("Please run the setup steps above to create it.\n");
      process.exit(0);
    } else {
      console.log("✅ Invites table exists!");
      console.log("✨ Database is properly configured.\n");
      process.exit(0);
    }
  } catch (error) {
    // Try alternative approach - just try to query the invites table
    const { error: queryError } = await supabase
      .from("invites")
      .select("id")
      .limit(1);

    if (queryError && queryError.code === "PGRST205") {
      console.log("⚠️  The 'invites' table does not exist in Supabase.\n");
      console.log("📋 To set up the table, follow these steps:\n");
      console.log("1. Go to your Supabase Dashboard: https://app.supabase.com");
      console.log('2. Select your project: "prime-media-7216b"');
      console.log('3. Navigate to "SQL Editor" in the left sidebar');
      console.log('4. Click "New Query"');
      console.log("5. Copy and paste the following SQL:\n");
      console.log("---BEGIN SQL---");

      // Read and display the migration SQL
      const migrationPath = path.join(
        __dirname,
        "../migrations/001_create_invites_table.sql",
      );
      const migrationSQL = fs.readFileSync(migrationPath, "utf-8");
      console.log(migrationSQL);

      console.log("---END SQL---\n");
      console.log('6. Click the "Run" button');
      console.log("7. Once complete, restart the backend server\n");
      console.log(
        "✨ That\'s it! The invites table will be created and ready to use.\n",
      );
      process.exit(0);
    } else if (!queryError) {
      console.log("✅ Invites table exists!");
      console.log("✨ Database is properly configured.\n");
      process.exit(0);
    } else {
      console.error("❌ Database check failed:", error);
      process.exit(1);
    }
  }
}

checkDatabase();
