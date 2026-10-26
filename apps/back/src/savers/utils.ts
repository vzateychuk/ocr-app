import fs from 'node:fs/promises';
import path from 'node:path';

export function formatTimestamp(date: Date): string {
  return date
    .toISOString()
    .replace(/T/, '_')
    .replace(/\..+/, '')
    .replace(/:/g, '-');
}

/**
 * Writes a file without overwriting an existing document. If the name is
 * already taken, a numeric suffix is appended.
 */
export async function writeUniqueFile(
  directory: string,
  baseName: string,
  extension: string,
  content: string
): Promise<string> {
  await fs.mkdir(directory, { recursive: true });

  for (let index = 0; index < 1000; index += 1) {
    const suffix = index === 0 ? '' : `_${index}`;
    const targetPath = path.join(
      directory,
      `${baseName}${suffix}${extension}`
    );

    try {
      await fs.writeFile(targetPath, content, { encoding: 'utf8', flag: 'wx' });
      return targetPath;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        continue;
      }
      throw error;
    }
  }

  throw new Error(
    `Could not find a unique file name for ${baseName}${extension} in ${directory}`
  );
}
