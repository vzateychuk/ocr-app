import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  DefaultSaver,
  IdeCodeSaver,
  defaultSaver,
  getSaver,
} from '../src/savers/index.js';
import type { SaveRecognizedContentInput } from '../src/savers/index.js';
import type { RecognizedLine } from '../src/recognizers/index.js';

const FIXED_DATE = new Date('2026-10-26T12:34:56.000Z');

async function withTempDir(
  run: (directory: string) => Promise<void>
): Promise<void> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-savers-'));
  try {
    await run(directory);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

function defaultInput(
  kbBaseDir: string,
  overrides: Partial<SaveRecognizedContentInput> = {}
): SaveRecognizedContentInput {
  return {
    kbBaseDir,
    category: 'jira_issue',
    originalName: 'Screen Shot.png',
    extractedText: 'recognized text\nsecond line',
    timestamp: FIXED_DATE,
    ...overrides,
  };
}

function ideInput(
  kbBaseDir: string,
  lines: RecognizedLine[],
  canonicalId = 'src/common/utils/maven/dependency_list.py'
): SaveRecognizedContentInput {
  return {
    kbBaseDir,
    category: 'ide_code',
    originalName: 'screenshot.png',
    extractedText: 'ignored for ide_code',
    timestamp: FIXED_DATE,
    entityId: {
      canonicalId,
      components: {},
    },
    lines,
  };
}

function splitFileContent(content: string): string[] {
  const lines = content.split('\n');
  if (lines.at(-1) === '') {
    lines.pop();
  }
  return lines;
}

test('selects IdeCodeSaver for ide_code and DefaultSaver for other categories', () => {
  assert.ok(getSaver('ide_code') instanceof IdeCodeSaver);
  assert.equal(getSaver('jira_issue'), defaultSaver);
  assert.equal(getSaver('unknown'), defaultSaver);
});

test('DefaultSaver owns the timestamped image filename rule', () => {
  const saver = new DefaultSaver();

  assert.equal(
    saver.getImageFileName(defaultInput('/tmp/kb')),
    '2026-10-26_12-34-56_jira_issue.png'
  );
  assert.equal(
    saver.getImageFileName(
      defaultInput('/tmp/kb', {
        entityId: { canonicalId: 'src/common/file.py', components: {} },
      })
    ),
    '2026-10-26_12-34-56_src_common_file.py.png'
  );
});

test('IdeCodeSaver owns the entity and recognized range image filename rule', () => {
  const saver = new IdeCodeSaver();
  const input = ideInput('/tmp/kb', [
    { lineNumber: 244, text: 'first' },
    { lineNumber: 363, text: 'last' },
  ]);

  assert.equal(
    saver.getImageFileName(input),
    'src_common_utils_maven_dependency_list.py_L245-L364.png'
  );
});

test('DefaultSaver writes Markdown under raw/ocr without overwriting', async () => {
  await withTempDir(async (directory) => {
    const saver = new DefaultSaver();
    const firstPath = await saver.save(defaultInput(directory));
    const secondPath = await saver.save(defaultInput(directory));

    assert.ok(firstPath);
    assert.ok(secondPath);
    assert.equal(
      firstPath,
      path.join(
        directory,
        'raw',
        'ocr',
        '2026-10-26_12-34-56_screen_shot.md'
      )
    );
    assert.equal(
      secondPath,
      path.join(
        directory,
        'raw',
        'ocr',
        '2026-10-26_12-34-56_screen_shot_1.md'
      )
    );
    assert.equal(
      await fs.readFile(firstPath, 'utf8'),
      'recognized text\nsecond line'
    );
    assert.equal(
      await fs.readFile(secondPath, 'utf8'),
      'recognized text\nsecond line'
    );
  });
});

test('IdeCodeSaver creates nested directories from canonicalId', async () => {
  await withTempDir(async (directory) => {
    const saver = new IdeCodeSaver();
    const savedPath = await saver.save(
      ideInput(directory, [{ lineNumber: 0, text: 'print("hello")' }])
    );

    assert.ok(savedPath);
    assert.equal(
      savedPath,
      path.join(
        directory,
        'raw',
        'code',
        'src',
        'common',
        'utils',
        'maven',
        'dependency_list.py'
      )
    );
    assert.equal(await fs.readFile(savedPath, 'utf8'), 'print("hello")\n');
  });
});

test('IdeCodeSaver merges overlapping ranges and preserves lines outside them', async () => {
  await withTempDir(async (directory) => {
    const saver = new IdeCodeSaver();

    const oldLines: RecognizedLine[] = Array.from(
      { length: 32 },
      (_, index) => ({
        lineNumber: index,
        text: `old ${index}`,
      })
    );
    await saver.save(ideInput(directory, oldLines));

    const newLines: RecognizedLine[] = Array.from(
      { length: 32 },
      (_, index) => ({
        lineNumber: index + 29,
        text: `new ${index + 29}`,
      })
    );
    const savedPath = await saver.save(ideInput(directory, newLines));

    assert.ok(savedPath);
    const lines = splitFileContent(await fs.readFile(savedPath, 'utf8'));

    assert.equal(lines.length, 61);
    for (let index = 0; index <= 28; index += 1) {
      assert.equal(lines[index], `old ${index}`);
    }
    for (let index = 29; index <= 60; index += 1) {
      assert.equal(lines[index], `new ${index}`);
    }
  });
});

test('IdeCodeSaver uses zero-based source line numbers without shifting', async () => {
  await withTempDir(async (directory) => {
    const saver = new IdeCodeSaver();
    const existingLines: RecognizedLine[] = Array.from(
      { length: 10 },
      (_, index) => ({
        lineNumber: index,
        text: `old ${index}`,
      })
    );
    await saver.save(ideInput(directory, existingLines));

    const savedPath = await saver.save(
      ideInput(directory, [
        { lineNumber: 3, text: 'new four' },
        { lineNumber: 4, text: '' },
        { lineNumber: 5, text: '    new six' },
      ])
    );

    assert.ok(savedPath);
    const lines = splitFileContent(await fs.readFile(savedPath, 'utf8'));

    assert.deepEqual(lines, [
      'old 0',
      'old 1',
      'old 2',
      'new four',
      '',
      '    new six',
      'old 6',
      'old 7',
      'old 8',
      'old 9',
    ]);
  });
});

test('IdeCodeSaver preserves blank lines, whitespace and exact text', async () => {
  await withTempDir(async (directory) => {
    const saver = new IdeCodeSaver();
    const savedPath = await saver.save(
      ideInput(directory, [
        { lineNumber: 0, text: 'line zero' },
        { lineNumber: 1, text: '' },
        { lineNumber: 2, text: '    x  =  1' },
        { lineNumber: 3, text: '   ' },
        { lineNumber: 5, text: 'last' },
      ])
    );

    assert.ok(savedPath);
    assert.deepEqual(
      splitFileContent(await fs.readFile(savedPath, 'utf8')),
      ['line zero', '', '    x  =  1', '   ', '', 'last']
    );
  });
});

test('IdeCodeSaver ignores unnumbered lines instead of guessing their position', async () => {
  await withTempDir(async (directory) => {
    const saver = new IdeCodeSaver();
    const savedPath = await saver.save(
      ideInput(directory, [
        { lineNumber: 2, text: 'numbered' },
        { text: 'number is unreadable' },
      ])
    );

    assert.ok(savedPath);
    assert.deepEqual(
      splitFileContent(await fs.readFile(savedPath, 'utf8')),
      ['', '', 'numbered']
    );
  });
});

test('IdeCodeSaver does not save without a valid canonicalId', async () => {
  await withTempDir(async (directory) => {
    const withoutEntityId = await getSaver('ide_code').save({
      ...ideInput(directory, [{ lineNumber: 0, text: 'code' }]),
      entityId: undefined,
    });
    const withEmptyId = await getSaver('ide_code').save(
      ideInput(directory, [{ lineNumber: 0, text: 'code' }], '')
    );

    assert.equal(withoutEntityId, undefined);
    assert.equal(withEmptyId, undefined);
    await assert.rejects(fs.access(path.join(directory, 'raw')));
  });
});

test('IdeCodeSaver does not save when recognition has no line numbers', async () => {
  await withTempDir(async (directory) => {
    const savedPath = await new IdeCodeSaver().save(
      ideInput(directory, [{ text: 'no gutter number' }])
    );

    assert.equal(savedPath, undefined);
    await assert.rejects(fs.access(path.join(directory, 'raw')));
  });
});

test('non-ide categories never write under raw/code', async () => {
  await withTempDir(async (directory) => {
    const savedPath = await getSaver('jira_issue').save(defaultInput(directory));

    assert.ok(savedPath);
    await assert.rejects(fs.access(path.join(directory, 'raw', 'code')));
    await fs.access(path.join(directory, 'raw', 'ocr'));
  });
});

test('IdeCodeSaver rejects unsafe canonicalId values', async () => {
  await withTempDir(async (directory) => {
    const saver = new IdeCodeSaver();
    const unsafeIds = [
      '../escape.py',
      '/tmp/escape.py',
      'src/../../escape.py',
      '..\\escape.py',
      'C:\\tmp\\escape.py',
      'C:/tmp/escape.py',
      'src/\0escape.py',
    ];

    for (const canonicalId of unsafeIds) {
      assert.equal(
        await saver.save(
          ideInput(directory, [{ lineNumber: 0, text: 'x' }], canonicalId)
        ),
        undefined
      );
    }

    await assert.rejects(fs.access(path.join(directory, 'raw', 'code')));
  });
});

test('DefaultSaver propagates file-system write errors', async () => {
  await withTempDir(async (directory) => {
    await fs.mkdir(path.join(directory, 'raw'), { recursive: true });
    await fs.writeFile(
      path.join(directory, 'raw', 'ocr'),
      'blocks directory creation'
    );

    await assert.rejects(
      new DefaultSaver().save(defaultInput(directory))
    );
  });
});

test('IdeCodeSaver propagates file-system write errors', async () => {
  await withTempDir(async (directory) => {
    const codeDirectory = path.join(directory, 'raw', 'code');
    await fs.mkdir(codeDirectory, { recursive: true });
    await fs.writeFile(path.join(codeDirectory, 'src'), 'blocks directory');

    await assert.rejects(
      new IdeCodeSaver().save(
        ideInput(directory, [{ lineNumber: 0, text: 'x' }], 'src/file.py')
      )
    );
  });
});
