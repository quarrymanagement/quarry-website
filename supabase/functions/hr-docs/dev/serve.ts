// LOCAL DEMO ONLY. Serves the repo's static files and the hr-docs function
// against a local Postgres + local disk storage. Never deploy this file.
//   HR_DEV=1 SUPABASE_DB_URL=postgres://postgres@127.0.0.1:54329/hrdemo \
//   HR_DEV_STORAGE_DIR=/tmp/hrstore HR_SIGNING_SECRET=$(openssl rand -hex 32) \
//   deno run -A supabase/functions/hr-docs/dev/serve.ts
const PORT = Number(Deno.env.get("PORT") ?? 8788);
const ROOT = new URL("../../../../", import.meta.url).pathname; // repo root
Deno.env.set("HR_SITE_URL", `http://localhost:${PORT}`);
Deno.env.set("HR_SIGN_URL", `http://localhost:${PORT}/hr-sign.html`);
Deno.env.set("SUPABASE_URL", "http://localhost");
Deno.env.set("HR_EMAIL_MODE", "off");
const { handle } = await import("../handler.ts");

const TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript",
  css: "text/css",
  png: "image/png",
  jpg: "image/jpeg",
  svg: "image/svg+xml",
  json: "application/json",
  ico: "image/x-icon",
  webp: "image/webp",
  pdf: "application/pdf",
};

Deno.serve({ port: PORT, hostname: "127.0.0.1" }, async (req, info) => {
  const url = new URL(req.url);
  if (url.pathname === "/functions/v1/hr-docs") {
    const h = new Headers(req.headers);
    h.set("x-forwarded-for", (info.remoteAddr as Deno.NetAddr).hostname);
    return handle(new Request(req, { headers: h }));
  }
  if (url.pathname.startsWith("/.netlify/functions/")) {
    // stub: the real admin login is never called locally
    if (url.pathname.endsWith("/verify-admin-password") && req.method === "POST") {
      const b = await req.json().catch(() => ({}));
      const t = String(b.token ?? "");
      return Response.json(t.startsWith("dev:") ? { ok: true, role: t.slice(4) } : { ok: false });
    }
    return Response.json({ ok: false, stub: true }, { status: 404 });
  }
  let p = decodeURIComponent(url.pathname);
  if (p.endsWith("/")) p += "index.html";
  if (p.includes("..")) return new Response("no", { status: 400 });
  try {
    const body = await Deno.readFile(ROOT + p.slice(1));
    return new Response(body, { headers: { "content-type": TYPES[p.split(".").pop()!] ?? "application/octet-stream" } });
  } catch {
    return new Response("not found", { status: 404 });
  }
});
