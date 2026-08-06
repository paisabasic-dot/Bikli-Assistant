/**
 * Create real Microsoft Office files (.docx / .xlsx / .pptx) from Node.
 *
 * These are proper OOXML packages (ZIP + XML), so Word / Excel / PowerPoint
 * open them correctly. Used when the Python desktop agent is old, missing
 * python-docx/openpyxl/python-pptx, or offline.
 */

import * as fs from "fs";
import * as path from "path";
import * as zlib from "zlib";

// ---------------------------------------------------------------------------
// Minimal ZIP (STORE or DEFLATE) writer — enough for OOXML packages.
// ---------------------------------------------------------------------------

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? (0xedb88320 ^ (c >>> 1)) : c >>> 1;
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

interface ZipEntry {
  name: string;
  data: Buffer;
}

function buildZip(entries: ZipEntry[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, "utf8");
    const raw = entry.data;
    const compressed = zlib.deflateRawSync(raw);
    const useDeflate = compressed.length < raw.length;
    const payload = useDeflate ? compressed : raw;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header sig
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0, 12); // date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra len

    parts.push(local, nameBuf, payload);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); // central dir sig
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0, 8);
    cen.writeUInt16LE(method, 10);
    cen.writeUInt16LE(0, 12);
    cen.writeUInt16LE(0, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(payload.length, 20);
    cen.writeUInt32LE(raw.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt16LE(0, 30);
    cen.writeUInt16LE(0, 32);
    cen.writeUInt16LE(0, 34);
    cen.writeUInt16LE(0, 36);
    cen.writeUInt32LE(0, 38);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf);

    offset += local.length + nameBuf.length + payload.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...parts, centralBuf, end]);
}

function xmlEscape(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function asStringList(value: unknown): string[] {
  if (value == null) return [];
  if (Array.isArray(value)) return value.map((v) => String(v));
  return [String(value)];
}

function ensureParentDir(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function ensureSuffix(filePath: string, suffix: string): string {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(suffix.toLowerCase())) return filePath;
  // Replace wrong office/text extension, or append if none.
  const known = [".docx", ".doc", ".xlsx", ".xls", ".pptx", ".ppt", ".txt", ".md", ".csv"];
  const ext = path.extname(filePath).toLowerCase();
  if (known.includes(ext)) {
    return filePath.slice(0, -ext.length) + suffix;
  }
  return filePath + suffix;
}

function writeZipFile(filePath: string, entries: ZipEntry[]): string {
  ensureParentDir(filePath);
  const buf = buildZip(entries);
  fs.writeFileSync(filePath, buf);
  return filePath;
}

// ---------------------------------------------------------------------------
// Word (.docx)
// ---------------------------------------------------------------------------

function paragraphsFromArgs(args: Record<string, unknown>): string[] {
  if (args.paragraphs != null) {
    return asStringList(args.paragraphs).filter((p) => p.trim() !== "");
  }
  const content = args.content ?? args.text ?? args.body;
  if (content == null) return [];
  if (Array.isArray(content)) {
    return content.map(String).filter((p) => p.trim() !== "");
  }
  const text = String(content).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const blocks = text.split(/\n\n+/).map((b) => b.trim()).filter(Boolean);
  if (blocks.length > 1) return blocks;
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

function wordBodyXml(title: string | undefined, paragraphs: string[]): string {
  const parts: string[] = [];
  if (title) {
    parts.push(
      `<w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="36"/></w:rPr><w:t xml:space="preserve">${xmlEscape(title)}</w:t></w:r></w:p>`,
    );
  }
  if (paragraphs.length === 0 && !title) {
    parts.push("<w:p/>");
  }
  for (const para of paragraphs) {
    if (para.startsWith("### ")) {
      parts.push(
        `<w:p><w:pPr><w:pStyle w:val="Heading3"/></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="24"/></w:rPr><w:t xml:space="preserve">${xmlEscape(para.slice(4))}</w:t></w:r></w:p>`,
      );
    } else if (para.startsWith("## ")) {
      parts.push(
        `<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="28"/></w:rPr><w:t xml:space="preserve">${xmlEscape(para.slice(3))}</w:t></w:r></w:p>`,
      );
    } else if (para.startsWith("# ")) {
      parts.push(
        `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="32"/></w:rPr><w:t xml:space="preserve">${xmlEscape(para.slice(2))}</w:t></w:r></w:p>`,
      );
    } else if (para.startsWith("- ") || para.startsWith("* ")) {
      parts.push(
        `<w:p><w:pPr><w:ind w:left="720"/><w:numPr><w:ilvl w:val="0"/></w:numPr></w:pPr><w:r><w:t xml:space="preserve">• ${xmlEscape(para.slice(2))}</w:t></w:r></w:p>`,
      );
    } else {
      // Multi-line paragraph → soft breaks
      const lines = para.split("\n");
      const runs = lines
        .map((line, i) => {
          const t = `<w:r><w:t xml:space="preserve">${xmlEscape(line)}</w:t></w:r>`;
          return i === 0 ? t : `<w:r><w:br/></w:r>${t}`;
        })
        .join("");
      parts.push(`<w:p>${runs}</w:p>`);
    }
  }

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    ${parts.join("\n    ")}
    <w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>
  </w:body>
</w:document>`;
}

export function createWordFileNode(args: Record<string, unknown>): {
  ok: boolean;
  result?: Record<string, unknown>;
  error?: string;
} {
  try {
    let filePath = String(args.path || "").trim();
    if (!filePath) return { ok: false, error: "Parameter 'path' is required." };
    filePath = ensureSuffix(filePath, ".docx");
    if (fs.existsSync(filePath) && !args.overwrite) {
      return { ok: false, error: `File already exists: ${filePath}. Pass overwrite=true to replace.` };
    }

    const title = args.title != null ? String(args.title) : args.heading != null ? String(args.heading) : undefined;
    const paragraphs = paragraphsFromArgs(args);

    const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

    const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

    const docRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
</Relationships>`;

    writeZipFile(filePath, [
      { name: "[Content_Types].xml", data: Buffer.from(contentTypes, "utf8") },
      { name: "_rels/.rels", data: Buffer.from(rels, "utf8") },
      { name: "word/document.xml", data: Buffer.from(wordBodyXml(title, paragraphs), "utf8") },
      { name: "word/_rels/document.xml.rels", data: Buffer.from(docRels, "utf8") },
    ]);

    return {
      ok: true,
      result: {
        result: `Created Word document: ${filePath}`,
        path: filePath,
        folder: path.dirname(filePath),
        type: "docx",
      },
    };
  } catch (e: any) {
    return { ok: false, error: `Failed to create Word file: ${e?.message || e}` };
  }
}

// ---------------------------------------------------------------------------
// Excel (.xlsx)
// ---------------------------------------------------------------------------

function cellRef(row1: number, col1: number): string {
  // 1-based row/col → A1 style
  let n = col1;
  let col = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    col = String.fromCharCode(65 + rem) + col;
    n = Math.floor((n - 1) / 26);
  }
  return `${col}${row1}`;
}

function excelEscapeShared(s: string): string {
  return xmlEscape(s);
}

function rowsFromArgs(args: Record<string, unknown>): { headers: string[]; rows: unknown[][] } {
  let headers = asStringList(args.headers);
  let rows: unknown[][] = [];

  if (args.rows != null && Array.isArray(args.rows)) {
    for (const row of args.rows as unknown[]) {
      if (row && typeof row === "object" && !Array.isArray(row)) {
        const obj = row as Record<string, unknown>;
        if (headers.length === 0) headers = Object.keys(obj);
        rows.push(headers.map((h) => obj[h] ?? ""));
      } else if (Array.isArray(row)) {
        rows.push(row);
      } else {
        rows.push([row]);
      }
    }
    return { headers, rows };
  }

  if (args.data != null && Array.isArray(args.data)) {
    const data = args.data as unknown[];
    if (data.length && data.every((d) => d && typeof d === "object" && !Array.isArray(d))) {
      const seen: string[] = [];
      for (const item of data) {
        for (const k of Object.keys(item as object)) {
          if (!seen.includes(k)) seen.push(k);
        }
      }
      if (headers.length === 0) headers = seen;
      for (const item of data) {
        const obj = item as Record<string, unknown>;
        rows.push(headers.map((h) => obj[h] ?? ""));
      }
      return { headers, rows };
    }
    const matrix = data.map((item) => (Array.isArray(item) ? item : [item]));
    if (headers.length === 0 && matrix.length) {
      headers = matrix[0].map(String);
      rows = matrix.slice(1);
    } else {
      rows = matrix;
    }
    return { headers, rows };
  }

  if (args.content != null) {
    const text = String(args.content).replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
    const parsed: string[][] = [];
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      parsed.push(t.includes("\t") ? t.split("\t").map((c) => c.trim()) : t.split(",").map((c) => c.trim()));
    }
    if (headers.length === 0 && parsed.length) {
      headers = parsed[0];
      rows = parsed.slice(1);
    } else {
      rows = parsed;
    }
  }

  return { headers, rows };
}

function isNumeric(val: unknown): val is number {
  if (typeof val === "number" && Number.isFinite(val)) return true;
  if (typeof val === "string") {
    const s = val.trim();
    if (!s) return false;
    return /^-?\d+(\.\d+)?$/.test(s);
  }
  return false;
}

function sheetXml(headers: string[], rows: unknown[][], title?: string): string {
  const sheetRows: string[] = [];
  let r = 1;
  if (title) {
    sheetRows.push(
      `<row r="${r}"><c r="${cellRef(r, 1)}" t="inlineStr"><is><t>${excelEscapeShared(title)}</t></is></c></row>`,
    );
    r = 3;
  }
  if (headers.length) {
    const cells = headers
      .map((h, i) => `<c r="${cellRef(r, i + 1)}" t="inlineStr"><is><t>${excelEscapeShared(String(h))}</t></is></c>`)
      .join("");
    sheetRows.push(`<row r="${r}">${cells}</row>`);
    r += 1;
  }
  for (const row of rows) {
    const cells = row
      .map((val, i) => {
        const ref = cellRef(r, i + 1);
        if (isNumeric(val)) {
          const num = typeof val === "number" ? val : Number(String(val).trim());
          return `<c r="${ref}"><v>${num}</v></c>`;
        }
        return `<c r="${ref}" t="inlineStr"><is><t>${excelEscapeShared(val == null ? "" : String(val))}</t></is></c>`;
      })
      .join("");
    sheetRows.push(`<row r="${r}">${cells}</row>`);
    r += 1;
  }
  if (sheetRows.length === 0) {
    sheetRows.push(`<row r="1"><c r="A1" t="inlineStr"><is><t></t></is></c></row>`);
  }

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    ${sheetRows.join("\n    ")}
  </sheetData>
</worksheet>`;
}

export function createExcelFileNode(args: Record<string, unknown>): {
  ok: boolean;
  result?: Record<string, unknown>;
  error?: string;
} {
  try {
    let filePath = String(args.path || "").trim();
    if (!filePath) return { ok: false, error: "Parameter 'path' is required." };
    filePath = ensureSuffix(filePath, ".xlsx");
    if (fs.existsSync(filePath) && !args.overwrite) {
      return { ok: false, error: `File already exists: ${filePath}. Pass overwrite=true to replace.` };
    }

    const { headers, rows } = rowsFromArgs(args);
    const sheetName = String(args.sheet_name || args.sheet || "Sheet1").slice(0, 31);
    const title = args.title != null ? String(args.title) : undefined;

    const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`;

    const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

    const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
          xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="${xmlEscape(sheetName)}" sheetId="1" r:id="rId1"/>
  </sheets>
</workbook>`;

    const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`;

    writeZipFile(filePath, [
      { name: "[Content_Types].xml", data: Buffer.from(contentTypes, "utf8") },
      { name: "_rels/.rels", data: Buffer.from(rels, "utf8") },
      { name: "xl/workbook.xml", data: Buffer.from(workbook, "utf8") },
      { name: "xl/_rels/workbook.xml.rels", data: Buffer.from(workbookRels, "utf8") },
      { name: "xl/worksheets/sheet1.xml", data: Buffer.from(sheetXml(headers, rows, title), "utf8") },
    ]);

    return {
      ok: true,
      result: {
        result: `Created Excel spreadsheet: ${filePath}`,
        path: filePath,
        folder: path.dirname(filePath),
        type: "xlsx",
        sheet: sheetName,
        rows: rows.length,
        columns: Math.max(headers.length, ...rows.map((r) => r.length), 0),
      },
    };
  } catch (e: any) {
    return { ok: false, error: `Failed to create Excel file: ${e?.message || e}` };
  }
}

// ---------------------------------------------------------------------------
// PowerPoint (.pptx)
// ---------------------------------------------------------------------------

interface SlideSpec {
  title: string;
  bullets: string[];
}

function slidesFromArgs(args: Record<string, unknown>): { presentationTitle?: string; subtitle?: string; slides: SlideSpec[] } {
  const presentationTitle =
    args.title != null ? String(args.title) : args.presentation_title != null ? String(args.presentation_title) : undefined;
  const subtitle = args.subtitle != null ? String(args.subtitle) : undefined;

  if (args.slides != null && Array.isArray(args.slides)) {
    const slides: SlideSpec[] = [];
    for (const s of args.slides as unknown[]) {
      if (typeof s === "string") {
        slides.push({ title: s, bullets: [] });
        continue;
      }
      if (!s || typeof s !== "object") {
        slides.push({ title: String(s), bullets: [] });
        continue;
      }
      const obj = s as Record<string, unknown>;
      const title = String(obj.title || obj.heading || obj.name || "Slide");
      let bullets: string[] = [];
      if (obj.bullets != null || obj.points != null || obj.items != null) {
        bullets = asStringList(obj.bullets ?? obj.points ?? obj.items);
      } else {
        const body = obj.content ?? obj.body ?? obj.text ?? "";
        if (Array.isArray(body)) bullets = body.map(String);
        else {
          bullets = String(body)
            .replace(/\r\n/g, "\n")
            .split("\n")
            .map((l) => l.replace(/^[-•*]\s*/, "").trim())
            .filter(Boolean);
        }
      }
      slides.push({ title, bullets });
    }
    return { presentationTitle, subtitle, slides };
  }

  const body = args.content ?? args.body ?? args.text ?? "";
  let bullets: string[] = [];
  if (Array.isArray(body)) bullets = body.map(String);
  else {
    bullets = String(body)
      .replace(/\r\n/g, "\n")
      .split("\n")
      .map((l) => l.replace(/^[-•*]\s*/, "").trim())
      .filter(Boolean);
  }
  return {
    presentationTitle,
    subtitle,
    slides: [{ title: presentationTitle || "Presentation", bullets }],
  };
}

function pptSlideXml(slide: SlideSpec, index: number): string {
  // Simple title + bullet body using two text shapes (no theme dependency).
  const titleShape = `
    <p:sp>
      <p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
      <p:spPr>
        <a:xfrm><a:off x="457200" y="274638"/><a:ext cx="8229600" cy="1143000"/></a:xfrm>
        <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
      </p:spPr>
      <p:txBody>
        <a:bodyPr/><a:lstStyle/>
        <a:p><a:r><a:rPr lang="en-US" sz="3200" b="1"/><a:t>${xmlEscape(slide.title)}</a:t></a:r></a:p>
      </p:txBody>
    </p:sp>`;

  const bulletParas =
    slide.bullets.length === 0
      ? `<a:p><a:endParaRPr lang="en-US"/></a:p>`
      : slide.bullets
          .map(
            (b) =>
              `<a:p><a:pPr marL="342900" indent="-342900"><a:buFont typeface="Arial"/><a:buChar char="•"/></a:pPr><a:r><a:rPr lang="en-US" sz="2000"/><a:t>${xmlEscape(b)}</a:t></a:r></a:p>`,
          )
          .join("");

  const bodyShape = `
    <p:sp>
      <p:nvSpPr><p:cNvPr id="3" name="Content"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
      <p:spPr>
        <a:xfrm><a:off x="457200" y="1600200"/><a:ext cx="8229600" cy="4525963"/></a:xfrm>
        <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
      </p:spPr>
      <p:txBody>
        <a:bodyPr/><a:lstStyle/>
        ${bulletParas}
      </p:txBody>
    </p:sp>`;

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
       xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
       xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr/>
      ${titleShape}
      ${bodyShape}
    </p:spTree>
  </p:cSld>
  <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sld>`;
}

export function createPowerPointFileNode(args: Record<string, unknown>): {
  ok: boolean;
  result?: Record<string, unknown>;
  error?: string;
} {
  try {
    let filePath = String(args.path || "").trim();
    if (!filePath) return { ok: false, error: "Parameter 'path' is required." };
    filePath = ensureSuffix(filePath, ".pptx");
    if (fs.existsSync(filePath) && !args.overwrite) {
      return { ok: false, error: `File already exists: ${filePath}. Pass overwrite=true to replace.` };
    }

    const { presentationTitle, subtitle, slides: contentSlides } = slidesFromArgs(args);
    const slides: SlideSpec[] = [];
    if (presentationTitle && (contentSlides.length === 0 || contentSlides[0].title !== presentationTitle)) {
      slides.push({
        title: presentationTitle,
        bullets: subtitle ? [subtitle] : [],
      });
    }
    slides.push(...contentSlides);
    if (slides.length === 0) {
      slides.push({ title: presentationTitle || "Presentation", bullets: [] });
    }

    const contentTypeOverrides = slides
      .map(
        (_, i) =>
          `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`,
      )
      .join("\n  ");

    const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
  ${contentTypeOverrides}
</Types>`;

    const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
</Relationships>`;

    const sldIdLst = slides
      .map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 1}"/>`)
      .join("\n    ");

    const presentation = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
                xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
                xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:sldIdLst>
    ${sldIdLst}
  </p:sldIdLst>
  <p:sldSz cx="12192000" cy="6858000"/>
  <p:notesSz cx="6858000" cy="9144000"/>
</p:presentation>`;

    const presRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  ${slides
    .map(
      (_, i) =>
        `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`,
    )
    .join("\n  ")}
</Relationships>`;

    const entries: ZipEntry[] = [
      { name: "[Content_Types].xml", data: Buffer.from(contentTypes, "utf8") },
      { name: "_rels/.rels", data: Buffer.from(rels, "utf8") },
      { name: "ppt/presentation.xml", data: Buffer.from(presentation, "utf8") },
      { name: "ppt/_rels/presentation.xml.rels", data: Buffer.from(presRels, "utf8") },
    ];
    slides.forEach((slide, i) => {
      entries.push({
        name: `ppt/slides/slide${i + 1}.xml`,
        data: Buffer.from(pptSlideXml(slide, i), "utf8"),
      });
    });

    writeZipFile(filePath, entries);

    return {
      ok: true,
      result: {
        result: `Created PowerPoint presentation: ${filePath}`,
        path: filePath,
        folder: path.dirname(filePath),
        type: "pptx",
        slides: slides.length,
      },
    };
  } catch (e: any) {
    return { ok: false, error: `Failed to create PowerPoint file: ${e?.message || e}` };
  }
}

/** Dispatch office tools from Node (path should already be expanded). */
export function createOfficeFileViaNode(
  tool: string,
  args: Record<string, unknown>,
): { ok: boolean; result?: unknown; error?: string } {
  if (tool === "createWordFile") return createWordFileNode(args);
  if (tool === "createExcelFile") return createExcelFileNode(args);
  if (tool === "createPowerPointFile") return createPowerPointFileNode(args);
  return { ok: false, error: `Not an office tool: ${tool}` };
}

export const OFFICE_TOOLS = new Set(["createWordFile", "createExcelFile", "createPowerPointFile"]);
