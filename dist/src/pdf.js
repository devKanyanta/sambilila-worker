import { PDFParse } from 'pdf-parse';
import axios from 'axios';
export async function extractTextFromPDF(input) {
    try {
        let pdfBuffer; // Explicitly define as undefined
        if (typeof input === 'string' && (input.startsWith('http://') || input.startsWith('https://'))) {
            console.log(`📥 Fetching PDF from URL: ${input}`);
            let urlsToTry = [input];
            // --- 🔑 Dropbox URL Logic Enhancement ---
            if (input.includes('dropbox.com')) {
                const baseUrl = input.split('?')[0]; // Remove all original query parameters
                urlsToTry = [
                    input, // 1. Original URL (to capture any default redirect)
                    `${baseUrl}?raw=1`, // 2. Base URL + raw parameter
                ];
                // The most reliable format for public content: replacing domain + adding ?raw=1
                const directContentUrl = baseUrl.replace('www.dropbox.com', 'dl.dropboxusercontent.com') + '?raw=1';
                urlsToTry.push(directContentUrl); // 3. Direct Content URL
            }
            let lastError = null;
            for (const url of urlsToTry) {
                console.log(`🔄 Trying URL: ${url}`);
                try {
                    const response = await axios.get(url, {
                        responseType: 'arraybuffer',
                        timeout: 60000,
                        headers: {
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                            'Accept': 'application/pdf, application/octet-stream, */*',
                            'Accept-Language': 'en-US,en;q=0.9',
                        },
                        maxRedirects: 5,
                        // ⭐️ CRUCIAL FIX: Allow 3xx redirect status codes (301, 302)
                        // Axios will automatically follow these redirects up to maxRedirects
                        validateStatus: (status) => status >= 200 && status < 400, // Accept 2xx (Success) and 3xx (Redirect)
                    });
                    pdfBuffer = Buffer.from(response.data);
                    console.log(`✅ Successfully fetched from URL: ${url} (${pdfBuffer.length} bytes)`);
                    // Check if it's a PDF
                    if (pdfBuffer.length > 4) {
                        const header = pdfBuffer.toString('utf8', 0, 10);
                        if (header.includes('%PDF')) {
                            console.log(`✅ Valid PDF header detected`);
                            break; // Success!
                        }
                        else {
                            // This is what caught the HTML wrapper (<!DOCTYPE)
                            console.warn(`⚠️ Not a valid PDF (header: ${header.substring(0, 10)})`);
                            throw new Error('Not a valid PDF file content received. Got HTML or non-PDF data.');
                        }
                    }
                }
                catch (error) {
                    lastError = error;
                    console.log(`❌ URL failed: ${url} - ${error.message}`);
                    continue;
                }
            }
            if (!pdfBuffer) {
                throw lastError || new Error('All URL attempts failed to fetch a valid PDF');
            }
        }
        else if (Buffer.isBuffer(input)) {
            // ... (Buffer handling) ...
            pdfBuffer = input;
            console.log(`📄 Processing PDF buffer (${pdfBuffer.length} bytes)`);
        }
        else {
            throw new Error('Unsupported input type');
        }
        // ... (PDF parsing logic) ...
        console.log('🔍 Parsing PDF content...');
        // Ensure pdfBuffer is non-null before passing to PDFParse
        const parser = new PDFParse({ data: pdfBuffer });
        const result = await parser.getText();
        if (!result.text || result.text.trim().length === 0) {
            console.warn('⚠️ No text content extracted from PDF');
            // Try alternative parsing method (if needed)
        }
        console.log(`✅ Extracted ${result.text.length} characters from PDF`);
        return result.text;
    }
    catch (err) {
        // ... (Error handling logic) ...
        console.error('PDF parse error details:', {
            message: err.message,
            url: typeof input === 'string' ? input : undefined,
            stack: err.stack
        });
        if (err.message.includes('timeout') || err.code === 'ECONNABORTED') {
            throw new Error('PDF download timeout (60 seconds)');
        }
        if (err.message.includes('ENOTFOUND') || err.code === 'ENOTFOUND') {
            throw new Error('Cannot resolve the URL. Please check the PDF URL is valid.');
        }
        if (err.response?.status === 403 || err.response?.status === 404) {
            throw new Error(`PDF not accessible (HTTP ${err.response.status}). The file may be private or deleted.`);
        }
        if (err.message.includes('Not a valid PDF')) {
            throw new Error('The downloaded file is not a valid PDF.');
        }
        throw new Error(`Failed to process PDF: ${err.message}`);
    }
}
