import { SagaContext, SagaDefinition } from '../fsm/index.js';
import { JevService } from './jev.service.js';
import { runOcr } from '../utils/ocr.js';
import { preprocessForOcr } from '../utils/preprocess.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ImageCategory } from '../types/jev.types.js';

export interface UploadContext extends SagaContext {
  /** Original upload in tmp (deleted after save). */
  filePath: string;
  /** Preprocessed image: used by OCR / future Vision, then persisted to raw/images. */
  ocrImagePath?: string;
  originalName: string;
  extractedText?: string;
  category?: ImageCategory;
  confidence?: number;
  probabilities?: Partial<Record<ImageCategory, number>>;
  savedImagePath?: string;
}

/**
 * Knowledge base layout under KB_BASE_DIR:
 *   tmp/          — temp uploads
 *   raw/images/   — preprocessed screenshots (OCR + Vision input)
 *   raw/docs/     — recognized (OCR) files
 *   wiki/         — processed artifacts
 */
const KB_RAW_IMAGES_SUBDIR = path.join('raw', 'images');
const KB_RAW_DOCS_SUBDIR = path.join('raw', 'docs');
const KB_WIKI_SUBDIR = 'wiki';

function createSteps(jevService: JevService, kbBaseDir: string) {
  const preprocessStep = async (ctx: UploadContext): Promise<void> => {
    const result = await preprocessForOcr(ctx.filePath);
    ctx.ocrImagePath = result.outputPath;
    console.log(
      `[UploadSaga] Preprocess ${ctx.originalName}: mean=${result.meanLuminance.toFixed(1)}` +
        ` inverted=${result.inverted} scale=${result.scale}x -> ${result.outputPath}`
    );
  };

  const ocrStep = async (ctx: UploadContext): Promise<void> => {
    const ocrPath = ctx.ocrImagePath ?? ctx.filePath;
    ctx.extractedText = await runOcr(ocrPath);
  };

  const classifyStep = async (ctx: UploadContext): Promise<void> => {
    const result = await jevService.getCategory(ctx.extractedText!);
    ctx.category = result.category;
    ctx.confidence = result.confidence;
    ctx.probabilities = result.probabilities;
  };

  const saveStep = async (ctx: UploadContext): Promise<void> => {
    const now = new Date();
    const timestamp = now.toISOString()
      .replace(/T/, '_')
      .replace(/\..+/, '')
      .replace(/:/g, '-');

    // Preprocess always writes PNG; that artifact is what we keep for OCR/Vision.
    const sourcePath = ctx.ocrImagePath ?? ctx.filePath;
    const slug = `${timestamp}_${ctx.category}`;
    const fileName = `${slug}.png`;

    const targetDir = path.join(kbBaseDir, KB_RAW_IMAGES_SUBDIR);
    await fs.mkdir(targetDir, { recursive: true });
    await fs.mkdir(path.join(kbBaseDir, KB_RAW_DOCS_SUBDIR), { recursive: true });
    await fs.mkdir(path.join(kbBaseDir, KB_WIKI_SUBDIR), { recursive: true });

    const targetPath = path.join(targetDir, fileName);
    await fs.copyFile(sourcePath, targetPath);
    ctx.savedImagePath = targetPath;
    console.log(`[UploadSaga] Saved preprocessed raw image: ${targetPath}`);
  };

  const cleanupStep = async (ctx: UploadContext): Promise<void> => {
    for (const tempPath of [ctx.filePath, ctx.ocrImagePath]) {
      if (!tempPath) continue;
      try {
        await fs.unlink(tempPath);
        console.log(`[UploadSaga] Cleaned up temp file: ${tempPath}`);
      } catch (err) {
        console.warn(`[UploadSaga] Failed to cleanup temp file ${tempPath}:`, err);
      }
    }
  };  

  const postprocessStep = async (ctx: UploadContext): Promise<void> => {
    // Stub for post-processing
  };

  return [preprocessStep, ocrStep, classifyStep, saveStep, cleanupStep, postprocessStep] as const;
}

export function createUploadSaga(
  jevService: JevService,
  kbBaseDir: string
): SagaDefinition<UploadContext> {
  const [preprocessStep, ocrStep, classifyStep, saveStep, cleanupStep, postprocessStep] = createSteps(jevService, kbBaseDir);

  return {
    name: 'upload',
    steps: [
      { name: 'preprocess', execute: preprocessStep },
      { name: 'ocr', execute: ocrStep },
      { name: 'classify', execute: classifyStep },
      { name: 'save', execute: saveStep },
      { name: 'cleanup', execute: cleanupStep },
      { name: 'postprocess', execute: postprocessStep },
    ],
    onError: async (ctx, err, stepName) => {
      console.error(`[UploadSaga] Failed at step '${stepName}':`, err);
    },
    onComplete: async (ctx) => {
      console.log(`[UploadSaga] Completed: ${ctx.originalName} -> ${ctx.category}`);
    },
  };
}