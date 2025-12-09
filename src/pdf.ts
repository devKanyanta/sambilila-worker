import { PDFParse } from 'pdf-parse';
// Removed axios as we are using the AWS SDK for R2 download
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
// Note: Depending on your specific worker environment (e.g., Node.js), 
// you may need to explicitly import 'Readable' from 'stream' or 'node:stream'.
import { Readable } from 'stream'; 

/* ---------------- Helper: Convert Stream to Buffer ---------------- */

/**
 * Converts a ReadableStream (from the S3 SDK response) into a Buffer.
 * This is necessary because PDFParse requires a Buffer, but the SDK returns a stream.
 * @param stream The stream containing the object body.
 * @returns A Promise that resolves to a Buffer.
 */
function streamToBuffer(stream: Readable): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

/* ---------------- R2 Client Initialization (for Worker) ---------------- */

if (
    !process.env.R2_BUCKET_NAME ||
    !process.env.R2_ACCESS_KEY_ID ||
    !process.env.R2_SECRET_ACCESS_KEY ||
    !process.env.R2_ENDPOINT_URL
) {
    // We throw an error here to prevent the worker from starting without credentials
    throw new Error("Missing R2 worker credentials in environment variables.");
}

const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME;

const r2ClientWorker = new S3Client({
    region: "auto", // Required by Cloudflare R2
    endpoint: process.env.R2_ENDPOINT_URL,
    credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
});

/* ================================================================
                       extractTextFromPDF (R2 Logic)
   ================================================================ */

/**
 * Extracts text content from a PDF file stored in Cloudflare R2.
 * @param r2FilePath The internal R2 file path (e.g., 'r2://bucket-name/filename.pdf').
 * @returns A promise that resolves to the extracted text content.
 */
export async function extractTextFromPDF(
  r2FilePath: string
): Promise<string> {
  let pdfBuffer: Buffer | undefined;
  let fileKey: string = '';
  
  try {
    // 1. Validate and Parse R2 Key from the fileUrl
    // The regex ensures the format is r2://BUCKET_NAME/FILE_KEY
    const pathParts = r2FilePath.match(/^r2:\/\/[^/]+\/(.+)$/);
    if (!pathParts || pathParts.length < 2) {
        throw new Error(`Invalid R2 file path format. Expected r2://bucket/key, got: ${r2FilePath}`);
    }
    fileKey = pathParts[1]; // Extracts only the file path/key after the bucket name

    console.log(`🔑 Fetching PDF from R2 bucket: ${R2_BUCKET_NAME}, Key: ${fileKey}`);

    // 2. Fetch the object from R2 using authorized S3 SDK
    const getObjectCommand = new GetObjectCommand({
        Bucket: R2_BUCKET_NAME,
        Key: fileKey,
    });

    // This command uses your secure credentials and is immune to IP bans/shared link issues
    const response = await r2ClientWorker.send(getObjectCommand);

    if (!response.Body) {
        throw new Error('R2 response body was empty.');
    }

    // 3. Convert the Stream to a Buffer
    pdfBuffer = await streamToBuffer(response.Body as Readable);
    
    console.log(`✅ Successfully fetched PDF from R2 (${pdfBuffer.length} bytes)`);

    // 4. PDF Parsing
    console.log('🔍 Parsing PDF content...');
    const parser = new PDFParse({ data: pdfBuffer });
    const result = await parser.getText();
    
    if (!result.text || result.text.trim().length === 0) {
      console.warn('⚠️ No text content extracted from PDF');
    }
    
    console.log(`✅ Extracted ${result.text.length} characters from PDF`);
    return result.text;
    
  } catch (err: any) {
    // 5. Error Handling
    console.error('PDF fetch or parse error details:', {
      message: err.message,
      fileKey: fileKey,
      stack: err.stack
    });
    
    // Catch common S3/R2 errors
    if (err.name === 'NoSuchKey') {
      throw new Error(`R2 File not found or deleted: ${fileKey}`);
    }
    
    if (err.name === 'Forbidden') {
      throw new Error('R2 Access Denied. Check worker credentials and bucket permissions.');
    }
    
    throw new Error(`Failed to process PDF from R2: ${err.message}`);
  }
}