import { GoogleGenerativeAI, SchemaType, Schema } from "@google/generative-ai";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);

// 1. Define the schema exactly as shown in the docs, but with TypeScript safety
const flashcardSchema: Schema = {
  description: "A list of flashcards extracted from text",
  type: SchemaType.ARRAY,
  items: {
    type: SchemaType.OBJECT,
    properties: {
      front: {
        type: SchemaType.STRING,
        description: "The question, term, or concept on the front of the card.",
      },
      back: {
        type: SchemaType.STRING,
        description: "The answer, definition, or explanation on the back of the card.",
      },
    },
    required: ["front", "back"],
  },
};

const quizSchema: Schema = {
  type: SchemaType.OBJECT,
  description: "A comprehensive quiz based on provided text",
  properties: {
    title: { type: SchemaType.STRING },
    subject: { type: SchemaType.STRING },
    description: { type: SchemaType.STRING },
    questions: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          type: { 
            type: SchemaType.STRING, 
            description: "The type of question",
            enum: ["MULTIPLE_CHOICE", "TRUE_FALSE", "SHORT_ANSWER"] 
          } as Schema, 
          question: { type: SchemaType.STRING },
          options: { 
            type: SchemaType.ARRAY, 
            items: { type: SchemaType.STRING }
          },
          correctAnswer: { type: SchemaType.STRING },
        },
        required: ["type", "question", "correctAnswer"],
      },
    },
  },
  required: ["title", "subject", "description", "questions"],
};

export async function generateFlashcardsFromText(text: string) {
  // 2. Initialize the model with the schema in generationConfig
  // Note: Using 'gemini-1.5-flash' or 'gemini-2.0-flash' as per official docs
  const model = genAI.getGenerativeModel({
    model: "gemini-2.5-flash",
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: flashcardSchema,
    },
  });

  const prompt = `
    Extract flashcards from the following text. 
    Focus on key concepts and instructional material.
    Ignore metadata like page numbers or headers.

    TEXT:
    ${text}
  `;

  try {
    const result = await model.generateContent(prompt);
    const response = result.response;
    const jsonText = response.text();

    // 3. With responseSchema, the AI is guaranteed to return valid, escaped JSON.
    // No regex or backtick stripping is needed.
    return JSON.parse(jsonText);
  } catch (error) {
    console.error("Failed to generate or parse flashcards:", error);
    throw error;
  }
}

export async function generateQuizFromText(text: string, numberOfQuestions: number, difficulty: string, questionTypes: string) {
  
  const model = genAI.getGenerativeModel({
    model: "gemini-2.5-flash",
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: quizSchema,
    },
  });

  const prompt = `
      Create a quiz based on this text.
      Requirements:
      - Questions: ${numberOfQuestions}
      - Difficulty: ${difficulty}
      - Types: ${questionTypes}
      
      TEXT:
      ${text}
    `;

  try {
    const result = await model.generateContent(prompt);
    const response = result.response;
    const jsonText = response.text();

    // 3. With responseSchema, the AI is guaranteed to return valid, escaped JSON.
    // No regex or backtick stripping is needed.
    return JSON.parse(jsonText);
  } catch (error) {
    console.error("Failed to generate or parse flashcards:", error);
    throw error;
  }
}