import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.API_KEY || 'dummy_key' });

const MOCK_IDEAS = [
  "Draw a cat jumping over a puddle!",
  "Draw a flower blooming in fast motion.",
  "Draw a robot doing a silly dance.",
  "Draw a rocket blasting off into space!",
  "Draw a fish swimming in a bowl."
];

const MOCK_FEEDBACK = [
  "That looks amazing! Keep up the great work!",
  "Wow, I love the colors you used!",
  "You are a fantastic artist!",
  "This is so creative! I love it.",
  "Great job! What happens next in the animation?"
];

export const generateAnimationIdea = async (): Promise<string> => {
  try {
    if (!process.env.API_KEY) throw new Error("No API Key");
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: "Give me a single, short, fun, and creative animation idea for a child to draw. Keep it under 15 words. Examples: 'A cat jumping over the moon', 'A flower blooming quickly', 'A robot doing a dance'.",
    });
    return response.text || "Draw a bouncing ball!";
  } catch (error) {
    console.log("Using mock idea due to error/missing key");
    return MOCK_IDEAS[Math.floor(Math.random() * MOCK_IDEAS.length)];
  }
};

export const tellStoryAboutFrame = async (imageDataUrl: string): Promise<string> => {
  try {
    if (!process.env.API_KEY) throw new Error("No API Key");
    // Remove the data URL prefix to get just base64
    const base64Data = imageDataUrl.split(',')[1];

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: {
        parts: [
          {
            inlineData: {
              mimeType: 'image/png',
              data: base64Data
            }
          },
          {
            text: "Look at this drawing a child made. Write a very short (1 sentence), encouraging, and funny comment about what is happening in the picture. Talk directly to the child."
          }
        ]
      }
    });
    return response.text || "That looks amazing! Great job!";
  } catch (error) {
    console.log("Using mock feedback due to error/missing key");
    return MOCK_FEEDBACK[Math.floor(Math.random() * MOCK_FEEDBACK.length)];
  }
};

export const editFrameWithAI = async (imageDataUrl: string, prompt: string): Promise<string> => {
  try {
    if (!process.env.API_KEY) throw new Error("No API Key");
    const base64Data = imageDataUrl.split(',')[1];

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash-image',
      contents: {
        parts: [
          {
            inlineData: {
              mimeType: 'image/png',
              data: base64Data
            }
          },
          {
            text: prompt
          }
        ]
      }
    });

    // Check for image in response
    if (response.candidates && response.candidates[0].content.parts) {
      for (const part of response.candidates[0].content.parts) {
        if (part.inlineData) {
          return `data:image/png;base64,${part.inlineData.data}`;
        }
      }
    }

    throw new Error("No image generated");
  } catch (error) {
    console.log("Using mock edit (grayscale filter) due to error/missing key");
    // Fallback: Simple client-side filter simulation (grayscale)
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.filter = 'grayscale(100%)';
          ctx.drawImage(img, 0, 0);
          resolve(canvas.toDataURL());
        } else {
          resolve(imageDataUrl);
        }
      };
      img.src = imageDataUrl;
    });
  }
};