import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Auth: either the long-standing ADMIN_PUSH_SECRET (unchanged, so anything already using it keeps
// working) or the key held inside the database (public.members_sync_key), which the scheduled
// job sends. The job used to send a hard-coded password that stopped matching, so the legacy
// members.json -> rewards sync failed with 401 for weeks.
const ADMIN_SECRET = Deno.env.get("ADMIN_PUSH_SECRET") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const GITHUB_TOKEN = Deno.env.get("GITHUB_TOKEN") ?? "";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "x-admin-secret, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return new Response(JSON.stringify({ error: "method-not-allowed" }), { status: 405, headers: CORS });

  const supplied = req.headers.get("x-admin-secret") ?? "";
  let authorized = !!ADMIN_SECRET && supplied === ADMIN_SECRET;
  if (!authorized && supplied) {
    const { data } = await sb.rpc("members_sync_authorized", { p: supplied });
    authorized = data === true;
  }
  if (!authorized) {
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: CORS });
  }

  try {
    // Authenticated read (repo is going private; anonymous raw URL would 404).
    const r = await fetch("https://api.github.com/repos/quarrymanagement/quarry-website/contents/members.json?ref=main", {
      headers: { "Authorization": "token " + GITHUB_TOKEN, "User-Agent": "Quarry-Members-Migrate", "Accept": "application/vnd.github.raw" },
    });
    if (!r.ok) {
      return new Response(JSON.stringify({ error: "fetch-failed", status: r.status }), { status: 500, headers: { ...CORS, "Content-Type": "application/json" } });
    }
    const json = await r.json();

    const { data, error } = await sb.rpc("migrate_legacy_members", { p_json: json });
    if (error) {
      return new Response(JSON.stringify({ error: error.message, details: error }), { status: 500, headers: { ...CORS, "Content-Type": "application/json" } });
    }

    return new Response(JSON.stringify({ ok: true, result: data }), { headers: { ...CORS, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: { ...CORS, "Content-Type": "application/json" } });
  }
});
