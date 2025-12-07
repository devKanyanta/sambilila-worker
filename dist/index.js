import "dotenv/config";
import { prisma } from "./src/db.js";
import { downloadFromDropbox } from "./src/dropbox.js";
import { extractTextFromPDF } from "./src/pdf.js";
import { generateFlashcardsFromText } from "./src/gemini.js";
async function runWorker() {
    console.log("🚀 Worker started");
    while (true) {
        const job = await prisma.flashcardJob.findFirst({
            where: { status: "PENDING" },
        });
        if (!job) {
            await new Promise((r) => setTimeout(r, 5000));
            continue;
        }
        console.log("⚙ Processing job:", job.id);
        try {
            // ✅ SAFELY normalize nullable fields
            let text = job.text ?? "";
            if (job.fileUrl) {
                const pdfBuffer = await downloadFromDropbox(job.fileUrl); // ✅ guaranteed string now
                text = await extractTextFromPDF(pdfBuffer); // ✅ expects string
            }
            if (!text || text.length < 100) {
                throw new Error("Not enough text to generate flashcards");
            }
            const cards = await generateFlashcardsFromText(text); // ✅ now always string
            const set = await prisma.flashcardSet.create({
                data: {
                    title: job.title || 'AI Generated Flashcards',
                    subject: job.subject || 'General',
                    description: job.description ?? "",
                    userId: job.userId,
                    cards: {
                        create: cards.map((c, i) => ({
                            front: String(c.front),
                            back: String(c.back),
                            order: i + 1,
                        })),
                    },
                },
            });
            await prisma.flashcardJob.update({
                where: { id: job.id },
                data: {
                    status: "DONE",
                    flashcardSetId: set.id,
                    error: null,
                },
            });
            console.log("✅ Completed job:", job.id);
        }
        catch (err) {
            console.error("❌ Job failed:", err);
            await prisma.flashcardJob.update({
                where: { id: job.id },
                data: {
                    status: "FAILED",
                    error: err?.message || String(err),
                },
            });
        }
    }
}
runWorker();
