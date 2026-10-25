import { runSaga } from '../fsm/index.js';
import { createUploadSaga, UploadContext } from './upload.pipeline.js';
import { JevService } from './jev.service.js';
import { VisionClient } from './vision-client.js';
import type { UploadResult, ImageCategory } from '../types/jev.types.js';

export class UploadService {
  constructor(
    private readonly jevService: JevService,
    private readonly visionClient: VisionClient | null,
    private readonly kbBaseDir: string
  ) {}

  async process(filePath: string, originalName: string): Promise<UploadResult> {
    const saga = createUploadSaga(this.jevService, this.visionClient, this.kbBaseDir);

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
        entityId: ctx.entityId?.canonicalId,
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