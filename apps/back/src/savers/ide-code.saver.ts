import fs from 'node:fs/promises';
import path from 'node:path';
import {
  isNumberedLine,
  type NumberedRecognizedLine,
} from '../recognizers/types.js';
import { sanitizeSlug } from '../identifiers/index.js';
import type { Saver, SaveRecognizedContentInput } from './types.js';
import { getDefaultImageFileName } from './utils.js';

export const RAW_CODE_SUBDIR = path.join('raw', 'code');

function resolveCodePath(kbBaseDir: string, canonicalId: string): string {
  if (!canonicalId || canonicalId.includes('\0')) {
    throw new Error('Invalid canonicalId: empty or contains NUL byte');
  }

  if (
    path.isAbsolute(canonicalId) ||
    canonicalId.includes('\\') ||
    /^[A-Za-z]:/.test(canonicalId)
  ) {
    throw new Error(`Unsafe canonicalId: ${canonicalId}`);
  }

  const segments = canonicalId.split('/');
  if (segments.some((segment) => segment === '..')) {
    throw new Error(`Unsafe canonicalId: ${canonicalId}`);
  }

  const normalized = path.normalize(canonicalId);
  if (normalized === '.' || normalized.endsWith(path.sep)) {
    throw new Error(`Invalid canonicalId: ${canonicalId}`);
  }

  const root = path.resolve(kbBaseDir, RAW_CODE_SUBDIR);
  const targetPath = path.resolve(root, normalized);

  if (targetPath !== root && !targetPath.startsWith(`${root}${path.sep}`)) {
    throw new Error(
      `Unsafe canonicalId escapes ${RAW_CODE_SUBDIR}: ${canonicalId}`
    );
  }

  return targetPath;
}

export function mergeCodeLines(
  existingContent: string | null,
  lines: NumberedRecognizedLine[]
): string {
  const hadTrailingNewline =
    existingContent !== null && existingContent.endsWith('\n');

  let existingLines: string[];
  if (existingContent === null || existingContent === '') {
    existingLines = [];
  } else {
    existingLines = existingContent.split('\n');
    if (hadTrailingNewline) {
      existingLines.pop();
    }
  }

  let maxLineNumber = -1;
  for (const line of lines) {
    if (!Number.isInteger(line.lineNumber) || line.lineNumber < 0) {
      throw new Error(`Invalid recognized line number: ${line.lineNumber}`);
    }
    maxLineNumber = Math.max(maxLineNumber, line.lineNumber);
  }

  while (existingLines.length <= maxLineNumber) {
    existingLines.push('');
  }

  for (const line of lines) {
    // lineNumber is zero-based, so the array index is the source line itself.
    // No shifting is performed: missing lines are padded with empty strings.
    existingLines[line.lineNumber] = line.text;
  }

  const trailingNewline = existingContent === null || hadTrailingNewline;
  return `${existingLines.join('\n')}${trailingNewline ? '\n' : ''}`;
}

export class IdeCodeSaver implements Saver {
  readonly category = 'ide_code' as const;

  getImageFileName(input: SaveRecognizedContentInput): string {
    const canonicalId = input.entityId?.canonicalId;
    const lines = (input.lines ?? []).filter(isNumberedLine);
    if (!canonicalId || lines.length === 0) {
      return getDefaultImageFileName(input);
    }

    const lineNumbers = lines.map((line) => line.lineNumber + 1);
    const firstLine = Math.min(...lineNumbers);
    const lastLine = Math.max(...lineNumbers);
    return `${sanitizeSlug(canonicalId)}_L${firstLine}-L${lastLine}.png`;
  }

  async save(input: SaveRecognizedContentInput): Promise<string | undefined> {
    const canonicalId = input.entityId?.canonicalId;
    if (!canonicalId) {
      console.warn(
        '[IdeCodeSaver] canonicalId is missing — recognized code will not be saved'
      );
      return undefined;
    }

    const lines = (input.lines ?? []).filter(isNumberedLine);
    if (lines.length === 0) {
      console.warn(
        '[IdeCodeSaver] no recognized lines with source line numbers — recognized code will not be saved'
      );
      return undefined;
    }

    let targetPath: string;
    try {
      targetPath = resolveCodePath(input.kbBaseDir, canonicalId);
    } catch (error) {
      console.warn(
        `[IdeCodeSaver] rejected canonicalId '${canonicalId}':`,
        error instanceof Error ? error.message : error
      );
      return undefined;
    }

    await fs.mkdir(path.dirname(targetPath), { recursive: true });

    let existingContent: string | null = null;
    try {
      existingContent = await fs.readFile(targetPath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }

    const mergedContent = mergeCodeLines(existingContent, lines);
    await fs.writeFile(targetPath, mergedContent, 'utf8');

    return targetPath;
  }
}
