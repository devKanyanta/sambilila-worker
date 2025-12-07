import { GoogleGenerativeAI } from "@google/generative-ai";
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
export async function generateFlashcardsFromText(text) {
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
    const prompt = `
Create flashcards from this study content:

${text.slice(0, 12000)}

Return valid JSON only:

[
  {
    "front": "question",
    "back": "answer"
  }
]
`;
    const result = await model.generateContent(prompt);
    const raw = result.response.text();
    return JSON.parse(raw.replace(/```json|```/g, "").trim());
}
