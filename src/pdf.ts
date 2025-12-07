import {PDFParse} from 'pdf-parse';

export async function extractTextFromPDF(buffer: Uint8Array): Promise<string> {
  try {
    const parser = new PDFParse({ url: 'https://bitcoin.org/bitcoin.pdf' });

	const result = await parser.getText();
  return result.text;
  } catch (err) {
    console.error('PDF parse error:', err);
    throw new Error('Failed to parse PDF');
  }
}
