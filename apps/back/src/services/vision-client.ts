import OpenAI from 'openai';
import fs from 'node:fs/promises';

export interface VisionClientConfig {
  baseURL: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
}

export interface VisionClient {
  completeVision(input: {
    imageBuffer: Buffer;
    prompt: string;
    timeoutMs?: number;
  }): Promise<string>;
}

function createVisionClient(config: VisionClientConfig): VisionClient {
  const client = new OpenAI({
    baseURL: config.baseURL,
    apiKey: config.apiKey,
  });

  async function completeVision(input: {
    imageBuffer: Buffer;
    prompt: string;
    timeoutMs?: number;
  }): Promise<string> {
    const base64Image = input.imageBuffer.toString('base64');
    const dataUrl = `data:image/png;base64,${base64Image}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), input.timeoutMs ?? config.timeoutMs);

    try {
      const response = await client.chat.completions.create(
        {
          model: config.model,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: input.prompt },
                { type: 'image_url', image_url: { url: dataUrl } },
              ],
            },
          ],
          max_tokens: 500,
          temperature: 0,
        },
        { signal: controller.signal }
      );

      const content = response.choices[0]?.message?.content?.trim();
      if (!content) {
        throw new Error('Empty response from Vision model');
      }
      return content;
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error(`Vision request timeout after ${input.timeoutMs ?? config.timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }

  return { completeVision };
}

export function buildVisionClientFromEnv(): VisionClient | null {
  const baseURL = process.env.VISION_BASE_URL || 'undefined';
  const apiKey = process.env.VISION_API_KEY || 'undefined';
  const model = process.env.VISION_MODEL || 'undefined';
  const timeoutMs = Number(process.env.VISION_TIMEOUT_MS) || 15000;

  if (!apiKey) {
    console.warn('[VisionClient] VISION_API_KEY not set — Vision identification will soft-fail');
    return null;
  }

  return createVisionClient({ baseURL, apiKey, model, timeoutMs });
}