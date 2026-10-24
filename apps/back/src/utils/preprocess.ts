import sharp from 'sharp';
import path from 'node:path';

/** Mean luminance below this → treat as dark UI and invert. */
const DARK_MEAN_THRESHOLD = 128;

/** Upscale when the longer side is below this (UI fonts stay ~12–14px otherwise). */
const MIN_LONG_SIDE_PX = 2400;
const UPSCALE_FACTOR = 2;

/** White margin so Tesseract does not see an “empty page” / edge-clipped glyphs. */
const BORDER_PX = 10;

export interface PreprocessResult {
  outputPath: string;
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

  pipeline = pipeline
    .sharpen({ sigma: 0.8 })
    .extend({
      top: BORDER_PX,
      bottom: BORDER_PX,
      left: BORDER_PX,
      right: BORDER_PX,
      background: { r: 255, g: 255, b: 255 },
    })
    .png();

  await pipeline.toFile(outputPath);

  return { outputPath, inverted, meanLuminance, scale };
}

function buildPreprocessedPath(imagePath: string): string {
  const dir = path.dirname(imagePath);
  const base = path.basename(imagePath, path.extname(imagePath));
  return path.join(dir, `${base}.ocr.png`);
}
