import { createRequire } from "module";

const require = createRequire(import.meta.url);
const pdfParse = require("pdf-parse");

export async function extractTextFromPDF(buffer: Uint8Array): Promise<string> {
  const data = await pdfParse(Buffer.from(buffer));
  return data.text.trim();
}
