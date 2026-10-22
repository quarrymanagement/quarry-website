// Supabase Edge Function: event-pii
//
// The only door into public.event_registrant_pii (buyer name / email / phone
// for event tickets, kept out of the public events.json). Called server-side
// from Netlify functions with the shared secret EVENT_PII_KEY in x-access-key;
// the key never reaches a browser. Fails closed if the secret is not set.
// Deploy with --no-verify-jwt (auth is the shared secret, like receipt-review).
//
// POST { action: 'upsert', rows: [{event_id, ref, name, email, phone, business_name, business_type}], source }
// POST { action: 'list', event_ids?: string[] }   -> { ok, rows }
// POST { action: 'lookup', event_id, ref }         -> { ok, row }
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const supa = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const ACCESS_KEY = Deno.env.get("EVENT_PII_KEY") || "";
const COLS = "event_id, ref, name, email, phone, business_name, business_type";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-access-key",
  "Content-Type": "application/json",
};
const reply = (s: number, b: unknown) => new Response(JSON.stringify(b), { status: s, headers: CORS });

function safeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("", { status: 200, headers: CORS });
  if (req.method !== "POST") return reply(405, { error: "POST only" });
  if (!ACCESS_KEY || !safeEq(req.headers.get("x-access-key") || "", ACCESS_KEY)) return reply(401, { error: "unauthorized" });

  let body: any;
  try { body = await req.json(); } catch { return reply(400, { error: "invalid_json" }); }

  try {
    if (body.action === "upsert") {
      const rows = Array.isArray(body.rows) ? body.rows : [];
      if (!rows.length) return reply(200, { ok: true, upserted: 0 });
      if (rows.length > 5000) return reply(400, { error: "too_many_rows" });
      const { data, error } = await supa.rpc("event_pii_upsert", { p_rows: rows, p_source: String(body.source || "") || null });
      if (error) return reply(500, { error: "upsert_failed", message: error.message });
      return reply(200, { ok: true, upserted: data });
    }
    if (body.action === "list") {
      const ids: string[] | null = Array.isArray(body.event_ids) && body.event_ids.length ? body.event_ids.map(String) : null;
      const out: any[] = [];
      const PAGE = 1000;
      for (let from = 0; ; from += PAGE) {
        let q = supa.from("event_registrant_pii").select(COLS).order("event_id").order("ref").range(from, from + PAGE - 1);
        if (ids) q = q.in("event_id", ids);
        const { data, error } = await q;
        if (error) return reply(500, { error: "list_failed", message: error.message });
        out.push(...(data || []));
        if (!data || data.length < PAGE) break;
      }
      return reply(200, { ok: true, rows: out });
    }
    if (body.action === "lookup") {
      const { data, error } = await supa.from("event_registrant_pii").select(COLS)
        .eq("event_id", String(body.event_id || "")).eq("ref", String(body.ref || "")).maybeSingle();
      if (error) return reply(500, { error: "lookup_failed", message: error.message });
      return reply(200, { ok: true, row: data });
    }
    return reply(400, { error: "unknown_action" });
  } catch (e) {
    return reply(500, { error: "exception", message: (e as Error).message });
  }
});
