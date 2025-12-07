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

async function pollJobs() {
  console.log('🔍 Polling for new jobs...')
  
  try {
    // Find pending jobs (oldest first)
    const pendingJobs = await prisma.flashcardJob.findMany({
      where: { status: 'PENDING' },
      orderBy: { createdAt: 'asc' },
      take: 5 // Process in batches
    })

    // Process jobs in parallel
    await Promise.all(pendingJobs.map(processJob))
    
  } catch (error) {
    console.error('Polling error:', error)
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