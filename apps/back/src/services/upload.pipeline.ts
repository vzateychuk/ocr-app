import { SagaContext, SagaDefinition } from '../fsm/index.js';
import { JevService } from './jev.service.js';
import { VisionClient } from './vision-client.js';
import { runOcr } from '../utils/ocr.js';
import { preprocessForOcr } from '../utils/preprocess.js';
import { getIdentifier, sanitizeSlug, EntityId } from '../identifiers/index.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ImageCategory } from '../types/jev.types.js';

export interface UploadContext extends SagaContext {
  /** Original upload in tmp (deleted after save). */
  filePath: string;
  /** Preprocessed image: used by OCR, then persisted to raw/images. */
  ocrImagePath?: string;
  /** Cropped top strip for Vision (tab bar + breadcrumbs). */
  visionImagePath?: string;
  originalName: string;
  extractedText?: string;
  category?: ImageCategory;
  confidence?: number;
  probabilities?: Partial<Record<ImageCategory, number>>;
  /** Entity identifier from Vision (for ide_code and future categories). */
  entityId?: EntityId;
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

  const saveStep = async (ctx: UploadContext): Promise<void> => {
    const now = new Date();
    const timestamp = now.toISOString()
      .replace(/T/, '_')
      .replace(/\..+/, '')
      .replace(/:/g, '-');

    const sourcePath = ctx.ocrImagePath ?? ctx.filePath;

    let slug: string;
    if (ctx.entityId?.canonicalId) {
      slug = `${timestamp}_${sanitizeSlug(ctx.entityId.canonicalId)}`;
    } else {
      slug = `${timestamp}_${ctx.category ?? 'unknown'}`;
    }
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
    for (const tempPath of [ctx.filePath, ctx.ocrImagePath, ctx.visionImagePath]) {
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

  return [
    preprocessStep,
    ocrStep,
    classifyStep,
    identifyStep,
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
      { name: 'save', execute: saveStep },
      { name: 'cleanup', execute: cleanupStep },
      { name: 'postprocess', execute: postprocessStep },
    ],
    onError: async (ctx, err, stepName) => {
      console.error(`[UploadSaga] Failed at step '${stepName}':`, err);
    },
    onComplete: async (ctx) => {
      console.log(`[UploadSaga] Completed: ${ctx.originalName} -> ${ctx.category}${ctx.entityId ? ` (entityId: ${ctx.entityId.canonicalId})` : ''}`);
    },
  };
}