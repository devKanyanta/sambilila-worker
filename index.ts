// /workers/index.js (updated)
import "dotenv/config";
import { prisma } from "./src/db.js";
import { extractTextFromPDF } from "./src/pdf.js";
import { generateFlashcardsFromText, generateQuizFromText } from "./src/gemini.js";

// Define constants for concurrency limits
const FLASHCARD_CONCURRENCY_LIMIT = 3;
const QUIZ_CONCURRENCY_LIMIT = 3;

// Helper function to validate URLs
function isValidUrl(string: string) {
  try {
    const url = new URL(string);
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

async function processFlashcardJob(job: any) {
  console.log(`🔄 Processing flashcard job ${job.id}: ${job.title} : ${job.fileUrl}`)
  
  try {
    // Update job status to PROCESSING with retry
    await executeWithRetry(
      () => prisma.$executeRaw`
        UPDATE flashcard_jobs 
        SET status = 'PROCESSING' 
        WHERE id = ${job.id}
      `,
      3,
      'update flashcard job status'
    );

    let textContent = ''

    // Process based on input type
    if (job.fileUrl) {
      if (!isValidUrl(job.fileUrl)) {
        throw new Error(`Invalid file URL: ${job.fileUrl}. Must be http, https, or r2 protocol.`);
      }
      
      try {
        console.log(`📄 Extracting PDF from path: ${job.fileUrl}...`);
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
      'update flashcard job as done'
    );

    console.log(`✅ Processed flashcard job ${job.id}, created set: ${flashcardSet.id}`)
    
  } catch (error: any) {
    console.error(`❌ Failed flashcard job ${job.id}:`, error)
    
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
        'update flashcard job as failed'
      );
    } catch (updateError) {
      console.error(`Failed to update flashcard job ${job.id} as FAILED:`, updateError);
    }
  }
}

async function processQuizJob(job: any) {
  console.log(`🔄 Processing quiz job ${job.id}: ${job.title} : ${job.fileUrl}`)
  
  try {
    // Update job status to PROCESSING with retry
    await executeWithRetry(
      () => prisma.$executeRaw`
        UPDATE quiz_job 
        SET status = 'PROCESSING' 
        WHERE id = ${job.id}
      `,
      3,
      'update quiz job status'
    );

    let textContent = ''

    // Process based on input type
    if (job.fileUrl) {
      if (!isValidUrl(job.fileUrl)) {
        throw new Error(`Invalid file URL: ${job.fileUrl}. Must be http, https, or r2 protocol.`);
      }
      
      try {
        console.log(`📄 Extracting PDF from path: ${job.fileUrl}...`);
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
      throw new Error('Content too short to generate quiz (minimum 50 characters)');
    }

    // Parse quiz parameters
    const numberOfQuestions = parseInt(job.numberOfQuestions) || 10;
    const difficulty = job.difficulty || 'medium';
    const questionTypes = job.questionTypes ? job.questionTypes.split(',') : ['multiple_choice'];

    // Generate quiz using AI
    console.log(`🤖 Generating quiz with AI for job ${job.id}...`);
    console.log(`📊 Parameters: ${numberOfQuestions} questions, ${difficulty} difficulty, types: ${questionTypes.join(', ')}`);
    
    const quizData = await generateQuizFromText(
      textContent, 
      numberOfQuestions, 
      difficulty, 
      questionTypes
    );
    
    console.log(`✅ Generated ${quizData.questions.length} quiz questions for job ${job.id}`);

    // Save quiz with retry
    const quiz = await executeWithRetry(
      () => prisma.quiz.create({
        data: {
          userId: job.userId,
          title: job.title,
          subject: job.subject || 'General',
          description: `Generated quiz with ${quizData.questions.length} questions (${difficulty} difficulty)`,
          questions: {
            create: quizData.questions.map((question: any, index: number) => ({
              type: question.type.toUpperCase().replace(' ', '_'),
              question: question.question,
              options: question.options || [],
              correctAnswer: typeof question.correctAnswer === 'string' 
                ? question.correctAnswer 
                : JSON.stringify(question.correctAnswer),
              order: index
            }))
          }
        },
        include: { questions: true }
      }),
      3,
      'create quiz'
    );

    // Update job with result using raw SQL with retry
    await executeWithRetry(
      () => prisma.$executeRaw`
        UPDATE quiz_job 
        SET 
          status = 'DONE',
          "quizId" = ${quiz.id}
        WHERE id = ${job.id}
      `,
      3,
      'update quiz job as done'
    );

    console.log(`✅ Processed quiz job ${job.id}, created quiz: ${quiz.id}`)
    
  } catch (error: any) {
    console.error(`❌ Failed quiz job ${job.id}:`, error)
    
    try {
      // Update job as FAILED with retry
      await executeWithRetry(
        () => prisma.$executeRaw`
          UPDATE quiz_job 
          SET 
            status = 'FAILED',
            error = ${error.message || 'Unknown error'}
          WHERE id = ${job.id}
        `,
        3,
        'update quiz job as failed'
      );
    } catch (updateError) {
      console.error(`Failed to update quiz job ${job.id} as FAILED:`, updateError);
    }
  }
}

/**
 * Executes a list of promise-returning functions with a concurrency limit.
 * @param tasks An array of functions that return promises.
 * @param limit The maximum number of promises to run at the same time.
 */
async function runInBatches<T>(tasks: (() => Promise<T>)[], limit: number) {
  const active: Promise<T>[] = [];
  let index = 0;

  const runNext = async () => {
    if (index >= tasks.length) {
      return;
    }

    const task = tasks[index++];
    const promise = task();
    
    active.push(promise);
    
    try {
        await promise;
    } catch (e) {
        // Error already logged in processJob, safely continue.
    }
    
    active.splice(active.indexOf(promise), 1);
    return runNext();
  };

  const initialBatch = [];
  for (let i = 0; i < limit && i < tasks.length; i++) {
    initialBatch.push(runNext());
  }

  await Promise.all(initialBatch);
}

async function pollFlashcardJobs() {
  try {
    const BATCH_SIZE = FLASHCARD_CONCURRENCY_LIMIT * 2;

    // Find pending flashcard jobs with retry
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
      'find pending flashcard jobs'
    );

    if (pendingJobs.length === 0) {
      return false;
    }

    console.log(`📋 Found ${pendingJobs.length} pending flashcard jobs. Processing ${Math.min(pendingJobs.length, FLASHCARD_CONCURRENCY_LIMIT)} in parallel.`);
    
    const jobPromises = pendingJobs.map(job => () => processFlashcardJob(job));
    await runInBatches(jobPromises, FLASHCARD_CONCURRENCY_LIMIT);
    
    return pendingJobs.length > 0;
  } catch (error) {
    console.error('Flashcard polling error:', error);
    return false;
  }
}

async function pollQuizJobs() {
  try {
    const BATCH_SIZE = QUIZ_CONCURRENCY_LIMIT * 2;

    // Find pending quiz jobs with retry
    const pendingJobs = await executeWithRetry(
      () => prisma.$queryRaw<any[]>`
        SELECT 
          id,
          "userId",
          "fileUrl",
          "text",
          title,
          "numberOfQuestions",
          difficulty,
          "questionTypes",
          status
        FROM quiz_job 
        WHERE status = 'PENDING' 
        ORDER BY "createdAt" ASC 
        LIMIT ${BATCH_SIZE}
      `,
      3,
      'find pending quiz jobs'
    );

    if (pendingJobs.length === 0) {
      return false;
    }

    console.log(`📋 Found ${pendingJobs.length} pending quiz jobs. Processing ${Math.min(pendingJobs.length, QUIZ_CONCURRENCY_LIMIT)} in parallel.`);
    
    const jobPromises = pendingJobs.map(job => () => processQuizJob(job));
    await runInBatches(jobPromises, QUIZ_CONCURRENCY_LIMIT);
    
    return pendingJobs.length > 0;
  } catch (error) {
    console.error('Quiz polling error:', error);
    return false;
  }
}

async function pollJobs() {
  if (shutdownRequested) {
    return;
  }
  
  console.log('🔍 Polling for new jobs...')
  
  let hadWork = false;
  
  // Poll both types of jobs
  const flashcardResult = await pollFlashcardJobs();
  const quizResult = await pollQuizJobs();
  
  hadWork = flashcardResult || quizResult;
  
  if (!hadWork) {
    console.log('😴 No pending jobs found, waiting for next poll...');
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
  console.log('🚀 AI Worker Started - Processing both flashcards and quizzes')
  
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