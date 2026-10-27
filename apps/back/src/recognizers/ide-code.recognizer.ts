import type { VisionClient } from '../services/vision-client.js';
import type {
  RecognitionResult,
  RecognizedLine,
  Recognizer,
} from './types.js';

const IDE_CODE_RECOGNITION_PROMPT = `Распознай весь видимый код в редакторе и выведи ТОЛЬКО строки в формате:
L00024|I02|текст строки без начальных пробелов

КРИТИЧНО: номер строки бери непосредственно из gutter на изображении. Не вычисляй его по позиции строки в ответе и не перенумеровывай строки.
Для каждого читаемого номера в gutter выведи ровно одну запись, даже если строка визуально пустая. Пустая строка — это строка с номером, но без текста: выведи, например, L00030|I00|.
Не пропускай пустые строки и не объединяй соседние пустые строки. Для двух пустых строк L00030 и L00031 обязательно выведи:
L00030|I00|
L00031|I00|
Следующая после них строка сохраняет свой номер из gutter. Например:
L00029|I00|POLL_INTERVAL = int(os.environ.get("CALM_WORKER_POLL_INTERVAL", "3"))
L00030|I00|
L00031|I00|
L00032|I00|def _generate_worker_id() -> str:

Формат: L + номер из gutter (1-based, минимум 5 цифр с ведущими нулями) + | + I + уровень отступа двумя цифрами + | + содержимое строки.
Отступ не включай в содержимое: укажи число уровней в I, где один уровень равен четырём пробелам (I00 — нет отступа, I01 — 4 пробела, I02 — 8 пробелов). Сохраняй все остальные символы строки точно; не исправляй и не форматируй код.
Если номер в gutter не читается, пропусти эту строку, не угадывай номер. Не включай UI. Не используй markdown fences и не добавляй пояснения.`;

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
      lineNumber: sourceLineNumber,
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
