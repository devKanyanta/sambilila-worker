import PDFParser from 'pdf2json';

export async function extractTextFromPDF(buffer: Uint8Array): Promise<string> {
  return new Promise((resolve, reject) => {
    const pdfParser = new (PDFParser as any)(null, 1);

    pdfParser.on('pdfParser_dataError', (errData: any) => {
      console.error('PDF parse error:', errData);
      reject(new Error('Failed to parse PDF'));
    });

    pdfParser.on('pdfParser_dataReady', (pdfData: any) => {
      try {
        let text = '';
        
        // Extract text from each page
        if (pdfData.Pages) {
          for (const page of pdfData.Pages) {
            if (page.Texts) {
              for (const textItem of page.Texts) {
                if (textItem.R) {
                  for (const run of textItem.R) {
                    if (run.T) {
                      try {
                        // Try to decode URI encoded text
                        text += decodeURIComponent(run.T) + ' ';
                      } catch (e) {
                        // If decoding fails, use the raw text
                        text += run.T + ' ';
                      }
                    }
                  }
                }
              }
            }
            text += '\n';
          }
        }
        
        const cleanText = text.trim();
        if (!cleanText) {
          reject(new Error('No text could be extracted from PDF'));
        } else {
          resolve(cleanText);
        }
      } catch (error) {
        console.error('Text extraction error:', error);
        reject(error);
      }
    });

    pdfParser.parseBuffer(Buffer.from(buffer));
  });
}