# hr-docs local demo (fake data only)

`serve.ts` serves the site's static files plus the `hr-docs` function against a **local** Postgres and a **local disk** folder. It
is never deployed.

- Dev mode (`HR_DEV=1`) is ignored whenever `SUPABASE_URL` contains `supabase.co`, so it cannot switch on against the hosted
  project.
- In dev mode admin tokens look like `dev:<role>` and email is always off.
- Use only made-up people and sample documents. Never load real personnel files.

```
initdb + apply supabase/migrations/20261026160000_hr_documents_esign.sql to a local DB
HR_DEV=1 SUPABASE_DB_URL=postgres://postgres@127.0.0.1:54329/hrdemo \
HR_DEV_STORAGE_DIR=/tmp/hrstore HR_SIGNING_SECRET=$(openssl rand -hex 32) HR_DOB_HMAC_KEY=$(openssl rand -hex 32) \
HR_CRON_KEY=$(openssl rand -hex 32) \
deno run -A supabase/functions/hr-docs/dev/serve.ts
# then open http://localhost:8788/admin/ with localStorage quarryAdminToken = "dev:owner"
```

Wording/unit tests (no database needed; run from this function's folder so `deno.json` is used):

```
cd supabase/functions/hr-docs && deno test -A dev/wording_test.ts
```

They cover email subject/body neutrality, the "Written notice" default title, the certificate line per outcome, the exact guardian
attestation and consent text, the plain event words, and the turns-18 month.

The daily turns-18 check can be run by hand against the dev server:

```
curl -s -X POST localhost:8788/functions/v1/hr-docs -H 'content-type: application/json' \
  -H "x-hr-cron-key: $HR_CRON_KEY" -d '{"action":"cron_minor_check"}'
```
