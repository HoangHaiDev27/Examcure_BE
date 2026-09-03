import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { requireIntegrationEnv } from "./env.js";

let client: SupabaseClient | null = null;

export function getSupabaseAdmin(): SupabaseClient {
  if (!client) {
    client = createClient(
      requireIntegrationEnv("SUPABASE_URL"),
      requireIntegrationEnv("SUPABASE_SERVICE_ROLE_KEY"),
      { auth: { autoRefreshToken: false, persistSession: false } },
    );
  }
  return client;
}

export function getStorageBuckets() {
  return {
    originals: process.env.SUPABASE_ORIGINALS_BUCKET || "material-originals",
    previews: process.env.SUPABASE_PREVIEWS_BUCKET || "material-previews",
    slides: process.env.SUPABASE_SLIDES_BUCKET || "slide-images",
  };
}
