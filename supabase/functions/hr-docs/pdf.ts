// PDF building for hr-docs: text->PDF for "created" documents, and the locked
// final PDF = original pages (unchanged) + Acknowledgment page + Audit page.
import { PDFDocument, type PDFFont, type PDFPage, rgb, StandardFonts } from "pdf-lib";

export const TZ = "America/Chicago";

export function fmtCT(d: string | Date | null | undefined): string {
  if (!d) return "-";
  const dt = typeof d === "string" ? new Date(d) : d;
  return dt.toLocaleString("en-US", {
    timeZone: TZ,
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
  });
}

// pdf-lib standard fonts are WinAnsi only; replace anything else.
export function ansi(s: string): string {
  return String(s ?? "")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\u2026/g, "...")
    .replace(/\r/g, "")
    .replace(/[^\t\n\x20-\x7E\xA0-\xFF]/g, "?");
}

function wrap(text: string, font: PDFFont, size: number, maxW: number): string[] {
  const out: string[] = [];
  for (const para of ansi(text).split("\n")) {
    if (!para.trim()) {
      out.push("");
      continue;
    }
    let line = "";
    for (const word of para.split(/\s+/)) {
      const t = line ? line + " " + word : word;
      if (font.widthOfTextAtSize(t, size) <= maxW) line = t;
      else {
        if (line) out.push(line);
        // hard-break very long tokens (hashes, URLs)
        let w = word;
        while (font.widthOfTextAtSize(w, size) > maxW) {
          let n = w.length;
          while (n > 1 && font.widthOfTextAtSize(w.slice(0, n), size) > maxW) n--;
          out.push(w.slice(0, n));
          w = w.slice(n);
        }
        line = w;
      }
    }
    out.push(line);
  }
  return out;
}

const W = 612, H = 792, M = 54;
const INK = rgb(0.1, 0.1, 0.12), MUTED = rgb(0.42, 0.42, 0.45), RULE = rgb(0.8, 0.8, 0.82);

class Writer {
  page!: PDFPage;
  y = 0;
  constructor(
    public pdf: PDFDocument,
    public font: PDFFont,
    public bold: PDFFont,
    public header: string,
  ) {
    this.newPage();
  }
  newPage() {
    this.page = this.pdf.addPage([W, H]);
    this.page.drawText(ansi(this.header), { x: M, y: H - 34, size: 8, font: this.font, color: MUTED });
    this.y = H - M - 10;
  }
  ensure(h: number) {
    if (this.y - h < M + 20) this.newPage();
  }
  text(s: string, o: { size?: number; bold?: boolean; color?: any; gap?: number; indent?: number } = {}) {
    const size = o.size ?? 10, f = o.bold ? this.bold : this.font, lh = size * 1.35;
    for (const ln of wrap(s, f, size, W - 2 * M - (o.indent ?? 0))) {
      this.ensure(lh);
      this.page.drawText(ln, { x: M + (o.indent ?? 0), y: this.y - size, size, font: f, color: o.color ?? INK });
      this.y -= lh;
    }
    this.y -= o.gap ?? 4;
  }
  kv(k: string, v: string) {
    const size = 9, lh = 12.5, kw = 150;
    const lines = wrap(v, this.font, size, W - 2 * M - kw);
    this.ensure(lh * lines.length);
    this.page.drawText(ansi(k), { x: M, y: this.y - size, size, font: this.bold, color: MUTED });
    for (const ln of lines) {
      this.page.drawText(ln, { x: M + kw, y: this.y - size, size, font: this.font, color: INK });
      this.y -= lh;
    }
    this.y -= 2;
  }
  rule() {
    this.ensure(10);
    this.page.drawLine({ start: { x: M, y: this.y }, end: { x: W - M, y: this.y }, thickness: 0.6, color: RULE });
    this.y -= 10;
  }
}

export async function textToPdf(title: string, kindLabel: string, body: string): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(ansi(title));
  pdf.setProducer("The Quarry HR Docs");
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const w = new Writer(pdf, font, bold, `The Quarry - ${kindLabel}`);
  w.text(title, { size: 16, bold: true, gap: 10 });
  w.text(body, { size: 10.5 });
  return await pdf.save({ useObjectStreams: false });
}

export async function pageCount(bytes: Uint8Array): Promise<number> {
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  return pdf.getPageCount();
}

export interface FinalInput {
  originalBytes: Uint8Array;
  title: string;
  kindLabel: string;
  refNo: string;
  version: number;
  docSha256: string;
  employeeName: string;
  outcome: "signed" | "declined" | "refused_witnessed";
  signatures: Array<{
    party: string;
    ack_statement: string;
    signer_name: string;
    signature_method: string;
    signature_image: string | null;
    comments: string | null;
    consent_statement: string;
    consent_at: string;
    identity_method: string;
    ip: string | null;
    user_agent: string | null;
    doc_sha256: string;
    signed_at: string;
  }>;
  decline?: { at: string; reason: string | null; by?: "employee" | "guardian" };
  refusal?: { at: string; witness: string; note: string | null; recordedBy: string; copy: string };
  audit: Array<{ created_at: string; event: string; actor: string; ip: string | null; user_agent: string | null }>;
  generatedAt: Date;
}

export const CERT_HEADING = "Electronic Record Audit Certificate";
// "Signed electronically" only when it was signed; declined / refused records get the neutral line.
export const certLegalLine = (outcome: FinalInput["outcome"]) =>
  outcome === "signed"
    ? "Signed electronically under the federal E-SIGN Act (15 U.S.C. 7001 et seq.) and the Missouri Uniform Electronic Transactions Act (RSMo 432.200-432.295). All times America/Chicago."
    : "Electronic record created under the federal E-SIGN Act and the Missouri Uniform Electronic Transactions Act (RSMo 432.200-432.295). All times America/Chicago.";

export async function buildFinalPdf(inp: FinalInput): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(ansi(`${inp.title} - ${inp.employeeName} - ${inp.refNo}`));
  pdf.setProducer("The Quarry HR Docs");
  pdf.setCreationDate(inp.generatedAt);
  pdf.setModificationDate(inp.generatedAt);
  const src = await PDFDocument.load(inp.originalBytes, { updateMetadata: false });
  for (const p of await pdf.copyPages(src, src.getPageIndices())) pdf.addPage(p);

  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const head = `The Quarry - ${inp.kindLabel} - Ref ${inp.refNo}`;

  // ---- Acknowledgment page
  const w = new Writer(pdf, font, bold, head);
  const heading = inp.outcome === "signed"
    ? "Acknowledgment of Receipt"
    : inp.outcome === "declined"
    ? "Declined to Sign"
    : "Refusal to Sign (Witnessed)";
  w.text(heading, { size: 16, bold: true, gap: 6 });
  w.text(`${inp.title} (version ${inp.version})`, { size: 11, gap: 10 });
  w.kv("Employee", inp.employeeName);
  w.kv("Reference", inp.refNo);
  w.kv("Document SHA-256", inp.docSha256);
  w.rule();

  for (const s of inp.signatures) {
    w.text(s.party === "guardian" ? "Parent / Guardian signature" : "Employee signature", { size: 12, bold: true });
    w.text(s.ack_statement, { size: 10, color: MUTED, gap: 8 }); // exact text that signer saw
    if (s.signature_method === "drawn" && s.signature_image?.startsWith("data:image/png;base64,")) {
      try {
        const png = await pdf.embedPng(
          Uint8Array.from(atob(s.signature_image.split(",")[1]), (c) => c.charCodeAt(0)),
        );
        const scale = Math.min(220 / png.width, 70 / png.height, 1);
        w.ensure(png.height * scale + 6);
        w.page.drawImage(png, { x: M, y: w.y - png.height * scale, width: png.width * scale, height: png.height * scale });
        w.y -= png.height * scale + 4;
      } catch { /* fall through to typed name */ }
    } else {
      w.ensure(30);
      w.page.drawText(ansi(s.signer_name), {
        x: M,
        y: w.y - 22,
        size: 22,
        font: await pdf.embedFont(StandardFonts.TimesRomanItalic),
        color: INK,
      });
      w.y -= 30;
    }
    w.page.drawLine({ start: { x: M, y: w.y }, end: { x: M + 260, y: w.y }, thickness: 0.8, color: INK });
    w.y -= 6;
    w.kv("Printed name", s.signer_name);
    w.kv("Signed at", fmtCT(s.signed_at));
    w.kv("Method", s.signature_method === "drawn" ? "Drawn signature" : "Typed signature");
    w.kv("Identity check", s.identity_method);
    w.kv("E-sign consent at", fmtCT(s.consent_at));
    w.kv("Comments", s.comments?.trim() ? s.comments : "(none)");
    w.y -= 6;
  }
  if (inp.decline) {
    w.text(
      inp.decline.by === "guardian"
        ? "The parent/guardian declined to sign electronically."
        : "The employee declined to sign electronically.",
      { size: 11, bold: true },
    );
    w.kv("Declined at", fmtCT(inp.decline.at));
    w.kv("Reason given", inp.decline.reason?.trim() ? inp.decline.reason : "(none)");
  }
  if (inp.refusal) {
    w.text("The employee was presented this document and refused to sign. Recorded by a manager with a witness.", {
      size: 11,
      bold: true,
    });
    w.kv("Refused at", fmtCT(inp.refusal.at));
    w.kv("Witness", inp.refusal.witness);
    w.kv("Recorded by", inp.refusal.recordedBy);
    w.kv("Copy offered to employee", inp.refusal.copy);
    w.kv("Note", inp.refusal.note?.trim() ? inp.refusal.note : "(none)");
  }

  // ---- Audit page
  const a = new Writer(pdf, font, bold, head);
  a.text(CERT_HEADING, { size: 15, bold: true, gap: 6 });
  a.text(certLegalLine(inp.outcome), { size: 9, color: MUTED, gap: 10 });
  a.kv("Document", `${inp.title} (version ${inp.version})`);
  a.kv("Reference", inp.refNo);
  a.kv("Original document SHA-256", inp.docSha256);
  a.kv("Original pages", String(src.getPageCount()));
  a.kv("Outcome", heading);
  a.kv("Certificate generated", fmtCT(inp.generatedAt));
  a.rule();
  for (const s of inp.signatures) {
    a.text(s.party === "guardian" ? "Parent / Guardian" : "Employee", { size: 11, bold: true });
    a.kv("Name", s.signer_name);
    a.kv("Signed", fmtCT(s.signed_at));
    a.kv("IP address", s.ip ?? "-");
    a.kv("Browser (user agent)", s.user_agent ?? "-");
    a.kv("Hash of version signed", s.doc_sha256);
    a.kv("Consent statement", s.consent_statement);
    a.y -= 4;
  }
  a.rule();
  a.text("Event log", { size: 11, bold: true });
  for (const e of inp.audit) {
    a.kv(fmtCT(e.created_at), `${e.event} - ${e.actor}${e.ip ? " - IP " + e.ip : ""}`);
  }
  a.y -= 6;
  a.text(
    "The SHA-256 of this completed file is recorded in The Quarry's HR system at the time it was generated. Any change to this file will change that value.",
    { size: 8.5, color: MUTED },
  );

  return await pdf.save({ useObjectStreams: false });
}
