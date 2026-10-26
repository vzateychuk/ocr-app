import type { EntityId } from '../identifiers/index.js';
import type { RecognizedLine } from '../recognizers/types.js';
import type { ImageCategory } from '../types/jev.types.js';

export interface SaveRecognizedContentInput {
  kbBaseDir: string;
  category: ImageCategory;
  originalName: string;
  /** Full text returned by the recognition vision model. */
  recognizedText?: string;
  /** Backward-compatible alias for recognizedText. */
  extractedText?: string;
  /** Recognized lines; source line numbers are required by IdeCodeSaver. */
  lines?: RecognizedLine[];
  entityId?: EntityId;
  timestamp: Date;
}

export interface Saver {
  /** Category served by a specialized saver. DefaultSaver has no category. */
  readonly category?: ImageCategory;
  /** Returns the saved path, or undefined when there is nothing to save. */
  save(input: SaveRecognizedContentInput): Promise<string | undefined>;
}
