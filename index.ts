import "dotenv/config";
import { prisma } from "./src/db.js";
import { downloadFromDropbox } from "./src/dropbox.js";
import { extractTextFromPDF } from "./src/pdf.js";
import { generateFlashcardsFromText } from "./src/gemini.js";
import { Dropbox } from "dropbox";

// Initialize Dropbox client (similar to your Next.js app)
let dbx: Dropbox | null = null
let accessToken = process.env.DROPBOX_ACCESS_TOKEN || ''

if (accessToken) {
  dbx = new Dropbox({ accessToken, fetch })
}

async function processJob(job: any) {
  try {
    // Update job status to PROCESSING
    await prisma.flashcardJob.update({
      where: { id: job.id },
      data: { status: 'PROCESSING' }
    })

    let textContent = ''

    // Process based on input type
    if (job.fileUrl) {
      // Download PDF from Dropbox
      const response = await fetch(job.fileUrl)
      const arrayBuffer = await response.arrayBuffer()
      textContent = await extractTextFromPDF(new Uint8Array(arrayBuffer))
    } else if (job.text) {
      textContent = job.text
    }

    if (!textContent || textContent.length < 50) {
      throw new Error('Content too short to generate flashcards')
    }

    // Generate flashcards using AI
    const cards = await generateFlashcardsFromText(textContent)

    // Save flashcard set
    const flashcardSet = await prisma.flashcardSet.create({
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
    })

    // Update job with result
    await prisma.flashcardJob.update({
      where: { id: job.id },
      data: {
        status: 'DONE',
        flashcardSetId: flashcardSet.id
      }
    })

    console.log(`✅ Processed job ${job.id}`)
    
  } catch (error: any) {
    console.error(`❌ Failed job ${job.id}:`, error)
    
    await prisma.flashcardJob.update({
      where: { id: job.id },
      data: {
        status: 'FAILED',
        error: error.message
      }
    })
  }
}

// In your worker, add this debug code:
async function pollJobs() {
  console.log('🔍 Polling for new jobs...')
  
  try {
    // First, let's check what tables exist
    const tables = await prisma.$queryRaw`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public'
    `
    console.log('📊 Available tables:', tables)
    
    // Check specifically for flashcard_jobs
    const flashcardJobsExists = await prisma.$queryRaw`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'flashcard_jobs'
      )
    `
    console.log('✅ flashcard_jobs exists:', flashcardJobsExists)
    
    // Now try to find jobs
    const pendingJobs = await prisma.flashcardJob.findMany({
      where: { status: 'PENDING' },
      orderBy: { createdAt: 'asc' },
      take: 3
    })
    
    console.log(`📋 Found ${pendingJobs.length} pending jobs`)
    
    // Process jobs...
  } catch (error) {
    console.error('Full error details:',error)
  }
}

// Run worker
async function main() {
  console.log('🚀 Flashcard Worker Started')
  
  // Poll every 10 seconds
  setInterval(pollJobs, 10000)
  
  // Also poll immediately on start
  await pollJobs()
}

main().catch(console.error)