import "dotenv/config";
import { prisma } from "./src/db.js";
import { extractTextFromPDF } from "./src/pdf.js";
import { generateFlashcardsFromText } from "./src/gemini.js";

// Helper function to validate URLs
function isValidUrl(string: string) {
  try {
    const url = new URL(string);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch (_) {
    return false;
  }
}

// Helper function to execute query with retry logic
async function executeWithRetry<T>(
  queryFn: () => Promise<T>,
  maxRetries = 3,
  operationName = 'database operation'
): Promise<T> {
  let lastError: Error;
  
  for (let i = 0; i < maxRetries; i++) {
    try {
      const result = await queryFn();
      return result;
    } catch (error: any) {
      lastError = error;
      
      // Check if it's a connection error
      if (error.code === 'P2037' || error.message?.includes('too many connections')) {
        console.warn(`Connection error in ${operationName} (attempt ${i + 1}/${maxRetries}), waiting to retry...`);
        await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1))); // Exponential backoff
        continue;
      }
      
      // Other errors, don't retry
      throw error;
    }
  }
  
  throw lastError!;
}

async function processJob(job: any) {
  console.log(`🔄 Processing job ${job.id}: ${job.title} : ${job.fileUrl}`)
  
  try {
    // Update job status to PROCESSING with retry
    await executeWithRetry(
      () => prisma.$executeRaw`
        UPDATE flashcard_jobs 
        SET status = 'PROCESSING' 
        WHERE id = ${job.id}
      `,
      3,
      'update job status'
    );

    let textContent = ''

    // Process based on input type
    if (job.fileUrl) {
      // Validate URL
      if (!isValidUrl(job.fileUrl)) {
        throw new Error(`Invalid file URL: ${job.fileUrl}`)
      }
      
      try {
        if (job.fileUrl) {
          // Validate URL
          if (!isValidUrl(job.fileUrl)) {
            throw new Error(`Invalid file URL: ${job.fileUrl}`);
          }

          console.log(`📄 Extracting PDF directly from URL: ${job.fileUrl}...`);

          // ✅ Pass the URL directly to extractTextFromPDF (no download)
          textContent = await extractTextFromPDF(job.fileUrl);

          console.log(`📄 Extracted ${textContent.length} characters from PDF`);
        }
        
      } catch (fetchError: any) {
        if (fetchError.name === 'AbortError') {
          throw new Error('File download timeout (30 seconds)');
        }
        throw fetchError;
      }
      
    } else if (job.text) {
      textContent = job.text;
      console.log(`📝 Processing text input (${textContent.length} chars)`);
    }

    if (!textContent || textContent.length < 50) {
      throw new Error('Content too short to generate flashcards (minimum 50 characters)');
    }

    // Generate flashcards using AI
    console.log(`🤖 Generating flashcards with AI...`);
    const cards = await generateFlashcardsFromText(textContent);
    console.log(`✅ Generated ${cards.length} flashcards`);

    // Save flashcard set with retry
    const flashcardSet = await executeWithRetry(
      () => prisma.flashcardSet.create({
        data: {
          userId: job.userId,
          title: job.title,
          subject: job.subject,
          description: job.description,
          cards: {
            create: cards.map((card: any, index: number) => ({
              front: card.front,
              back: card.back,
              order: index
            }))
          }
        },
        include: { cards: true }
      }),
      3,
      'create flashcard set'
    );

    // Update job with result using raw SQL with retry
    await executeWithRetry(
      () => prisma.$executeRaw`
        UPDATE flashcard_jobs 
        SET 
          status = 'DONE',
          "flashcardSetId" = ${flashcardSet.id}
        WHERE id = ${job.id}
      `,
      3,
      'update job as done'
    );

    console.log(`✅ Processed job ${job.id}, created set: ${flashcardSet.id}`)
    
  } catch (error: any) {
    console.error(`❌ Failed job ${job.id}:`, error)
    
    try {
      // Update job as FAILED with retry
      await executeWithRetry(
        () => prisma.$executeRaw`
          UPDATE flashcard_jobs 
          SET 
            status = 'FAILED',
            error = ${error.message || 'Unknown error'}
          WHERE id = ${job.id}
        `,
        3,
        'update job as failed'
      );
    } catch (updateError) {
      console.error(`Failed to update job ${job.id} as FAILED:`, updateError);
    }
  }
}

async function pollJobs() {
  console.log('🔍 Polling for new jobs...')
  
  try {
    // Find pending jobs with retry
    const pendingJobs = await executeWithRetry(
      () => prisma.$queryRaw<any[]>`
        SELECT 
          id,
          "userId",
          "fileUrl",
          "text",
          title,
          subject,
          description,
          status
        FROM flashcard_jobs 
        WHERE status = 'PENDING' 
        ORDER BY "createdAt" ASC 
        LIMIT 2  -- Process only 2 at once for Clever Cloud
      `,
      3,
      'find pending jobs'
    );

    if (pendingJobs.length === 0) {
      return;
    }

    console.log(`📋 Found ${pendingJobs.length} pending jobs`)
    
    // Process jobs sequentially (not parallel) to reduce connection load
    for (const job of pendingJobs) {
      await processJob(job);
      
      // Small delay between jobs to reduce connection pressure
      if (pendingJobs.length > 1) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    
  } catch (error) {
    console.error('Polling error:', error)
  }
}

// Track active polls to prevent overlapping
let isPolling = false;
let shutdownRequested = false;

async function safePollJobs() {
  if (isPolling || shutdownRequested) {
    return;
  }
  
  isPolling = true;
  try {
    await pollJobs();
  } catch (error) {
    console.error('Safe poll error:', error);
  } finally {
    isPolling = false;
  }
}

// Run worker
async function main() {
  console.log('🚀 Flashcard Worker Started')
  
  // Test database connection with retry
  try {
    await executeWithRetry(
      () => prisma.$queryRaw`SELECT 1`,
      3,
      'database connection test'
    );
    console.log('✅ Database connection successful');
  } catch (error) {
    console.error('❌ Database connection failed after retries:', error);
    process.exit(1);
  }
  
  // Increase polling interval to reduce database load
  const POLL_INTERVAL = 20000; // 20 seconds
  
  const pollInterval = setInterval(safePollJobs, POLL_INTERVAL);
  
  // Initial poll
  await safePollJobs();
  
  // Graceful shutdown handler
  const shutdown = async () => {
    if (shutdownRequested) return;
    
    shutdownRequested = true;
    clearInterval(pollInterval);
    
    console.log('🛑 Shutting down gracefully...');
    
    // Wait for current poll to finish
    while (isPolling) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    // Disconnect from database
    try {
      await prisma.$disconnect();
      console.log('✅ Disconnected from database');
    } catch (error) {
      console.error('Error disconnecting from database:', error);
    }
    
    process.exit(0);
  };
  
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  
  // Handle uncaught errors
  process.on('uncaughtException', (error) => {
    console.error('Uncaught exception:', error);
    shutdown();
  });
  
  process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled rejection at:', promise, 'reason:', reason);
    shutdown();
  });
}

main().catch(async (error) => {
  console.error('Worker failed to start:', error);
  
  try {
    await prisma.$disconnect();
  } catch (disconnectError) {
    console.error('Error during shutdown disconnect:', disconnectError);
  }
  
  process.exit(1);
});