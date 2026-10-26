import type { VisionClient } from '../services/vision-client.js';
import { parseJsonObject } from './json.js';
import type { RecognitionResult, Recognizer } from './types.js';

const DEFAULT_RECOGNITION_PROMPT = `Распознай весь текст на изображении и верни его одним JSON-объектом.

Правила:
- Сохраняй порядок строк, переносы строк, отступы и пробелы.
- Не добавляй пояснения, заголовки и markdown.
- Не выдумывай текст, которого нет на изображении.
- Верни ТОЛЬКО JSON без пояснений.

Схема:
{
  "text": "полный распознанный текст"
}`;

export function parseDefaultRecognition(
  raw: string
): RecognitionResult | undefined {
  const parsed = parseJsonObject(raw);
  if (!parsed || typeof parsed !== 'object') {
    return undefined;
  }

  const text = (parsed as { text?: unknown }).text;
  if (typeof text !== 'string' || text.trim().length === 0) {
    return undefined;
  }

  return { text, lines: [] };
}

export class DefaultRecognizer implements Recognizer {
  async recognize(
    imageBuffer: Buffer,
    visionClient: VisionClient
  ): Promise<RecognitionResult | undefined> {
    const rawResponse = await visionClient.completeVision({
      imageBuffer,
      prompt: DEFAULT_RECOGNITION_PROMPT,
    });

    const result = parseDefaultRecognition(rawResponse);
    if (!result) {
      console.warn(
        '[DefaultRecognizer] Failed to parse Vision response or empty text'
      );
    }

    return result;
  }
}
