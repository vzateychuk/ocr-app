import OpenAI from 'openai';

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
    console.debug(`[VisionClient] Request: model=${config.model}, imageSize=${input.imageBuffer.length}B, base64Len=${base64Image.length}, timeout=${input.timeoutMs ?? config.timeoutMs}ms`);

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
          max_tokens: 1024,
          temperature: 0.1,
          top_p: 0.95,
          // Disable thinking mode for faster, deterministic JSON output
          chat_template_kwargs: { enable_thinking: false },
        } as any,
        { signal: controller.signal }
      );

      const content = response.choices[0]?.message?.content?.trim();
      console.debug(`[VisionClient] Response: contentLength=${content?.length ?? 0}, finishReason=${response.choices[0]?.finish_reason}`);
      if (!content) {
        throw new Error('Empty response from Vision model');
      }
      return content;
    } catch (err) {
      const isAbort = err instanceof DOMException && err.name === 'AbortError' ||
        err instanceof Error && err.name === 'AbortError';
      if (isAbort) {
        console.warn(`[VisionClient] Request timeout after ${input.timeoutMs ?? config.timeoutMs}ms`);
        throw new Error(`Vision request timeout after ${input.timeoutMs ?? config.timeoutMs}ms`);
      }
      const anyErr = err as any;
      console.warn(`[VisionClient] API Error: status=${anyErr.status}, code=${anyErr.code}, type=${anyErr.type}, message=${anyErr.message}`);
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }

  return { completeVision };
}

export function buildVisionClientFromEnv(): VisionClient | null {
  const baseURL = process.env.VISION_BASE_URL || 'https://integrate.api.nvidia.com/v1';
  const apiKey = process.env.VISION_API_KEY;
  const model = process.env.VISION_MODEL || 'nvidia/nemotron-3.5-super-vl-120b-a12b';
  const timeoutMs = Number(process.env.VISION_TIMEOUT_MS) || 60000;

  if (!apiKey) {
    console.warn('[VisionClient] VISION_API_KEY not set — Vision identification will soft-fail');
    return null;
  }

  return createVisionClient({ baseURL, apiKey, model, timeoutMs });
}