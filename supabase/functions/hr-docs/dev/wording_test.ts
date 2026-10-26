// Unit tests for Legal's wording rules (no database, no network, fake data only).
//   cd supabase/functions/hr-docs && deno test -A dev/wording_test.ts
function assert(c: unknown, msg = "assertion failed"): asserts c {
  if (!c) throw new Error(msg);
}
function assertEquals(a: unknown, b: unknown) {
  if (a !== b) throw new Error(`expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}
Deno.env.set("HR_DEV", "1");
Deno.env.set("SUPABASE_URL", "http://localhost");
Deno.env.set("HR_DEV_STORAGE_DIR", await Deno.makeTempDir());
Deno.env.set("HR_EMAIL_MODE", "off");
const H = await import("../handler.ts");
const P = await import("../pdf.ts");

const TYPE_WORDS = /disciplin|warning|written warning|corrective|policy acknowledg|training acknowledg|write-?up/i;

Deno.test("sign-request email: one neutral subject for every type, body never names the type", () => {
  for (const who of ["employee", "guardian"] as const) {
    for (const reminder of [false, true]) {
      const m = H.signRequestEmail(
        "HR-2026-0001",
        "Written notice",
        "Sam Sample",
        "https://x.test/hr-sign.html?t=abc",
        who,
        reminder,
      );
      assertEquals(m.subject, "Please review & sign - The Quarry (HR-2026-0001)");
      assert(!TYPE_WORDS.test(m.subject + m.html), `type word leaked (${who}, reminder=${reminder})`);
      for (const label of Object.values(H.KIND_LABEL)) assert(!m.html.includes(label as string));
    }
  }
  const e = H.signRequestEmail("HR-1", "Written notice", "Sam Sample", "https://x.test/", "employee");
  assert(e.html.includes("The Quarry sent you a document to review: <strong>Written notice</strong>"));
  const g = H.signRequestEmail("HR-1", "Written notice", "Pat Sample", "https://x.test/", "guardian");
  assert(
    g.html.includes("Because the employee is under 18, The Quarry also asks a parent or guardian to review and acknowledge it."),
  );
  assert(!g.html.includes("Missouri practice"));
});

Deno.test("discipline default title is neutral", () => {
  assertEquals(H.DISCIPLINE_DEFAULT_TITLE, "Written notice");
  assert(!TYPE_WORDS.test(H.DISCIPLINE_DEFAULT_TITLE));
});

Deno.test("certificate legal line: 'Signed electronically' only when signed", () => {
  assertEquals(P.CERT_HEADING, "Electronic Record Audit Certificate");
  assert(P.certLegalLine("signed").startsWith("Signed electronically under the federal E-SIGN Act"));
  for (const o of ["declined", "refused_witnessed"] as const) {
    assertEquals(
      P.certLegalLine(o),
      "Electronic record created under the federal E-SIGN Act and the Missouri Uniform Electronic Transactions Act (RSMo 432.200-432.295). All times America/Chicago.",
    );
    assert(!/signed electronically/i.test(P.certLegalLine(o)));
  }
});

Deno.test("guardian attestation and consent wording are exact", () => {
  assertEquals(
    H.guardianAck("Sam Sample"),
    "I am the parent or legal guardian of Sam Sample. By signing, I acknowledge that I received and reviewed this document. My signature acknowledges receipt, not agreement.",
  );
  assert(
    H.CONSENT_STATEMENT.endsWith(
      "To view and sign, I need a device with a current web browser. If I don't have email, a manager can give me my private link and a paper copy of the signed document.",
    ),
  );
  assert(!H.CONSENT_STATEMENT.includes("and an email address"));
});

Deno.test("event names are plain words", () => {
  const want: Record<string, string> = {
    sent: "Sent",
    viewed: "Opened",
    identity_verified: "Identity verified",
    consented: "Agreed to e-sign",
    signed: "Signed",
    guardian_signed: "Parent/guardian signed",
    declined: "Declined",
    refused_witnessed: "Refused (witnessed)",
    voided: "Withdrawn",
  };
  for (const [k, v] of Object.entries(want)) assertEquals(H.eventLabel(k), v);
  for (const v of Object.values(H.EVENT_LABEL)) assert(!/_/.test(v as string), `code-like label: ${v}`);
  assertEquals(H.eventLabel("some_new_code"), "Other event");
});

Deno.test("turns-18 month: first of the month, month + year only", () => {
  assertEquals(H.turns18Month("2009-06-17"), "2027-06-01");
  assertEquals(H.turns18Month("2008-12-31"), "2026-12-01");
  assertEquals(H.ctMonthStart(new Date("2026-11-01T03:00:00Z")), "2026-10-01"); // still Oct 31 in Chicago
});
