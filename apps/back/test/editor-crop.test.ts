import test from 'node:test';
import assert from 'node:assert/strict';
import {
  findEditorCropBounds,
  parseTesseractTsv,
} from '../src/utils/editor-crop.js';

function tsvWords(
  words: Array<{
    left: number;
    top: number;
    width: number;
    height: number;
    text: string;
  }>
): string {
  const rows = words.map(
    ({ left, top, width, height, text }) =>
      `5\t1\t1\t1\t1\t1\t${left}\t${top}\t${width}\t${height}\t90\t${text}`
  );
  return [
    'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext',
    ...rows,
  ].join('\n');
}

function makePanelPixels(
  width: number,
  height: number,
  includeBottomDivider = true
): Buffer {
  const pixels = Buffer.alloc(width * height, 240);
  for (let y = 10; y < 80; y += 1) {
    pixels[y * width + 40] = 200;
  }
  for (const y of includeBottomDivider ? [10, 80] : [10]) {
    for (let x = 40; x < width; x += 1) {
      pixels[y * width + x] = 200;
    }
  }
  return pixels;
}

test('parses word bounding boxes from Tesseract TSV', () => {
  assert.deepEqual(
    parseTesseractTsv(
      tsvWords([
        { left: 44, top: 40, width: 7, height: 9, text: '245' },
      ])
    ),
    [
      {
        left: 44,
        top: 40,
        width: 7,
        height: 9,
        confidence: 90,
        text: '245',
      },
    ]
  );
});

test('keeps the full editor panel when Tesseract recognizes only some gutter rows', () => {
  const width = 120;
  const height = 100;
  const tsv = tsvWords([
    { left: 44, top: 40, width: 7, height: 8, text: '245' },
    { left: 44, top: 50, width: 7, height: 8, text: '246' },
    { left: 44, top: 60, width: 7, height: 8, text: '248' },
    { left: 75, top: 50, width: 6, height: 8, text: '12' },
    { left: 12, top: 50, width: 6, height: 8, text: '120' },
  ]);
  const bounds = findEditorCropBounds(
    tsv,
    makePanelPixels(width, height),
    width,
    height
  );

  assert.ok(bounds);
  assert.equal(bounds.left, 16);
  assert.equal(bounds.width, width - 16);
  assert.equal(bounds.gutterLinesFound, 3);
  assert.equal(bounds.top, 12);
  assert.equal(bounds.height, 71);
});

test('extends crop left of the divider to include recognized gutter numbers', () => {
  const width = 120;
  const height = 100;
  const bounds = findEditorCropBounds(
    tsvWords([
      { left: 24, top: 40, width: 7, height: 8, text: '245' },
      { left: 24, top: 50, width: 7, height: 8, text: '246' },
      { left: 24, top: 60, width: 7, height: 8, text: '247' },
    ]),
    makePanelPixels(width, height),
    width,
    height
  );

  assert.ok(bounds);
  assert.equal(bounds.left, 16);
  assert.equal(bounds.width, width - 16);
  assert.equal(bounds.gutterLinesFound, 3);
});

test('uses editor panel bounds when Tesseract cannot reliably detect gutter numbers', () => {
  const width = 120;
  const height = 100;
  const bounds = findEditorCropBounds(
    tsvWords([
      { left: 65, top: 50, width: 10, height: 8, text: 'identifier' },
    ]),
    makePanelPixels(width, height),
    width,
    height
  );

  assert.ok(bounds);
  assert.equal(bounds.left, 16);
  assert.equal(bounds.gutterLinesFound, 0);
  assert.equal(bounds.top, 12);
  assert.equal(bounds.height, 71);
});

test('uses a wide enough fallback margin for gutters on scaled screenshots', () => {
  const width = 1170;
  const height = 100;
  const pixels = Buffer.alloc(width * height, 240);
  for (let y = 10; y < 80; y += 1) {
    pixels[y * width + 200] = 200;
  }
  for (const y of [10, 80]) {
    for (let x = 40; x < width; x += 1) {
      pixels[y * width + x] = 200;
    }
  }

  const bounds = findEditorCropBounds(tsvWords([]), pixels, width, height);

  assert.ok(bounds);
  assert.equal(bounds.gutterLinesFound, 0);
  assert.equal(bounds.left, 12);
});

test('rejects numeric tokens that do not form regularly spaced rows', () => {
  const width = 120;
  const height = 100;
  const bounds = findEditorCropBounds(
    tsvWords([
      { left: 44, top: 40, width: 7, height: 8, text: '245' },
      { left: 44, top: 50, width: 7, height: 8, text: '246' },
      { left: 44, top: 66, width: 7, height: 8, text: '248' },
    ]),
    makePanelPixels(width, height),
    width,
    height
  );

  assert.ok(bounds);
  assert.equal(bounds.gutterLinesFound, 0);
  assert.equal(bounds.top, 12);
  assert.equal(bounds.height, 71);
});

test('ignores a highlighted code row and uses the lower terminal divider', () => {
  const width = 120;
  const height = 100;
  const pixels = makePanelPixels(width, height);
  for (let x = 40; x < width; x += 1) {
    pixels[55 * width + x] = 180;
  }

  const bounds = findEditorCropBounds(
    tsvWords([]),
    pixels,
    width,
    height
  );

  assert.ok(bounds);
  assert.equal(bounds.top, 12);
  assert.equal(bounds.height, 71);
});

test('does not cut off the lower image when no terminal divider is found', () => {
  const width = 120;
  const height = 100;
  const bounds = findEditorCropBounds(
    tsvWords([]),
    makePanelPixels(width, height, false),
    width,
    height
  );

  assert.ok(bounds);
  assert.equal(bounds.top, 12);
  assert.equal(bounds.height, height - bounds.top);
});
