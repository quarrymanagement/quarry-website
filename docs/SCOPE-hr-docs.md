# Personnel Docs: employee e-signature (The Quarry)

Status: **built on `feature/hr-docs-esign`, not live.** Nothing is deployed, no migration is applied,
no bucket is created, and email is off by default.

## What it does

1. An HR admin adds a document. They can upload a PDF or type the text, and the text becomes a PDF.
   The document has a type: **Disciplinary notice**, **Policy acknowledgment**, or **Training acknowledgment**.
   A saved version can't be edited. To change a document, add a new one so every signature stays tied to the exact bytes that were signed.
2. The admin (or a scoped manager, policy/training only) assigns it to one or more people. Each person gets a
   private link that expires in 14 days. Email is optional; with email off, the admin copies the link and sends it themselves.
3. The employee opens the link and verifies identity (date of birth, last 4 of phone, or a 6-digit emailed code; 5 tries, then locked).
   Only after that do they see the document, its title, or its type. Emails never name the type: every sign request has the subject
   "Please review & sign - The Quarry ({ref})", every signed-copy email has the subject "Your signed copy - The Quarry ({ref})"
   (no title), and a disciplinary notice's default title is the neutral "Written notice".
4. The employee reads the whole PDF and agrees to sign electronically. That E-SIGN consumer disclosure covers the right to paper,
   how to withdraw, and the hardware needed, and the server records it as its own audit event. The employee then signs by typing
   their name or drawing a signature, and can add optional comments.
   The signature block reads: *"By signing, I acknowledge that I received and reviewed this document. My signature
   acknowledges receipt, not agreement."*
5. If the employee is flagged as a minor (the admin's "Minor" box, pre-ticked when a DOB entered shows under 18) and the document needs a guardian, the system emails a second private link
   to the parent/guardian. The guardian verifies with the employee's DOB (or an emailed code) and signs. Above their checkbox the guardian sees
   *"I am the parent or legal guardian of {employee name}. By signing, I acknowledge…"*, and that text is saved with their signature.
   The guardian can also choose "I don't want to sign electronically"; a manager then follows up on paper.
6. The server builds a **locked final PDF**:
   - the original pages, unchanged
   - an Acknowledgment page with the signature(s), comments, and any decline or refusal
   - an **Electronic Record Audit Certificate** (the "Signed electronically under E-SIGN/UETA" line prints only when signed;
     declined and refused records get the neutral "Electronic record created under…" line) with signer, time (America/Chicago), IP, user agent, the identity check used,
     the consent time, and the SHA-256 of the version signed, plus the full event log in plain words (Sent, Opened, Identity verified, …).
     Internal event codes stay in the database only.

   The final PDF is stored once (no overwrite), and its SHA-256 is recorded. The employee and guardian can download it from their link.
7. Statuses: `sent`, `viewed`, `awaiting_guardian`, `signed`, `declined` (employee declines, with an optional reason),
   `refused_witnessed` (a manager records an in-person refusal with a witness name and a required "Copy offered to employee?" answer:
   Copy provided / Copy offered and declined / Not provided), and `voided` (admin only, reason required).

## Who sees what

| | Owner / HR admin | Scoped manager (`hr_role_scopes`) | Anyone else |
|---|---|---|---|
| Disciplinary notices | yes | **no** (hidden, 404) | no |
| Policy / training acks | all staff | only staff in their departments | no |
| Add documents, void, edit people | yes | no | no |

- The owner role is always an HR admin. Other admin roles have no access until a row is added to `hr_role_scopes`
  (the table starts empty).
- The module is separate from the Write-Ups tab and from staff evals, and nothing from it appears there.

## Data model (migration `supabase/migrations/20261026160000_hr_documents_esign.sql`)

- **`hr_employees`**: the HR roster. Fields: name, email, phone last 4, a keyed HMAC of the DOB (`dob_hmac`; the date itself is never stored), a minor flag, `turns_18_month` (minors only: the first of the month they turn 18, computed from the DOB when it is entered; NULL for adults and cleared when Minor is unticked), guardian name/email, department, position, links to the Square/checklist roster.
- **`hr_role_scopes`**: which admin role is an HR admin, or which departments a role can manage.
- **`hr_documents`**: document headers. **`hr_document_versions`** holds the stored PDF path, SHA-256 and page count, and is append-only.
- **`hr_assignments`**: one row per document per person. Holds the hashed link token, status, guardian fields, outcome, and final PDF path/hash.
- **`hr_signatures`**: one row per party (employee or guardian). Append-only.
- **`hr_audit`**: an append-only event log.
- **Guards:**
  - Deletes and truncates are blocked on every HR table.
  - Versions, signatures and audit can't be updated.
  - A completed assignment can only be voided, the void needs a reason, and a void can't be undone.
- **Access:** RLS is on, with no policies, and all privileges are revoked from `anon`/`authenticated`. Only the edge function (service role) can read the tables.
- **Storage:** a private bucket `hr-documents` (PDF only, 20 MB) with no storage policies and no public URLs. Files are downloaded only through the function.
- **Turns 18:** from the first of that month, HR admins see the alert "Turns 18 this month. Untick 'Minor' only on or after their birthday." and a "Turns 18" tag (managers never do). A Netlify scheduled
  function (`netlify/functions/hr-minor-check.js`, daily 13:00 UTC = 8 AM CDT / 7 AM CST) calls the function's `cron_minor_check`
  action with the `x-hr-cron-key` header. It writes one "Turns 18 this month" audit entry per person per month and sends no email.
  It does nothing until `HR_CRON_KEY` is set on both sides.
- **Rollback:** `...rollback.sql`. It refuses to run once any assignment exists.

## Code

- `supabase/functions/hr-docs/`: a Deno edge function, deployed with `--no-verify-jwt` because it checks auth itself.
  - Admin calls send the existing admin session token (`x-admin-token`), which is verified by `/.netlify/functions/verify-admin-password`.
  - Signer calls use the private link plus a short (30 min) signed session after identity verification.
  - Files: `pdf.ts` (pdf-lib: text→PDF, final PDF + audit certificate), `storage.ts` (private bucket), `dev/` (local-only demo server).
- `admin/hr-docs-admin.js`: adds **Team › Personnel Docs** to the admin dashboard, with these views:
  - Send a document
  - Status (with detail, audit trail, downloads, new link, refused-in-person, void)
  - Documents
  - Personnel files
  - Who hasn't signed (defaults to the document tagged `alcohol_ack`, with "send to everyone not yet sent")
- `hr-sign.html`: a mobile-first signing page for employees and guardians. The link token is removed from the address bar after load.
- `netlify.toml`: `/supabase/*` and `/docs/*` are not served from the CDN.

## Identity verification (recommendation)

The private emailed link is the first factor. The second factor is picked per person:

1. **DOB** when on file. This is preferred. The DOB is used only for this check: it is stored only as `v1:` + HMAC-SHA256(`HR_DOB_HMAC_KEY`, employee id + YYYY-MM-DD), the key lives only in function secrets, and no admin or manager screen, API response, audit entry or PDF ever contains the date or its hash. Admins see only "on file" and can replace or remove it.
2. **Last 4 of phone** when there's no DOB.
3. **A 6-digit emailed code** as the fallback.

For people with no email, a manager can open the link with them in person.

## Going live (after Matt's answers)

1. Apply the migration to the Supabase project. It creates the tables and the private bucket.
2. Set function secrets:
   - `HR_SIGNING_SECRET` (random, at least 32 characters)
   - `HR_DOB_HMAC_KEY` (random, at least 32 characters; keep it safe: if it is lost or changed, DOBs must be re-entered)
   - `HR_EMAIL_MODE=sendgrid` and `SENDGRID_API_KEY`, or leave email `off`
   - `HR_FROM_EMAIL`
   - `HR_CRON_KEY` (random, at least 32 characters; the same value in the Netlify env vars, for the daily turns-18 check)
   - `SUPABASE_DB_URL` (provided by default)
3. Deploy the `hr-docs` function with `--no-verify-jwt`.
4. Merge the branch so Netlify publishes the admin tab and `hr-sign.html`.
5. Load staff: **Import roster**, then add emails, DOBs, and guardian emails for minors.
6. Add `hr_role_scopes` rows for any manager role that should send policy/training docs.
7. Send one test document to a volunteer, check the final PDF, then send the alcohol acknowledgment to everyone.

This design is not legal advice. Have counsel review the consent text and the discipline-notice wording before first use.
