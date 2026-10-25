# ADR 0001: Идентификация скриншотов через Vision-LLM на примере `ide_code`


## Контекст

В системе загрузки скриншотов (`apps/back/src/services/upload.pipeline.ts`) существует пайплайн:
`preprocess → ocr → classify → save → cleanup → postprocess`

Классификатор (JevService) определяет 9 категорий, включая `ide_code`.

Проблема: несколько скриншотов **одного и того же файла** (сделанных в разное время, с разным скроллом кода, разной областью захвата) должны получать **один и тот же идентификатор**, чтобы их можно было логически сгруппировать.

OCR Tesseract читает таб-бар (имя файла на вкладке) и breadcrumbs (путь к файлу) с большим количеством ошибок (мусорные символы, потеря точек в расширении, неверные сегменты пути). Чистого OCR недостаточно для надёжной идентификации.

## Non-Goals

- **Jev не используется для имени файла / пути.** Jev — decision model (`choice` / `noul` / `score`), свободный текст не возвращает. Категория (`ide_code` и др.) остаётся зоной Jev; идентификатор сущности — нет.
- **OCR-полосы и документ `store/wiki/filename-from-screenshot.md` не используются.** Они опирались на неверное допущение про извлечение заголовка через классификатор/OCR-регионы. Для идентификатора — только Vision.
- OCR Tesseract **остаётся** в пайплайне как вход текста для Jev-классификации, не как источник `entityId`.

## Решение

Использовать **Vision-LLM** (например 'NVIDIA Nemotron 3.5 Super VL' через OpenAI-совместимый endpoint `https://integrate.api.nvidia.com/v1`) для чтения таб-бара и breadcrumbs с кропа верхней части скриншота.

### Архитектура

1. **Новый шаг `identify`** в пайплайне после `classify`, до `save`:
   `preprocess → ocr → classify → identify → save → cleanup → postprocess`
2. **VisionClient** (`apps/back/src/services/vision-client.ts`) — generic клиент на базе `openai` SDK, конфигурируемый через env.
3. **Идентификаторы по категориям** — реестр в `apps/back/src/identifiers/index.ts`. Сейчас эксперимент **только** с `IdeCodeIdentifier` для `ide_code`. Для остальных категорий хендлера нет: шаг `identify` — no-op, слаг = `category`. Позже реестр расширяется (`jira_issue`, `github_repo`, …).
4. **EntityId** — внутренний тип результата (см. ниже). В API наружу отдаётся `entityId` = `canonicalId`.
5. **Слаг файла** в `saveStep` формируется из `canonicalId` (см. sanitize). Если идентификатора нет — fallback на `category`.

### Когда вызывается `identify`

- Шаг **всегда** присутствует в saga.
- Реестр: `getIdentifier(category)` → хендлер или `undefined`.
- Если хендлера нет (сейчас всё, кроме `ide_code`) → сразу выходим, `entityId` не ставим.
- Если хендлер есть → crop + Vision; при любой ошибке — soft-fail (см. VisionClient), пайплайн продолжает `save` со слагом `category`.

### Вход Vision (картинка)

- Источник: **препроцессированное** изображение (`ctx.ocrImagePath` — то же, что сохраняется в `raw/images`), не сырой upload.
- Crop: верхняя полоса высотой `ceil(height * VISION_CROP_TOP_RATIO)` от препроцессированного кадра (таб-бар + breadcrumbs).
- В API: data-URL `data:image/png;base64,...` в multimodal `user` message (OpenAI-compatible chat completions).

### Контракт VisionClient

```typescript
completeVision(input: {
  imageBuffer: Buffer; // уже обрезанный PNG
  prompt: string;
  timeoutMs?: number;
}): Promise<string>; // сырой текст ответа модели
```

Поведение:

- HTTP/SDK-клиент с `baseURL`, `apiKey`, `model` из env.
- Таймаут: `VISION_TIMEOUT_MS` (AbortSignal / аналог).
- Ошибки сети, non-2xx, пустой ответ, невалидный JSON после parse на стороне identifier — **не бросают saga**: identifier ловит, пишет `console.warn`, возвращает `undefined` → `save` использует `category`.
- `VISION_API_KEY`: при старте приложения — warning, если пусто; жёсткий exit не обязателен (identify просто soft-fail до появления ключа). Либо lazy: первая попытка `ide_code` без ключа → warning + skip.

### Нормализация `canonicalId`

Вход от модели (после JSON parse):

```typescript
{ tab_filename: string | null; breadcrumb_path: string | null }
```

Алгоритм сборки `canonicalId`:

1. `tab = trim(tab_filename)` или пусто, если `null` / пустая строка.
2. `crumbs = trim(breadcrumb_path)` или пусто.
3. Сегменты breadcrumbs: split по `>`, каждый segment `trim`, отбросить пустые. Имя класса/метода после файла модель **не должна** возвращать (промпт); если последний сегмент совпадает с `tab` (сравнение case-insensitive) — отбросить дубликат.
4. Сборка пути:
   - есть crumbs и tab → `segments.join('/') + '/' + tab`
   - только tab → `tab`
   - только crumbs → `segments.join('/')` (без filename — слабый id, допустим)
   - оба пусты → идентификатора нет (`undefined`)
5. Нормализация пути: схлопнуть `//`, убрать ведущий/хвостовой `/`, не менять регистр сегментов до шага sanitize слага (в `canonicalId` / `entityId` сохраняем осмысленный вид, например `src/common/analysers/library/lib_maven.py`).

Примеры:

| tab_filename | breadcrumb_path | canonicalId |
|---|---|---|
| `lib_maven.py` | `src > common > analysers > library` | `src/common/analysers/library/lib_maven.py` |
| `dependency_list.py` | `src > common > utils > maven` | `src/common/utils/maven/dependency_list.py` |
| `lib_maven.py` | `null` | `lib_maven.py` |
| `null` | `null` | _(нет id)_ |

### Sanitize слага для имени файла на диске

Из `canonicalId`:

1. lowercase  
2. `/` → `_`  
3. оставить только `[a-z0-9._-]` (прочие символы → `_` или удалить; подряд идущие `_` схлопнуть)  
5. имя файла: `{timestamp}_{slug}.png`  
6. нет `canonicalId` → `{timestamp}_{category}.png`

Примеры:

- `src/common/analysers/library/lib_maven.py` → `src_common_analysers_library_lib_maven.py` (в имени с timestamp; точка перед `py` допустима в charset)  
  Уточнение: `.` в расширении файла внутри слага сохраняем как `.` → `..._lib_maven.py` в середине имени диска выглядит странно; **практика ADR:** заменить `.` в слагах на `_` тоже, кроме того что charset допускает `.` — для однозначности: **`.` → `_`**, итого  
  `src_common_analysers_library_lib_maven_py`.

### Переменные окружения (`.envs/dev.env`)

```
VISION_BASE_URL=https://integrate.api.nvidia.com/v1
VISION_API_KEY=<ключ от build.nvidia.com>
VISION_MODEL=nvidia/nemotron-3.5-super-vl-120b-a12b
VISION_CROP_TOP_RATIO=0.18
VISION_TIMEOUT_MS=15000
```

| Переменная | Обязательность | По умолчанию |
|---|---|---|
| `VISION_BASE_URL` | нет | `https://integrate.api.nvidia.com/v1` |
| `VISION_API_KEY` | да для успешного identify | — (без ключа — soft-fail) |
| `VISION_MODEL` | нет | `nvidia/nemotron-3.5-super-vl-120b-a12b` |
| `VISION_CROP_TOP_RATIO` | нет | `0.18` |
| `VISION_TIMEOUT_MS` | нет | `15000` |

### Промпт для `ide_code` (v1 accepted)

```
Ты видишь верхнюю часть скриншота IDE (вкладки и breadcrumbs).

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
}
```

### Типы end-to-end

Внутренний результат identifier:

```typescript
export interface EntityId {
  canonicalId: string;
  components: {
    tabFilename?: string;
    breadcrumbPath?: string;
  };
}
```

Контекст saga: `entityId?: EntityId` (или плоский `canonicalId` + components — на усмотрение реализации, главное — одно место правды).

API (`UploadSuccessResult`):

```typescript
export interface UploadSuccessResult {
  success: true;
  originalName: string;
  savedImagePath: string;
  category: ImageCategory;
  confidence?: number;
  probabilities?: Partial<Record<ImageCategory, number>>;
  /** Канонический id сущности (= EntityId.canonicalId), напр. src/common/analysers/library/lib_maven.py */
  entityId?: string;
}
```

`UploadService` прокидывает `ctx` → `entityId: ctx.entityId?.canonicalId`.

### Манифест fixtures для приёмки

Каталог: `apps/back/test/fixtures/`.

Пока явной разметки «файл → логическая сущность» в репозитории нет — **перед прогоном приёмки** зафиксировать манифест (таблица или `fixtures/manifest.json`), например:

| Группа | Ожидаемый `entityId` (`canonicalId`) | Файлы (примеры имён) |
|---|---|---|
| A — `dependency_list.py` | `src/common/utils/maven/dependency_list.py` (уточнить по реальным breadcrumbs на кадрах) | `c175021a-3284-code-*.png` / подмножество |
| B — `lib_maven.py` | `src/common/analysers/library/lib_maven.py` | оставшиеся IDE-кадры с этим файлом |

Критерии 1–3 проверяются **по группам манифеста**, не по всем pngлам подряд без разметки.

## Последствия

### Положительные
- Надёжная идентификация одного файла по множеству скриншотов с разным скроллом/областью.
- Имя сохраняемого файла становится человекочитаемым: `20261024_215549_src_common_analysers_library_lib_maven_py.png`.
- API возвращает `entityId` — клиент может группировать без повторного распознавания.
- Архитектура расширяема: для `jira_issue`, `github_repo` и др. добавляются свои хендлеры в реестр.

### Ограничения
- Пока работает только `ide_code`; остальные категории без изменений по имени файла.
- Качество зависит от crop ratio и промпта v1; при смене UI IDE может понадобиться подстройка `VISION_CROP_TOP_RATIO`.

## Критерии приёмки

Используя образцы `apps/back/test/fixtures` и манифест групп выше:

1. На скриншотах группы `dependency_list.py` возвращается **одинаковый** `entityId`.
2. На скриншотах группы `lib_maven.py` возвращается **одинаковый** `entityId` (путь нормализуется к `src/common/analysers/library/lib_maven.py`, если breadcrumbs это подтверждают).
3. Разные логические файлы → разные `entityId`.
4. Имя файла на диске содержит слаг из `canonicalId`.
5. API ответ содержит `entityId`.
6. Ошибки Vision не валят пайплайн — warning в лог, слаг = `category`.

## Ссылки

- NVIDIA Nemotron 3.5 Super VL API: https://build.nvidia.com/nvidia/nemotron-3.5-super-vl-120b-a12b
- Текущий пайплайн: `apps/back/src/services/upload.pipeline.ts`
- Тестовые данные (прогоны): `apps/back/store/raw/images/2026-10-24_*_ide_code*.png`
- Fixtures: `apps/back/test/fixtures/`
