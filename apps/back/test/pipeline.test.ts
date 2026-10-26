import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createUploadSaga, type UploadContext } from '../src/services/upload.pipeline.js';
import type { JevService } from '../src/services/jev.service.js';
import type { VisionClient } from '../src/services/vision-client.js';
import type { ImageCategory } from '../src/types/jev.types.js';

const FIXTURES = path.join(import.meta.dirname, 'fixtures');

async function withTempDir(
  run: (directory: string) => Promise<void>
): Promise<void> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-pipeline-'));
  try {
    await run(directory);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

function getStep(saga: ReturnType<typeof createUploadSaga>, name: string) {
  const step = saga.steps.find((candidate) => candidate.name === name);
  if (!step) {
    throw new Error(`Missing step ${name}`);
  }
  return step;
}

function createContext(filePath: string): UploadContext {
  return {
    sagaName: 'upload',
    startedAt: new Date(),
    metadata: {},
    filePath,
    originalName: 'screenshot.png',
  };
}

function fakeJev(
  category: ImageCategory,
  seenTexts: string[] = []
): JevService {
  return {
    async getCategory(text: string) {
      seenTexts.push(text);
      return { category, confidence: 1 };
    },
  } as unknown as JevService;
}

function fakeVision(
  handler: (input: {
    imageBuffer: Buffer;
    prompt: string;
  }) => Promise<string>
): VisionClient {
  return { completeVision: handler };
}

async function listFiles(directory: string): Promise<string[]> {
  try {
    return (await fs.readdir(directory)).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

test('runs recognize after identify and before save', () => {
  const saga = createUploadSaga(
    fakeJev('jira_issue'),
    fakeVision(async () => '{}'),
    '/tmp/kb'
  );

  assert.deepEqual(
    saga.steps.map((step) => step.name),
    [
      'preprocess',
      'ocr',
      'classify',
      'identify',
      'recognize',
      'save',
      'cleanup',
      'postprocess',
    ]
  );
});

test('cleans temporary upload images after pipeline errors without deleting persisted images', async () => {
  await withTempDir(async (directory) => {
    const filePath = path.join(directory, 'tmp', 'upload.png');
    const ocrImagePath = path.join(directory, 'tmp', 'upload.ocr.png');
    const visionImagePath = path.join(directory, 'tmp', 'upload.vision.png');
    const savedImagePath = path.join(
      directory,
      'raw',
      'images',
      'persisted.png'
    );
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.mkdir(path.dirname(savedImagePath), { recursive: true });
    await Promise.all(
      [filePath, ocrImagePath, visionImagePath, savedImagePath].map((file) =>
        fs.writeFile(file, 'image')
      )
    );

    const saga = createUploadSaga(fakeJev('ide_code'), null, directory);
    const ctx = createContext(filePath);
    ctx.ocrImagePath = ocrImagePath;
    ctx.visionImagePath = visionImagePath;

    await saga.onError?.(ctx, new Error('recognition failed'), 'recognize');

    for (const tempPath of [filePath, ocrImagePath, visionImagePath]) {
      await assert.rejects(fs.access(tempPath), { code: 'ENOENT' });
    }
    await fs.access(savedImagePath);
  });
});

test('identify gets the top crop, recognize gets the full preprocessed image', async () => {
  await withTempDir(async (directory) => {
    const inputPath = path.join(directory, 'source.png');
    await fs.copyFile(path.join(FIXTURES, 'code-13.png'), inputPath);

    const calls: Array<{ imageBuffer: Buffer; prompt: string }> = [];
    const vision = fakeVision(async (input) => {
      calls.push({ imageBuffer: Buffer.from(input.imageBuffer), prompt: input.prompt });
      if (input.prompt.includes('Верни каждую видимую строку кода')) {
        return 'L00029|I00|first recognized line\nL00030|I01|second line';
      }
      return JSON.stringify({
        tab_filename: 'demo.py',
        breadcrumb_path: 'src > app',
      });
    });

    const saga = createUploadSaga(fakeJev('ide_code'), vision, directory);
    const ctx = createContext(inputPath);

    await getStep(saga, 'preprocess').execute(ctx);
    ctx.category = 'ide_code';
    await getStep(saga, 'identify').execute(ctx);
    await getStep(saga, 'recognize').execute(ctx);

    assert.ok(ctx.visionImagePath);
    assert.ok(ctx.ocrImagePath);
    assert.equal(ctx.entityId?.canonicalId, 'src/app/demo.py');
    assert.deepEqual(ctx.recognizedLines, [
      { lineNumber: 28, text: 'first recognized line' },
      { lineNumber: 29, text: '    second line' },
    ]);

    const identifyCall = calls.find((call) =>
      call.prompt.includes('АКТИВНОЙ вкладке')
    );
    const recognizeCall = calls.find((call) =>
      call.prompt.includes('Верни каждую видимую строку кода')
    );

    assert.ok(identifyCall);
    assert.ok(recognizeCall);
    assert.ok(
      identifyCall.imageBuffer.equals(await fs.readFile(ctx.visionImagePath))
    );
    assert.ok(
      recognizeCall.imageBuffer.equals(await fs.readFile(ctx.ocrImagePath))
    );
    assert.ok(recognizeCall.imageBuffer.length > identifyCall.imageBuffer.length);
  });
});

test('Jev classifies the Tesseract text while the saver receives only Vision text', async () => {
  await withTempDir(async (directory) => {
    const sourcePath = path.join(directory, 'preprocessed.png');
    await fs.writeFile(sourcePath, 'image-bytes');

    const seenTexts: string[] = [];
    const saga = createUploadSaga(
      fakeJev('jira_issue', seenTexts),
      null,
      directory
    );
    const ctx = createContext(sourcePath);
    ctx.ocrImagePath = sourcePath;
    ctx.extractedText = 'TESSERACT CLASSIFIER INPUT';
    ctx.recognizedText = 'VISION CONTENT\nsecond line';

    await getStep(saga, 'classify').execute(ctx);
    await getStep(saga, 'save').execute(ctx);

    assert.deepEqual(seenTexts, ['TESSERACT CLASSIFIER INPUT']);
    assert.equal(ctx.category, 'jira_issue');
    assert.ok(ctx.savedImagePath);

    const ocrFiles = await listFiles(path.join(directory, 'raw', 'ocr'));
    assert.equal(ocrFiles.length, 1);
    const markdown = await fs.readFile(
      path.join(directory, 'raw', 'ocr', ocrFiles[0]!),
      'utf8'
    );
    assert.equal(markdown, 'VISION CONTENT\nsecond line');
    assert.ok(!markdown.includes('TESSERACT'));
  });
});

test('save always persists the image and selects the saver by category', async () => {
  await withTempDir(async (directory) => {
    const sourcePath = path.join(directory, 'preprocessed.png');
    await fs.writeFile(sourcePath, 'image-bytes');

    const saga = createUploadSaga(fakeJev('ide_code'), null, directory);
    const ctx = createContext(sourcePath);
    ctx.ocrImagePath = sourcePath;
    ctx.category = 'ide_code';
    ctx.entityId = {
      canonicalId: 'src/common/utils/maven/dependency_list.py',
      components: {},
    };
    ctx.recognizedText = 'ignored full text';
    ctx.recognizedLines = [
      { lineNumber: 28, text: 'print("vision")' },
      { lineNumber: 29, text: '' },
    ];

    await getStep(saga, 'save').execute(ctx);

    assert.ok(ctx.savedImagePath);
    assert.equal(
      path.basename(ctx.savedImagePath),
      'src_common_utils_maven_dependency_list.py_L29-L30.png'
    );
    assert.ok(ctx.savedImagePath.startsWith(path.join(directory, 'raw', 'images')));
    assert.equal(await fs.readFile(ctx.savedImagePath, 'utf8'), 'image-bytes');
    assert.equal(
      await fs.readFile(
        path.join(
          directory,
          'raw',
          'code',
          'src',
          'common',
          'utils',
          'maven',
          'dependency_list.py'
        ),
        'utf8'
      ),
      '\n'.repeat(28) + 'print("vision")\n\n'
    );
    assert.deepEqual(await listFiles(path.join(directory, 'raw', 'ocr')), []);
  });
});

test('ide_code image names use the recognized range and overwrite duplicate ranges', async () => {
  await withTempDir(async (directory) => {
    const firstImagePath = path.join(directory, 'first.png');
    const secondImagePath = path.join(directory, 'second.png');
    await fs.writeFile(firstImagePath, 'first image');
    await fs.writeFile(secondImagePath, 'replacement image');

    const saga = createUploadSaga(fakeJev('ide_code'), null, directory);
    const firstContext = createContext(firstImagePath);
    firstContext.ocrImagePath = firstImagePath;
    firstContext.category = 'ide_code';
    firstContext.entityId = {
      canonicalId: 'src/common/models.py',
      components: {},
    };
    firstContext.recognizedLines = [
      { lineNumber: 244, text: 'first' },
      { lineNumber: 363, text: 'last' },
    ];

    await getStep(saga, 'save').execute(firstContext);

    const secondContext = createContext(secondImagePath);
    secondContext.ocrImagePath = secondImagePath;
    secondContext.category = 'ide_code';
    secondContext.entityId = firstContext.entityId;
    secondContext.recognizedLines = firstContext.recognizedLines;

    await getStep(saga, 'save').execute(secondContext);

    assert.equal(
      path.basename(firstContext.savedImagePath!),
      'src_common_models.py_L245-L364.png'
    );
    assert.equal(secondContext.savedImagePath, firstContext.savedImagePath);
    assert.equal(
      await fs.readFile(secondContext.savedImagePath!, 'utf8'),
      'replacement image'
    );
    assert.deepEqual(
      await listFiles(path.join(directory, 'raw', 'images')),
      ['src_common_models.py_L245-L364.png']
    );
  });
});

test('ide_code without canonicalId still saves the image but no recognized content', async () => {
  await withTempDir(async (directory) => {
    const sourcePath = path.join(directory, 'preprocessed.png');
    await fs.writeFile(sourcePath, 'image-bytes');

    const saga = createUploadSaga(fakeJev('ide_code'), null, directory);
    const ctx = createContext(sourcePath);
    ctx.ocrImagePath = sourcePath;
    ctx.category = 'ide_code';
    ctx.recognizedText = 'should not be written anywhere';
    ctx.recognizedLines = [{ lineNumber: 0, text: 'code' }];

    await getStep(saga, 'save').execute(ctx);

    assert.ok(ctx.savedImagePath);
    await fs.access(ctx.savedImagePath);
    assert.deepEqual(await listFiles(path.join(directory, 'raw', 'code')), []);
    assert.deepEqual(await listFiles(path.join(directory, 'raw', 'ocr')), []);
  });
});

test('does not use Tesseract as a fallback when Vision is unavailable', async () => {
  await withTempDir(async (directory) => {
    const sourcePath = path.join(directory, 'preprocessed.png');
    await fs.writeFile(sourcePath, 'image-bytes');

    const saga = createUploadSaga(fakeJev('jira_issue'), null, directory);
    const ctx = createContext(sourcePath);
    ctx.ocrImagePath = sourcePath;
    ctx.category = 'jira_issue';
    ctx.extractedText = 'TESSERACT TEXT MUST NOT BE SAVED';

    await getStep(saga, 'recognize').execute(ctx);
    await getStep(saga, 'save').execute(ctx);

    assert.equal(ctx.recognizedText, undefined);
    assert.ok(ctx.savedImagePath);
    await fs.access(ctx.savedImagePath);
    assert.deepEqual(await listFiles(path.join(directory, 'raw', 'ocr')), []);
  });
});

test('saver write errors propagate after the image has been persisted', async () => {
  await withTempDir(async (directory) => {
    const sourcePath = path.join(directory, 'preprocessed.png');
    await fs.writeFile(sourcePath, 'image-bytes');
    await fs.mkdir(path.join(directory, 'raw'), { recursive: true });
    await fs.writeFile(
      path.join(directory, 'raw', 'ocr'),
      'blocks the ocr directory'
    );

    const saga = createUploadSaga(fakeJev('jira_issue'), null, directory);
    const ctx = createContext(sourcePath);
    ctx.ocrImagePath = sourcePath;
    ctx.category = 'jira_issue';
    ctx.recognizedText = 'recognized content';

    await assert.rejects(getStep(saga, 'save').execute(ctx));
    assert.ok(ctx.savedImagePath);
    await fs.access(ctx.savedImagePath);
  });
});

test('recognize failure is explicit and does not set a recognized result', async () => {
  await withTempDir(async (directory) => {
    const sourcePath = path.join(directory, 'preprocessed.png');
    await fs.writeFile(sourcePath, 'image-bytes');

    const saga = createUploadSaga(
      fakeJev('ide_code'),
      fakeVision(async () => {
        throw new Error('vision unavailable');
      }),
      directory
    );
    const ctx = createContext(sourcePath);
    ctx.ocrImagePath = sourcePath;
    ctx.category = 'ide_code';
    ctx.extractedText = 'TESSERACT TEXT';

    await assert.rejects(
      getStep(saga, 'recognize').execute(ctx),
      /vision unavailable/
    );
    assert.equal(ctx.recognizedText, undefined);
    assert.equal(ctx.recognizedLines, undefined);
  });
});

test('recognize rejects an unparseable Vision response without falling back to OCR', async () => {
  await withTempDir(async (directory) => {
    const sourcePath = path.join(directory, 'preprocessed.png');
    await fs.writeFile(sourcePath, 'image-bytes');

    const saga = createUploadSaga(
      fakeJev('jira_issue'),
      fakeVision(async () => 'not json'),
      directory
    );
    const ctx = createContext(sourcePath);
    ctx.ocrImagePath = sourcePath;
    ctx.category = 'jira_issue';
    ctx.extractedText = 'TESSERACT TEXT';

    await assert.rejects(
      getStep(saga, 'recognize').execute(ctx),
      /no usable result/
    );
    assert.equal(ctx.recognizedText, undefined);
  });
});
