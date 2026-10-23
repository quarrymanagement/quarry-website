# Pending Supabase edge-function changes — NOT DEPLOYED

Project `nkulhtalltbieicvmmad`. These are needed before the repo goes private.
Each file here is the **live** source (downloaded Oct 23, 2026; square-webhook = live v35),
with only the change below. The `supabase/functions/square-webhook` copy in this repo is
older than live, so **don't** deploy from that one.

| Function | Change | Diff |
|---|---|---|
| `square-webhook` | Its two anonymous `raw.githubusercontent.com/.../events.json` fallback reads (`syncRegistrations` and `readEventsFile`) now call a new `ghRawEvents()` helper. The helper does `GET api.github.com/repos/quarrymanagement/quarry-website/contents/events.json?ref=main` with `Authorization: token GITHUB_TOKEN` and `Accept: application/vnd.github.raw`, and throws on non-200. These are only fallbacks: events.json is about 210 KB, so the base64 contents-API path normally runs. | `square-webhook.diff` |
| `migrate-legacy-members-once` | The anonymous raw `members.json` read is now the same authenticated contents-API raw read. Adds `const GITHUB_TOKEN = Deno.env.get("GITHUB_TOKEN")`. | `migrate-legacy-members-once.diff` |

`GITHUB_TOKEN` already exists in this project's secrets. square-webhook uses it for its
contents-API GET/PUT, and its "Registration sync" commits landed on main Oct 23, 2026 at 10:37 AM CT.
Secrets are project-wide, so migrate-legacy-members-once gets it too.

I grepped all 167 live edge functions; no others read raw.githubusercontent.com.

Deploy (after review):
    supabase functions deploy square-webhook --project-ref nkulhtalltbieicvmmad   # from a dir holding this index.ts
    supabase functions deploy migrate-legacy-members-once --project-ref nkulhtalltbieicvmmad
Keep each function's existing verify_jwt setting.
