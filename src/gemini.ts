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
  let raw = result.response.text();

  // Remove markdown code blocks
  raw = raw.replace(/```json\n?|```\n?/g, "").trim();

  // Extract JSON array if it's wrapped in other text
  const jsonMatch = raw.match(/\[[\s\S]*\]/);
  if (jsonMatch) {
    raw = jsonMatch[0];
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    console.error("Failed to parse JSON:", raw.substring(0, 500));
    throw new Error(`Invalid JSON from Gemini: ${error instanceof Error ? error.message : String(error)}`);
  }
}
