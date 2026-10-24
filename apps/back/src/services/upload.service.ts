import { runSaga } from '../fsm/index.js';
import { createUploadSaga, UploadContext } from './upload.pipeline.js';
import { JevService } from './jev.service.js';
import type { UploadResult, ImageCategory } from '../types/jev.types.js';

export class UploadService {
  constructor(
    private readonly jevService: JevService,
    private readonly kbBaseDir: string
  ) {}

  async process(filePath: string, originalName: string): Promise<UploadResult> {
    const saga = createUploadSaga(this.jevService, this.kbBaseDir);

    try {
      const ctx = await runSaga<UploadContext>(saga, {
        filePath,
        originalName,
      });

      return {
        success: true,
        originalName,
        savedImagePath: ctx.savedImagePath!,
        category: ctx.category!,
        confidence: ctx.confidence,
        probabilities: ctx.probabilities,
      };
    } catch (error: unknown) {
      return {
        success: false,
        originalName,
        error: error instanceof Error ? error.message : 'Unknown error during upload',
      };
    }
  }
}