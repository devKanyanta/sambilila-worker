import { GoogleGenerativeAI } from "@google/generative-ai";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);

export async function generateFlashcardsFromText(text: string) {
  const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

  const prompt = `
You are an API that outputs ONLY raw JSON.

TASK:
Convert the following text into flashcards.

RULES:
- Output valid JSON ONLY
- No markdown, no code blocks, no comments, no explanations
- No backticks or formatting
- Must be exactly an array
- **IGNORE all metadata, including authors, dates, page numbers, headers, and footers. Focus ONLY on the instructional course material.**

FORMAT:
[
  {
    "front": "question",
    "back": "answer"
  }
]

TEXT:

${text}
`;

  const result = await model.generateContent(prompt);
  const raw = result.response.text();

  return JSON.parse(raw.replace(/```json|```/g, "").trim());
}
