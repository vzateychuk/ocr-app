import sharp, { type Sharp, type OutputInfo } from 'sharp';
import path from 'node:path';
import fs from 'node:fs/promises';

/** Mean luminance below this → treat as dark UI and invert. */
const DARK_MEAN_THRESHOLD = 128;

/** Upscale when the longer side is below this (UI fonts stay ~12–14px otherwise). */
const MIN_LONG_SIDE_PX = 2400;
const UPSCALE_FACTOR = 2;

/** White margin so Tesseract does not see an “empty page” / edge-clipped glyphs. */
const BORDER_PX = 10;

/** Ratio of image height to crop from top for Vision (tab bar + breadcrumbs). */
const VISION_CROP_TOP_RATIO = Number(process.env.VISION_CROP_TOP_RATIO) || 0.18;

export interface PreprocessResult {
  outputPath: string;
  visionCropPath?: string;
  inverted: boolean;
  meanLuminance: number;
  scale: number;
}

/**
 * Preprocess a UI screenshot for Tesseract.
 *
 * Typical inputs (GitHub/Jira/Teams/IDE dark mode, Artifactory light+dark):
 * 1. grayscale
 * 2. if mostly dark → invert (Tesseract 4+ wants dark text on light bg)
 * 3. contrast stretch (helps light-gray-on-white table text)
 * 4. upscale when the frame is small
 * 5. light sharpen + white border
 *
 * Hard binarization is left to Tesseract — aggressive thresholding eats
 * anti-aliased UI fonts and thin monospace glyphs.
 */
export async function preprocessForOcr(imagePath: string): Promise<PreprocessResult> {
  const image = sharp(imagePath).rotate(); // honour EXIF if present
  const { data, info } = await image
    .clone()
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  let sum = 0;
  for (let i = 0; i < data.length; i++) {
    sum += data[i]!;
  }
  const meanLuminance = sum / data.length;
  const inverted = meanLuminance < DARK_MEAN_THRESHOLD;

  const longSide = Math.max(info.width, info.height);
  const scale = longSide > 0 && longSide < MIN_LONG_SIDE_PX ? UPSCALE_FACTOR : 1;

  const outputPath = buildPreprocessedPath(imagePath);

  let pipeline = sharp(imagePath).rotate().greyscale();

  if (inverted) {
    pipeline = pipeline.negate({ alpha: false });
  }

  // Stretch histogram: lifts washed-out gray body text (e.g. Artifactory table).
  pipeline = pipeline.normalize();

  if (scale !== 1) {
    pipeline = pipeline.resize({
      width: Math.round(info.width * scale),
      height: Math.round(info.height * scale),
      kernel: sharp.kernel.cubic,
    });
  }

  // Apply sharpen and border for OCR
  const ocrPipeline = pipeline
    .clone()
    .sharpen({ sigma: 0.8 })
    .extend({
      top: BORDER_PX,
      bottom: BORDER_PX,
      left: BORDER_PX,
      right: BORDER_PX,
      background: { r: 255, g: 255, b: 255 },
    })
    .png();

  await ocrPipeline.toFile(outputPath);

  // Create Vision crop from the same preprocessed pipeline (before border for cleaner crop)
  const visionCropPath = await createVisionCrop(pipeline, info, scale, imagePath);

  return { outputPath, visionCropPath, inverted, meanLuminance, scale };
}

async function createVisionCrop(
  basePipeline: Sharp,
  info: OutputInfo,
  scale: number,
  originalPath: string
): Promise<string | undefined> {
  try {
    const scaledHeight = Math.round(info.height * scale);
    const cropHeight = Math.ceil(scaledHeight * VISION_CROP_TOP_RATIO);
    
    if (cropHeight <= 0) {
      return undefined;
    }

    const cropPipeline = basePipeline
      .clone()
      .extract({ left: 0, top: 0, width: Math.round(info.width * scale), height: cropHeight })
      .png();

    const dir = path.dirname(originalPath);
    const base = path.basename(originalPath, path.extname(originalPath));
    const visionPath = path.join(dir, `${base}.vision.png`);

    await cropPipeline.toFile(visionPath);
    return visionPath;
  } catch (err) {
    console.warn('[Preprocess] Failed to create Vision crop:', err);
    return undefined;
  }
}

function buildPreprocessedPath(imagePath: string): string {
  const dir = path.dirname(imagePath);
  const base = path.basename(imagePath, path.extname(imagePath));
  return path.join(dir, `${base}.ocr.png`);
}
