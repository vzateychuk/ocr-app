import path from 'node:path';
import { sanitizeSlug } from '../identifiers/index.js';
import type { Saver, SaveRecognizedContentInput } from './types.js';
import { formatTimestamp, writeUniqueFile } from './utils.js';

export const RAW_OCR_SUBDIR = path.join('raw', 'ocr');

export class DefaultSaver implements Saver {
  async save(input: SaveRecognizedContentInput): Promise<string | undefined> {
    const text = input.recognizedText ?? input.extractedText;
    if (text === undefined) {
      return undefined;
    }

    const directory = path.join(input.kbBaseDir, RAW_OCR_SUBDIR);
    const originalBaseName = path.parse(input.originalName).name;
    const slug = sanitizeSlug(originalBaseName) || 'ocr';
    const baseName = `${formatTimestamp(input.timestamp)}_${slug}`;

    return writeUniqueFile(directory, baseName, '.md', text);
  }
}
