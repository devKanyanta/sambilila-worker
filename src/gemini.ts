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
    // Sanitize the JSON string by escaping control characters
    // This handles cases where Gemini includes literal control characters
    raw = raw.replace(/[\x00-\x1F\x7F]/g, (char) => {
      const escapeMap: Record<string, string> = {
        '\b': '\\b',
        '\f': '\\f',
        '\n': '\\n',
        '\r': '\\r',
        '\t': '\\t'
      };
      return escapeMap[char] || `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`;
    });

    return JSON.parse(raw);
  } catch (error) {
    console.error("Failed to parse JSON:", raw);
    throw new Error(`Invalid JSON ${raw} from Gemini: ${error instanceof Error ? error.message : String(error)}`);
  }
}
