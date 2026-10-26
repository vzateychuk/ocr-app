import type { ImageCategory } from '../types/jev.types.js';
import { DefaultSaver } from './default.saver.js';
import { IdeCodeSaver } from './ide-code.saver.js';
import type { Saver } from './types.js';

export const defaultSaver = new DefaultSaver();

const specializedSavers: Saver[] = [new IdeCodeSaver()];

export function getSaver(category: ImageCategory): Saver {
  return (
    specializedSavers.find((saver) => saver.category === category) ??
    defaultSaver
  );
}

export { DefaultSaver, IdeCodeSaver };
export * from './types.js';
