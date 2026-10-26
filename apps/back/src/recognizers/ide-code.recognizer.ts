import type { VisionClient } from '../services/vision-client.js';
import type {
  RecognitionResult,
  RecognizedLine,
  Recognizer,
} from './types.js';

const IDE_CODE_RECOGNITION_PROMPT = `Ты видишь скриншот IDE с исходным кодом. Распознай ВЕСЬ видимый код построчно.

Верни каждую видимую строку кода отдельной строкой в формате:
L00024|I02|from common.extractors.base import SignalExtractionContext

Поля: L + номер строки из gutter (1-based, минимум 5 цифр с ведущими нулями) + | + I + уровень отступа двумя цифрами + | + текст строки без начальных пробелов.

Правила:
- Считай уровень отступа по визуальным шагам от левого края области кода: каждый шаг/уровень отступа равен четырём пробелам. Указывай его после I (I00 — без отступа, I01 — 4 пробела, I02 — 8 пробелов и т.д.).
- Не включай отступ в текст после второго разделителя: он будет восстановлен из поля I. Сохраняй остальные символы строки в точности, включая пробелы в конце.
- Не исправляй код, не переформатируй его и не дописывай отсутствующие строки.
- Для пустой строки укажи уровень отступа и пустой текст, например L00028|I00|.
- Если номер строки не виден или не читается, пропусти эту строку. Не угадывай номер.
- Не включай таб-бар, breadcrumbs, заголовки вкладок и прочий UI.
- Не оборачивай ответ в markdown code fence и не добавляй пояснения.}`;

const INDENTATION_WIDTH = 4;

export function parseCodeRecognition(
  raw: string
): RecognitionResult | undefined {
  const lines: RecognizedLine[] = [];
  for (const rawLine of raw.split(/\r?\n/)) {
    if (rawLine.startsWith('```')) {
      continue;
    }

    const match = /^L(\d{5,})\|I(\d{2})\|(.*)$/.exec(rawLine);
    if (!match) {
      continue;
    }

    const sourceLineNumber = Number(match[1]);
    const indentationLevel = Number(match[2]);
    if (!Number.isSafeInteger(sourceLineNumber) || sourceLineNumber < 1) {
      continue;
    }

    lines.push({
      lineNumber: sourceLineNumber - 1,
      text: `${' '.repeat(indentationLevel * INDENTATION_WIDTH)}${match[3]}`,
    });
  }

  if (lines.length === 0) {
    return undefined;
  }

  return {
    text: lines.map((line) => line.text).join('\n'),
    lines,
  };
}

export class IdeCodeRecognizer implements Recognizer {
  readonly category = 'ide_code' as const;

  async recognize(
    imageBuffer: Buffer,
    visionClient: VisionClient
  ): Promise<RecognitionResult | undefined> {
    const rawResponse = await visionClient.completeVision({
      imageBuffer,
      prompt: IDE_CODE_RECOGNITION_PROMPT,
    });

    const result = parseCodeRecognition(rawResponse);
    if (!result) {
      console.warn(
        '[IdeCodeRecognizer] Failed to parse Vision response or no lines returned'
      );
    }

    return result;
  }
}
