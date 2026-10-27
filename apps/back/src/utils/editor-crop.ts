import fs from 'node:fs/promises';
import path from 'node:path';
import sharp, { type OutputInfo } from 'sharp';
import { runOcrTsv } from './ocr.js';

const PREPROCESS_BORDER_PX = 10;
const MIN_GUTTER_MARGIN_PX = 24;
const GUTTER_MARGIN_RATIO = 0.16;
const MAX_GUTTER_MARGIN_PX = 220;

interface OcrWord {
  left: number;
  top: number;
  width: number;
  height: number;
  confidence: number;
  text: string;
}

export interface EditorCropBounds {
  left: number;
  top: number;
  width: number;
  height: number;
  gutterLinesFound: number;
}

export function parseTesseractTsv(tsv: string): OcrWord[] {
  const words: OcrWord[] = [];
  const rows = tsv.trim().split(/\r?\n/);

  for (const row of rows.slice(1)) {
    const columns = row.split('\t');
    if (columns.length < 12 || columns[0] !== '5') {
      continue;
    }

    const [left, top, width, height, confidence] = columns
      .slice(6, 11)
      .map(Number);
    const text = columns[11];
    if (
      !Number.isFinite(left) ||
      !Number.isFinite(top) ||
      !Number.isFinite(width) ||
      !Number.isFinite(height) ||
      !Number.isFinite(confidence) ||
      !text
    ) {
      continue;
    }

    words.push({ left, top, width, height, confidence, text });
  }

  return words;
}

function dominantEdgeScore(
  pixels: Buffer,
  width: number,
  height: number,
  position: number,
  vertical: boolean,
  start: number,
  end: number
): number {
  let positive = 0;
  let negative = 0;

  for (let offset = start; offset < end; offset += 1) {
    const before = vertical
      ? pixels[offset * width + position - 1]!
      : pixels[(position - 1) * width + offset]!;
    const after = vertical
      ? pixels[offset * width + position]!
      : pixels[position * width + offset]!;
    const difference = after - before;
    if (difference > 10) positive += 1;
    else if (difference < -10) negative += 1;
  }

  const total = positive + negative;
  if (total === 0) return 0;
  const sampleLength = end - start;
  const dominance = Math.max(positive, negative) / total;
  return (total / sampleLength) * dominance;
}

function findStrongestPosition(
  pixels: Buffer,
  width: number,
  height: number,
  vertical: boolean,
  positionStart: number,
  positionEnd: number,
  sampleStart: number,
  sampleEnd: number
): number | undefined {
  let strongestPosition: number | undefined;
  let strongestScore = 0;

  for (
    let position = positionStart;
    position < Math.min(positionEnd, vertical ? width - 1 : height - 1);
    position += 1
  ) {
    const score = dominantEdgeScore(
      pixels,
      width,
      height,
      position,
      vertical,
      sampleStart,
      sampleEnd
    );
    if (score > strongestScore) {
      strongestScore = score;
      strongestPosition = position;
    }
  }

  return strongestScore >= 0.35 ? strongestPosition : undefined;
}

function hasConsistentRowSpacing(words: OcrWord[]): boolean {
  if (words.length < 3) return false;

  const gaps = words.slice(1).map((word, index) => word.top - words[index]!.top);
  const baseStep = Math.min(...gaps);
  const typicalHeight = words
    .map((word) => word.height)
    .sort((a, b) => a - b)[Math.floor(words.length / 2)]!;
  if (baseStep < typicalHeight * 0.7) return false;

  return gaps.every((gap) => {
    const multiple = Math.max(1, Math.round(gap / baseStep));
    return Math.abs(gap - multiple * baseStep) <= baseStep * 0.35;
  });
}

function findGutterLineWords(
  words: OcrWord[],
  dividerX: number,
  editorRight: number,
  editorTop: number,
  editorBottom: number,
  imageWidth: number
): OcrWord[] {
  const searchLeft = dividerX - Math.min(imageWidth * 0.16, 180);
  const searchRight = Math.min(editorRight, dividerX + 16);
  const candidates = words.filter(
    (word) =>
      /^\d{1,4}$/.test(word.text) &&
      word.confidence >= 10 &&
      word.left >= searchLeft &&
      word.left + word.width <= searchRight &&
      word.top >= editorTop &&
      word.top + word.height <= editorBottom
  );

  const xTolerance = Math.max(8, Math.round(imageWidth * 0.012));
  let bestCluster: OcrWord[] = [];
  for (const candidate of candidates) {
    const candidateRight = candidate.left + candidate.width;
    const cluster = candidates.filter(
      (word) =>
        Math.abs(word.left + word.width - candidateRight) <= xTolerance
    );
    if (cluster.length > bestCluster.length) {
      bestCluster = cluster;
    }
  }

  bestCluster.sort((a, b) => a.top - b.top);
  const distinctRows: OcrWord[] = [];
  for (const word of bestCluster) {
    const previous = distinctRows.at(-1);
    if (
      !previous ||
      Math.abs(word.top - previous.top) >
        Math.max(3, Math.min(word.height, previous.height) * 0.6)
    ) {
      distinctRows.push(word);
    }
  }

  return hasConsistentRowSpacing(distinctRows) ? distinctRows : [];
}

export function findEditorCropBounds(
  tsv: string,
  pixels: Buffer,
  imageWidth: number,
  imageHeight: number
): EditorCropBounds | undefined {
  if (pixels.length !== imageWidth * imageHeight) {
    throw new Error('Editor crop pixel data does not match image dimensions');
  }

  const words = parseTesseractTsv(tsv);
  const topSearchStart = Math.floor(imageHeight * 0.035);
  const topSearchEnd = Math.floor(imageHeight * 0.14);
  const topDivider = findStrongestPosition(
    pixels,
    imageWidth,
    imageHeight,
    false,
    topSearchStart,
    topSearchEnd,
    Math.floor(imageWidth * 0.2),
    imageWidth
  );
  const editorTop = Math.min(
    imageHeight - 2,
    (topDivider ?? Math.floor(imageHeight * 0.1)) + 2
  );

  // Ignore highlights and folded-line backgrounds inside the code pane.
  const bottomDivider = findStrongestPosition(
    pixels,
    imageWidth,
    imageHeight,
    false,
    Math.floor(imageHeight * 0.6),
    Math.floor(imageHeight * 0.92),
    Math.floor(imageWidth * 0.2),
    imageWidth
  );
  const editorBottom = Math.max(
    editorTop + 1,
    Math.min(imageHeight, (bottomDivider ?? imageHeight) + 2)
  );

  const leftDivider = findStrongestPosition(
    pixels,
    imageWidth,
    imageHeight,
    true,
    Math.floor(imageWidth * 0.05),
    Math.floor(imageWidth * 0.4),
    editorTop,
    editorBottom
  );
  if (leftDivider === undefined) {
    return undefined;
  }

  const gutterLines = findGutterLineWords(
    words,
    leftDivider,
    imageWidth,
    editorTop,
    editorBottom,
    imageWidth
  );
  const gutterLeft =
    gutterLines.length >= 3
      ? Math.min(...gutterLines.map((word) => word.left)) - 8
      : leftDivider;
  const gutterSafetyLeft = Math.floor(
    leftDivider -
      Math.max(
        MIN_GUTTER_MARGIN_PX,
        Math.min(imageWidth * GUTTER_MARGIN_RATIO, MAX_GUTTER_MARGIN_PX)
      )
  );
  const editorLeft = Math.max(
    0,
    Math.min(imageWidth - 1, Math.min(leftDivider + 2, gutterLeft, gutterSafetyLeft))
  );
  if (gutterLines.length < 3) {
    console.warn(
      '[EditorCrop] Tesseract did not find a reliable gutter number sequence; using detected editor panel bounds'
    );
  }

  const cropWidth = imageWidth - editorLeft;
  const cropHeight = editorBottom - editorTop;
  if (cropWidth < imageWidth * 0.25 || cropHeight < imageHeight * 0.15) {
    return undefined;
  }

  return {
    left: editorLeft,
    top: editorTop,
    width: cropWidth,
    height: cropHeight,
    gutterLinesFound: gutterLines.length,
  };
}

export async function createEditorCrop(
  imagePath: string,
  sourceImagePath = imagePath
): Promise<string | undefined> {
  const tsv = await runOcrTsv(imagePath);
  const { data, info } = await sharp(imagePath)
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const bounds = findEditorCropBounds(tsv, data, info.width, info.height);
  if (!bounds) {
    console.warn(
      `[EditorCrop] Could not determine editor region for ${imagePath}`
    );
    return undefined;
  }

  const extension = path.extname(imagePath);
  const outputPath = path.join(
    path.dirname(imagePath),
    `${path.basename(imagePath, extension)}.editor.png`
  );
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  let outputInfo: OutputInfo;
  if (sourceImagePath === imagePath) {
    outputInfo = await sharp(imagePath).extract(bounds).png().toFile(outputPath);
  } else {
    const { data: sourceImage, info: sourceInfo } = await sharp(sourceImagePath)
      .rotate()
      .toBuffer({ resolveWithObject: true });
    const scaleX =
      (info.width - PREPROCESS_BORDER_PX * 2) / sourceInfo.width;
    const scaleY =
      (info.height - PREPROCESS_BORDER_PX * 2) / sourceInfo.height;
    const left = Math.max(
      0,
      Math.floor((bounds.left - PREPROCESS_BORDER_PX) / scaleX)
    );
    const top = Math.max(
      0,
      Math.floor((bounds.top - PREPROCESS_BORDER_PX) / scaleY)
    );
    const right = Math.min(
      sourceInfo.width,
      Math.ceil(
        (bounds.left + bounds.width - PREPROCESS_BORDER_PX) / scaleX
      )
    );
    const bottom = Math.min(
      sourceInfo.height,
      Math.ceil(
        (bounds.top + bounds.height - PREPROCESS_BORDER_PX) / scaleY
      )
    );
    outputInfo = await sharp(sourceImage)
      .extract({
        left,
        top,
        width: right - left,
        height: bottom - top,
      })
      .png()
      .toFile(outputPath);
  }
  console.log(
    `[EditorCrop] Created ${outputPath} (${outputInfo.width}x${outputInfo.height}; detected bounds=${bounds.width}x${bounds.height} at ${bounds.left},${bounds.top}; gutter lines=${bounds.gutterLinesFound})`
  );
  return outputPath;
}
