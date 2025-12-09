import "dotenv/config";
import { prisma } from "./src/db.js";
import { extractTextFromPDF } from "./src/pdf.js";
import { generateFlashcardsFromText } from "./src/gemini.js";

// Define a constant for the maximum number of jobs to process concurrently.
// This is the primary lever for controlling database connection load.
const CONCURRENCY_LIMIT = 3; 

// Helper function to validate URLs
function isValidUrl(string: string) {
  try {
    const url = new URL(string);
    // FIX 1: Allow 'r2:' protocol in addition to 'http:' and 'https:'
    return url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'r2:'; 
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
      
      // Check if it's a connection error (Prisma P2037 or pool limit message)
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
      // FIX 2: Validate URL, now including r2://
      if (!isValidUrl(job.fileUrl)) {
        throw new Error(`Invalid file URL: ${job.fileUrl}. Must be http, https, or r2 protocol.`);
      }
      
      try {
        console.log(`📄 Extracting PDF from path: ${job.fileUrl}...`);

        // FIX 3: Directly call the updated extractTextFromPDF, which now handles R2 download
        textContent = await extractTextFromPDF(job.fileUrl);

        console.log(`📄 Extracted ${textContent.length} characters from PDF`);
        
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
    console.log(`🤖 Generating flashcards with AI for job ${job.id}...`);
    const cards = await generateFlashcardsFromText(textContent);
    console.log(`✅ Generated ${cards.length} flashcards for job ${job.id}`);

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

/**
 * Executes a list of promise-returning functions with a concurrency limit.
 * This is the mechanism that controls parallel processing.
 * @param tasks An array of functions that return promises (e.g., () => processJob(job)).
 * @param limit The maximum number of promises to run at the same time.
 */
async function runInBatches<T>(tasks: (() => Promise<T>)[], limit: number) {
  const active: Promise<T>[] = [];
  let index = 0;

  // Function to process the next task
  const runNext = async () => {
    if (index >= tasks.length) {
      return;
    }

    const task = tasks[index++];
    const promise = task();
    
    // Add the promise to the active list
    active.push(promise);
    
    // Wait for the current promise to settle
    try {
        await promise;
    } catch (e) {
        // Error already logged in processJob, safely continue.
    }
    
    // Remove the settled promise from the active list
    active.splice(active.indexOf(promise), 1);
    
    // Recursively check if there's more work to do
    return runNext();
  };

  // Start the initial batch of promises up to the limit
  const initialBatch = [];
  for (let i = 0; i < limit && i < tasks.length; i++) {
    initialBatch.push(runNext());
  }

  // Wait for the entire initial batch (and all subsequent tasks they trigger) to complete
  await Promise.all(initialBatch);
}


async function pollJobs() {
  if (shutdownRequested) {
    return;
  }
  
  console.log('🔍 Polling for new jobs...')
  
  try {
    // Fetch a batch larger than CONCURRENCY_LIMIT to keep the worker busy.
    const BATCH_SIZE = CONCURRENCY_LIMIT * 2; 

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
        LIMIT ${BATCH_SIZE}
      `,
      3,
      'find pending jobs'
    );

    if (pendingJobs.length === 0) {
      return;
    }

    console.log(`📋 Found ${pendingJobs.length} pending jobs. Processing ${Math.min(pendingJobs.length, CONCURRENCY_LIMIT)} in parallel.`);
    
    // Create a list of functions that return a promise (thunks)
    const jobPromises = pendingJobs.map(job => () => processJob(job));
    
    // Run the job processing with the set concurrency limit
    await runInBatches(jobPromises, CONCURRENCY_LIMIT);
    
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