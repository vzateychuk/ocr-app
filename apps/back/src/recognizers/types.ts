import type { VisionClient } from '../services/vision-client.js';
import type { ImageCategory } from '../types/jev.types.js';

export interface RecognizedLine {
  /**
   * 1-based source line number as shown in the screenshot gutter.
   */
  lineNumber?: number;
  /** Recognized line content without gutter numbers or UI markers. */
  text: string;
}

export interface NumberedRecognizedLine extends RecognizedLine {
  lineNumber: number;
}

export interface RecognitionResult {
  /** Full recognized text. */
  text: string;
  /** Recognized lines. Line numbers are present for code screenshots. */
  lines: RecognizedLine[];
}

export interface Recognizer {
  /** Category served by a specialized recognizer. DefaultRecognizer has no category. */
  readonly category?: ImageCategory;
  recognize(
    imageBuffer: Buffer,
    visionClient: VisionClient
  ): Promise<RecognitionResult | undefined>;
}

export function isNumberedLine(
  line: RecognizedLine
): line is NumberedRecognizedLine {
  return Number.isInteger(line.lineNumber) && (line.lineNumber as number) >= 1;
}
