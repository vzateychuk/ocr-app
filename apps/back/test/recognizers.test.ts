import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DefaultRecognizer,
  IdeCodeRecognizer,
  defaultRecognizer,
  getRecognizer,
} from '../src/recognizers/index.js';
import {
  parseCodeRecognition,
  parseDefaultRecognition,
} from '../src/recognizers/index.js';
import type { VisionClient } from '../src/services/vision-client.js';

function fakeVision(response: string, prompts: string[] = []): VisionClient {
  return {
    async completeVision(input) {
      prompts.push(input.prompt);
      return response;
    },
  };
}

test('selects IdeCodeRecognizer for ide_code and default recognizer otherwise', () => {
  assert.ok(getRecognizer('ide_code') instanceof IdeCodeRecognizer);
  assert.equal(getRecognizer('jira_issue'), defaultRecognizer);
  assert.equal(getRecognizer('unknown'), defaultRecognizer);
});

test('default recognizer returns the full document text unchanged', async () => {
  const text = 'line one\n\n    indented  text\nline four';
  const recognizer = new DefaultRecognizer();
  const result = await recognizer.recognize(
    Buffer.from('image'),
    fakeVision(JSON.stringify({ text }))
  );

  assert.deepEqual(result, { text, lines: [] });
});

test('default recognizer returns undefined for malformed or empty responses', async () => {
  const recognizer = new DefaultRecognizer();

  assert.equal(
    await recognizer.recognize(Buffer.from('image'), fakeVision('not json')),
    undefined
  );
  assert.equal(
    await recognizer.recognize(
      Buffer.from('image'),
      fakeVision(JSON.stringify({ text: '   ' }))
    ),
    undefined
  );
});

test('code recognition converts 1-based gutter numbers to zero-based indexes', () => {
  const result = parseCodeRecognition(
    [
      'L00029|I00|old 29 replacement',
      'L00030|I00|',
      'L00031|I02|indented  exactly',
    ].join('\n')
  );

  assert.ok(result);
  assert.deepEqual(result.lines, [
    { lineNumber: 28, text: 'old 29 replacement' },
    { lineNumber: 29, text: '' },
    { lineNumber: 30, text: '        indented  exactly' },
  ]);
  assert.equal(
    result.text,
    'old 29 replacement\n\n        indented  exactly'
  );
});

test('code recognition skips lines without a valid source-line prefix', () => {
  const result = parseCodeRecognition(
    [
      'L00010|I00|known',
      'unprefixed line',
      'L00000|I00|zero is not a valid source line',
      'Lxxxxx|I00|invalid number',
      'L00011|missing indentation metadata',
    ].join('\n')
  );

  assert.ok(result);
  assert.deepEqual(result.lines, [{ lineNumber: 9, text: 'known' }]);
});

test('code recognition preserves quotes, separators, indentation and trailing spaces', () => {
  const result = parseCodeRecognition(
    'L00001|I01|value = "quoted" + \'single\'  | tail   \nL00002|I00|'
  );

  assert.ok(result);
  assert.deepEqual(result.lines, [
    { lineNumber: 0, text: '    value = "quoted" + \'single\'  | tail   ' },
    { lineNumber: 1, text: '' },
  ]);
});

test('code recognition restores nested Python indentation levels', () => {
  const result = parseCodeRecognition(
    [
      'L00364|I02|out["spring-boot"].append(ver)',
      'L00365|I02|elif pid.startswith("org.springframework"):',
      'L00368|I02|for alias in raw.get("libraries", {}):',
      'L00369|I03|lib = catalog.get_library_by_alias(alias)',
      'L00370|I03|if not lib:',
      'L00371|I04|continue',
    ].join('\n')
  );

  assert.ok(result);
  assert.deepEqual(
    result.lines.map((line) => line.text),
    [
      '        out["spring-boot"].append(ver)',
      '        elif pid.startswith("org.springframework"):',
      '        for alias in raw.get("libraries", {}):',
      '            lib = catalog.get_library_by_alias(alias)',
      '            if not lib:',
      '                continue',
    ]
  );
});

test('code recognition ignores markdown fences and non-prefixed lines', () => {
  const result = parseCodeRecognition(
    '```text\nL00024|I01|code line\nmodel note\n```'
  );

  assert.ok(result);
  assert.deepEqual(result.lines, [{ lineNumber: 23, text: '    code line' }]);
});

test('code recognizer rejects responses without numbered lines', async () => {
  const recognizer = new IdeCodeRecognizer();
  assert.equal(
    await recognizer.recognize(
      Buffer.from('image'),
      fakeVision('response without any numbered lines')
    ),
    undefined
  );
});

test('parseDefaultRecognition preserves text exactly', () => {
  const text = '  leading\n\ntrailing spaces   ';
  assert.deepEqual(parseDefaultRecognition(JSON.stringify({ text })), {
    text,
    lines: [],
  });
});
