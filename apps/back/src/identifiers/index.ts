import { VisionClient } from '../services/vision-client.js';
import fs from 'node:fs/promises';
import { ImageCategory } from '../types/jev.types.js';

export interface EntityId {
  canonicalId: string;
  components: {
    tabFilename?: string;
    breadcrumbPath?: string;
  };
}

export interface Identifier {
  category: ImageCategory;
  identify(imageBuffer: Buffer, visionClient: VisionClient): Promise<EntityId | undefined>;
}

const IDE_CODE_PROMPT = `Ты видишь верхнюю часть скриншота IDE (вкладки и breadcrumbs).

Найди:
1. Имя файла на АКТИВНОЙ вкладке (подсвечена / выбрана).
2. Путь в breadcrumbs с разделителями ">": ТОЛЬКО сегменты пути к файлу ДО имени файла.
   НЕ включай имя файла, имя класса, функции или символа после файла.

Правила:
- Верни ТОЛЬКО один JSON-объект, без markdown и без пояснений.
- Если поле не удалось уверенно прочитать — поставь null.
- Не выдумывай сегменты пути.

Схема:
{
  "tab_filename": "lib_maven.py",
  "breadcrumb_path": "src > common > analysers > library"
}`;

interface VisionResponse {
  tab_filename: string | null;
  breadcrumb_path: string | null;
}

function parseVisionResponse(text: string): VisionResponse | null {
  try {
    const cleaned = text.replace(/^```json\s*/, '').replace(/\s*```$/, '').trim();
    const parsed = JSON.parse(cleaned);
    if (typeof parsed !== 'object' || parsed === null) {
      return null;
    }
    return {
      tab_filename: typeof parsed.tab_filename === 'string' ? parsed.tab_filename : null,
      breadcrumb_path: typeof parsed.breadcrumb_path === 'string' ? parsed.breadcrumb_path : null,
    };
  } catch {
    return null;
  }
}

function buildCanonicalId(tabFilename: string | null, breadcrumbPath: string | null): string | undefined {
  const tab = tabFilename?.trim() || '';
  const crumbs = breadcrumbPath?.trim() || '';

  if (!tab && !crumbs) {
    return undefined;
  }

  const segments = crumbs
    .split('>')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  // Remove duplicate of tab filename from breadcrumbs if present (case-insensitive)
  if (tab && segments.length > 0) {
    const lastSegment = segments[segments.length - 1];
    if (lastSegment.toLowerCase() === tab.toLowerCase()) {
      segments.pop();
    }
  }

  let canonicalId: string;
  if (segments.length > 0 && tab) {
    canonicalId = [...segments, tab].join('/');
  } else if (tab) {
    canonicalId = tab;
  } else if (segments.length > 0) {
    canonicalId = segments.join('/');
  } else {
    return undefined;
  }

  // Normalize path: collapse double slashes, trim leading/trailing
  return canonicalId.replace(/\/+/g, '/').replace(/^\/+|\/+$/g, '');
}

function sanitizeSlug(canonicalId: string): string {
  return canonicalId
    .toLowerCase()
    .replace(/\//g, '_')
    .replace(/[^a-z0-9._-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

export class IdeCodeIdentifier implements Identifier {
  category = 'ide_code' as const;

  async identify(imageBuffer: Buffer, visionClient: VisionClient): Promise<EntityId | undefined> {
    try {
      const rawResponse = await visionClient.completeVision({
        imageBuffer,
        prompt: IDE_CODE_PROMPT,
      });

      const parsed = parseVisionResponse(rawResponse);
      if (!parsed) {
        console.warn('[IdeCodeIdentifier] Failed to parse Vision response as JSON');
        return undefined;
      }

      const canonicalId = buildCanonicalId(parsed.tab_filename, parsed.breadcrumb_path);
      if (!canonicalId) {
        console.warn('[IdeCodeIdentifier] Could not build canonicalId from Vision response');
        return undefined;
      }

      return {
        canonicalId,
        components: {
          tabFilename: parsed.tab_filename ?? undefined,
          breadcrumbPath: parsed.breadcrumb_path ?? undefined,
        },
      };
    } catch (err) {
      console.warn('[IdeCodeIdentifier] Vision identification failed:', err instanceof Error ? err.message : err);
      return undefined;
    }
  }
}

const identifierRegistry: Identifier[] = [new IdeCodeIdentifier()];

export function getIdentifier(category: ImageCategory): Identifier | undefined {
  return identifierRegistry.find((id) => id.category === category);
}

export { buildCanonicalId, sanitizeSlug };