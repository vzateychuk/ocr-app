#!/usr/bin/env node
/**
 * Generate manifest.json for test fixtures.
 * Groups screenshots by logical file based on filename prefix.
 * Run: node apps/back/test/generate-manifest.js
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURES_DIR = path.join(__dirname, 'fixtures');
const MANIFEST_PATH = path.join(FIXTURES_DIR, 'manifest.json');

async function generateManifest() {
  const files = await fs.readdir(FIXTURES_DIR);
  const pngFiles = files
    .filter((f) => f.endsWith('.png'))
    .sort();

  // Group by prefix before first '-code-' or similar pattern
  const groups = new Map();

  for (const file of pngFiles) {
    // Try to extract group key from filename
    // Pattern: c175021a-3284-code-01.png -> group "c175021a-3284"
    // Pattern: code-10.png -> group "code"
    let groupKey = 'unknown';
    const codeMatch = file.match(/^(.+?)-code-\d+/);
    if (codeMatch) {
      groupKey = codeMatch[1];
    } else {
      const simpleMatch = file.match(/^(.+?)-\d+\.png$/);
      if (simpleMatch) {
        groupKey = simpleMatch[1];
      } else {
        groupKey = file.replace('.png', '');
      }
    }

    if (!groups.has(groupKey)) {
      groups.set(groupKey, []);
    }
    groups.get(groupKey).push(file);
  }

  const manifest = [];
  let groupIndex = 0;

  for (const [groupKey, files] of groups) {
    groupIndex++;
    const groupLabel = String.fromCharCode(65 + (groupIndex - 1)); // A, B, C...

    // Expected entityId - user needs to fill this in based on actual screenshots
    const expectedEntityId = `TODO: fill expected entityId for group ${groupLabel} (${groupKey})`;

    manifest.push({
      group: groupLabel,
      expectedEntityId,
      files,
    });
  }

  await fs.writeFile(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
  console.log(`Manifest written to ${MANIFEST_PATH}`);
  console.log('Please edit manifest.json to fill in expectedEntityId for each group.');
}

generateManifest().catch((err) => {
  console.error('Failed to generate manifest:', err);
  process.exit(1);
});