import type { ImageCategory } from '../types/jev.types.js';
import { DefaultRecognizer } from './default.recognizer.js';
import { IdeCodeRecognizer } from './ide-code.recognizer.js';
import type { Recognizer } from './types.js';

export { parseDefaultRecognition } from './default.recognizer.js';
export { parseCodeRecognition } from './ide-code.recognizer.js';

export const defaultRecognizer = new DefaultRecognizer();

const specializedRecognizers: Recognizer[] = [new IdeCodeRecognizer()];

export function getRecognizer(category: ImageCategory): Recognizer {
  return (
    specializedRecognizers.find(
      (recognizer) => recognizer.category === category
    ) ?? defaultRecognizer
  );
}

export { DefaultRecognizer, IdeCodeRecognizer };
export * from './types.js';
