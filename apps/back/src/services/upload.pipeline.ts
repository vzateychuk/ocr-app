import { SagaContext, SagaDefinition } from '../fsm/index.js';
import { JevService } from './jev.service.js';
import { VisionClient } from './vision-client.js';
import { runOcr } from '../utils/ocr.js';
import { preprocessForOcr } from '../utils/preprocess.js';
import { createEditorCrop } from '../utils/editor-crop.js';
import { getIdentifier, EntityId } from '../identifiers/index.js';
import {
  getRecognizer,
  type RecognizedLine,
} from '../recognizers/index.js';
import { getSaver } from '../savers/index.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ImageCategory } from '../types/jev.types.js';

export interface UploadContext extends SagaContext {
  /** Original upload in tmp (deleted after save). */
  filePath: string;
  /** Preprocessed and upscaled image used for Tesseract OCR. */
  ocrImagePath?: string;
  /** Cropped top strip for Vision (tab bar + breadcrumbs). */
  visionImagePath?: string;
  /** Editor-only crop sent to Vision and copied to raw/images. */
  editorCropPath?: string;
  originalName: string;
  /** Preliminary Tesseract text used only by the JEV classifier. */
  extractedText?: string;
  /** Full text returned by the recognition vision model. */
  recognizedText?: string;
  /** Full line-by-line recognition from the vision model. */
  recognizedLines?: RecognizedLine[];
  category?: ImageCategory;
  confidence?: number;
  probabilities?: Partial<Record<ImageCategory, number>>;
  /** Entity identifier from Vision (for ide_code and future categories). */
  entityId?: EntityId;
  savedImagePath?: string;
  savedTextPath?: string;
}

/**
 * Knowledge base layout under KB_BASE_DIR:
 *   tmp/          — temp uploads
 *   raw/images/   — editor crops for IDE code, preprocessed screenshots otherwise
 *   raw/ocr/      — recognized document text (DefaultSaver)
 *   raw/code/     — recognized IDE code merged by source line (IdeCodeSaver)
 *   wiki/         — processed artifacts
 */
const KB_RAW_IMAGES_SUBDIR = path.join('raw', 'images');
const KB_WIKI_SUBDIR = 'wiki';

async function cleanupTempFiles(ctx: UploadContext): Promise<void> {
  const tempPaths = new Set([
    ctx.filePath,
    ctx.ocrImagePath,
    ctx.visionImagePath,
    ctx.editorCropPath,
  ]);

  for (const tempPath of tempPaths) {
    if (!tempPath) continue;
    try {
      await fs.unlink(tempPath);
      console.log(`[UploadSaga] Cleaned up temp file: ${tempPath}`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        continue;
      }
      console.warn(`[UploadSaga] Failed to cleanup temp file ${tempPath}:`, err);
    }
  }
}

function createSteps(
  jevService: JevService,
  visionClient: VisionClient | null,
  kbBaseDir: string
) {
  const preprocessStep = async (ctx: UploadContext): Promise<void> => {
    const result = await preprocessForOcr(ctx.filePath);
    ctx.ocrImagePath = result.outputPath;
    ctx.visionImagePath = result.visionCropPath;
    console.log(
      `[UploadSaga] Preprocess ${ctx.originalName}: mean=${result.meanLuminance.toFixed(1)}` +
        ` inverted=${result.inverted} scale=${result.scale}x -> ${result.outputPath}` +
        (result.visionCropPath ? ` visionCrop=${result.visionCropPath}` : '')
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

  const identifyStep = async (ctx: UploadContext): Promise<void> => {
    if (!visionClient) {
      console.log('[UploadSaga] Vision client not configured — skipping identify');
      return;
    }
    if (!ctx.category || !ctx.visionImagePath) {
      return;
    }

    const identifier = getIdentifier(ctx.category);
    if (!identifier) {
      console.log(`[UploadSaga] No identifier for category ${ctx.category} — skipping identify`);
      return;
    }

    try {
      const imageBuffer = await fs.readFile(ctx.visionImagePath);
      const entityId = await identifier.identify(imageBuffer, visionClient);
      if (entityId) {
        ctx.entityId = entityId;
        console.log(`[UploadSaga] Identified entityId: ${entityId.canonicalId}`);
      } else {
        console.log('[UploadSaga] Identifier returned no entityId');
      }
    } catch (err) {
      console.warn('[UploadSaga] Identify step failed (soft-fail):', err instanceof Error ? err.message : err);
    }
  };

  const cropEditorStep = async (ctx: UploadContext): Promise<void> => {
    if (ctx.category !== 'ide_code') {
      return;
    }

    const detectionImagePath = ctx.ocrImagePath ?? ctx.filePath;
    ctx.editorCropPath = await createEditorCrop(
      detectionImagePath,
      ctx.filePath
    );
    if (!ctx.editorCropPath) {
      console.warn(
        '[UploadSaga] Editor crop unavailable; using the full preprocessed image for recognition and persistence'
      );
    }
  };

  const recognizeStep = async (ctx: UploadContext): Promise<void> => {
    if (!visionClient) {
      console.log('[UploadSaga] Vision client not configured — skipping recognize');
      return;
    }
    if (!ctx.category) {
      console.log('[UploadSaga] Category is missing — skipping recognize');
      return;
    }

    const imagePath =
      ctx.editorCropPath ?? ctx.ocrImagePath ?? ctx.filePath;
    const recognizer = getRecognizer(ctx.category);

    try {
      // IDE code uses the editor crop; other categories use the preprocessed image.
      const imageBuffer = await fs.readFile(imagePath);
      const result = await recognizer.recognize(imageBuffer, visionClient);
      if (!result) {
        throw new Error(
          `Vision recognition returned no usable result for category ${ctx.category}`
        );
      }

      ctx.recognizedText = result.text;
      ctx.recognizedLines = result.lines;
      console.log(
        `[UploadSaga] Recognized ${result.text.length} chars, ${result.lines.length} lines for ${ctx.category}`
      );
    } catch (err) {
      console.error(
        '[UploadSaga] Recognize step failed:',
        err instanceof Error ? err.message : err
      );
      throw err;
    }
  };

  const saveStep = async (ctx: UploadContext): Promise<void> => {
    const now = new Date();
    const category = ctx.category ?? 'unknown';
    const saver = getSaver(category);
    const saveInput = {
      kbBaseDir,
      category,
      originalName: ctx.originalName,
      // Only the full Vision recognition is handed to the saver. The Tesseract
      // text in ctx.extractedText is intentionally not used here.
      recognizedText: ctx.recognizedText,
      lines: ctx.recognizedLines,
      entityId: ctx.entityId,
      timestamp: now,
    };
    const fileName = saver.getImageFileName(saveInput);
    const sourcePath =
      ctx.editorCropPath ?? ctx.ocrImagePath ?? ctx.filePath;

    const targetDir = path.join(kbBaseDir, KB_RAW_IMAGES_SUBDIR);
    await fs.mkdir(targetDir, { recursive: true });
    await fs.mkdir(path.join(kbBaseDir, KB_WIKI_SUBDIR), { recursive: true });

    // Image persistence is independent of the category-specific saver.
    const targetPath = path.join(targetDir, fileName);
    // Code screenshots are keyed by entity and visible line range; the same
    // entity/range intentionally replaces the previously saved screenshot.
    await fs.copyFile(sourcePath, targetPath);
    ctx.savedImagePath = targetPath;
    console.log(`[UploadSaga] Saved preprocessed raw image: ${targetPath}`);

    const savedTextPath = await saver.save(saveInput);

    if (savedTextPath) {
      ctx.savedTextPath = savedTextPath;
      console.log(`[UploadSaga] Saved recognized content: ${savedTextPath}`);
    }
  };

  const cleanupStep = cleanupTempFiles;

  const postprocessStep = async (ctx: UploadContext): Promise<void> => {
    // Stub for post-processing
  };

  return [
    preprocessStep,
    ocrStep,
    classifyStep,
    identifyStep,
    cropEditorStep,
    recognizeStep,
    saveStep,
    cleanupStep,
    postprocessStep,
  ] as const;
}

export function createUploadSaga(
  jevService: JevService,
  visionClient: VisionClient | null,
  kbBaseDir: string
): SagaDefinition<UploadContext> {
  const [
    preprocessStep,
    ocrStep,
    classifyStep,
    identifyStep,
    cropEditorStep,
    recognizeStep,
    saveStep,
    cleanupStep,
    postprocessStep,
  ] = createSteps(jevService, visionClient, kbBaseDir);

  return {
    name: 'upload',
    steps: [
      { name: 'preprocess', execute: preprocessStep },
      { name: 'ocr', execute: ocrStep },
      { name: 'classify', execute: classifyStep },
      { name: 'identify', execute: identifyStep },
      { name: 'crop-editor', execute: cropEditorStep },
      { name: 'recognize', execute: recognizeStep },
      { name: 'save', execute: saveStep },
      { name: 'cleanup', execute: cleanupStep },
      { name: 'postprocess', execute: postprocessStep },
    ],
    onError: async (ctx, err, stepName) => {
      console.error(`[UploadSaga] Failed at step '${stepName}':`, err);
      await cleanupTempFiles(ctx);
    },
    onComplete: async (ctx) => {
      console.log(`[UploadSaga] Completed: ${ctx.originalName} -> ${ctx.category}${ctx.entityId ? ` (entityId: ${ctx.entityId.canonicalId})` : ''}`);
    },
  };
}
