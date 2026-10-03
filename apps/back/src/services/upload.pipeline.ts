import { SagaContext, SagaDefinition } from '../fsm/index.js';
import { JevService } from './jev.service.js';
import { runOcr } from '../utils/ocr.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ImageCategory } from '../types/jev.types.js';

export interface UploadContext extends SagaContext {
  filePath: string;
  originalName: string;
  extractedText?: string;
  category?: ImageCategory;
  confidence?: number;
  probabilities?: Partial<Record<ImageCategory, number>>;
  savedImagePath?: string;
}

const WIKI_IMAGES_SUBDIR = process.env.WIKI_IMAGES_SUBDIR || 'raw/images';

function createSteps(jevService: JevService, wikiBaseDir: string) {
  const preprocessStep = async (ctx: UploadContext): Promise<void> => {
    // Stub for pre-processing
    
  };

  const ocrStep = async (ctx: UploadContext): Promise<void> => {
    ctx.extractedText = await runOcr(ctx.filePath);
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

    const extension = path.extname(ctx.originalName) || '.png';
    const slug = `${timestamp}_${ctx.category}`;
    const fileName = `${slug}${extension}`;

    const targetDir = path.join(wikiBaseDir, WIKI_IMAGES_SUBDIR);
    await fs.mkdir(targetDir, { recursive: true });

    const targetPath = path.join(targetDir, fileName);
    await fs.copyFile(ctx.filePath, targetPath);

    ctx.savedImagePath = targetPath;
  };

  const cleanupStep = async (ctx: UploadContext): Promise<void> => {
    try {
      await fs.unlink(ctx.filePath);
      console.log(`[UploadSaga] Cleaned up temp file: ${ctx.filePath}`);
    } catch (err) {
      console.warn(`[UploadSaga] Failed to cleanup temp file ${ctx.filePath}:`, err);
    }
  };  

  const postprocessStep = async (ctx: UploadContext): Promise<void> => {
    // Stub for post-processing
  };

  return [preprocessStep, ocrStep, classifyStep, saveStep, cleanupStep, postprocessStep] as const;
}

export function createUploadSaga(
  jevService: JevService,
  wikiBaseDir: string
): SagaDefinition<UploadContext> {
  const [preprocessStep, ocrStep, classifyStep, saveStep, cleanupStep, postprocessStep] = createSteps(jevService, wikiBaseDir);

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