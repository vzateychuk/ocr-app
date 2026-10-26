# ADR 0001: Идентификация скриншотов через Vision-LLM на примере `ide_code`


## Контекст

В системе загрузки скриншотов (`apps/back/src/services/upload.pipeline.ts`) существует пайплайн:
`preprocess → ocr → classify → save → cleanup → postprocess`

Классификатор (JevService) определяет 9 категорий, включая `ide_code`.

Проблема: несколько скриншотов **одного и того же файла** (сделанных в разное время, с разным скроллом кода, разной областью захвата) должны получать **один и тот же идентификатор**, чтобы их можно было логически сгруппировать.

Tesseract используется только для получения текста, необходимого Jev для классификации скриншота. Он плохо распознаёт содержимое кода и не предназначен для полного распознавания скриншота; его результат нельзя использовать как точный исходный текст для сохранения кода или других документов.

## Non-Goals

- **Jev не используется для имени файла / пути.** Jev — decision model (`choice` / `noul` / `score`), свободный текст не возвращает. Категория (`ide_code` и др.) остаётся зоной Jev; идентификатор сущности — нет.
- **OCR-полосы и документ `store/wiki/filename-from-screenshot.md` не используются.** Они опирались на неверное допущение про извлечение заголовка через классификатор/OCR-регионы. Для идентификатора — только Vision.
- OCR Tesseract **остаётся** в пайплайне только как вход текста для Jev-классификации. Его результат не используется для полного распознавания и сохранения содержимого документа.

## Решение

Использовать **Vision-LLM** (например 'NVIDIA Nemotron 3.5 Super VL' через OpenAI-совместимый endpoint `https://integrate.api.nvidia.com/v1`) для чтения таб-бара и breadcrumbs с кропа верхней части скриншота, а также для полного распознавания содержимого документа отдельным шагом пайплайна.

### Архитектура

1. **Шаг `identify`** в пайплайне выполняется после `classify`, чтобы определить `entityId`:
   `preprocess → ocr → classify → identify → recognize → save → cleanup → postprocess`
2. **Шаг `recognize`** выполняется после `identify` и до `save`. Он передаёт полное препроцессированное изображение Vision-модели и помещает в контекст результат полного распознавания (текст и, для кода, строки с исходными номерами). Сохранение результата на диск выполняют savers на шаге `save`. Tesseract OCR не является источником этих данных.
3. **VisionClient** (`apps/back/src/services/vision-client.ts`) — generic клиент на базе `openai` SDK, конфигурируемый через env; для идентификации используется кроп верхней полосы, для полного распознавания — изображение целиком.
4. **Распознаватели по категориям** — реестр распознавателей. `IdeCodeRecognizer` для `ide_code` возвращает текст кода и соответствие видимых строк номерам в gutter. Для остальных категорий используется распознаватель по умолчанию, который возвращает распознанный текст документа.
5. **Идентификаторы по категориям** — реестр в `apps/back/src/identifiers/index.ts`. Сейчас эксперимент **только** с `IdeCodeIdentifier` для `ide_code`. Для остальных категорий хендлера нет: шаг `identify` — no-op, слаг = `category`. Позже реестр расширяется (`jira_issue`, `github_repo`, …).
6. **EntityId** — внутренний тип результата (см. ниже). В API наружу отдаётся `entityId` = `canonicalId`.
7. **Сохранение результата** в `saveStep`: изображение сохраняется с именем, слаг которого сформирован из `canonicalId` (см. sanitize), а распознанное содержимое сохраняется соответствующим saver на основании результата шага `recognize`. Код `ide_code` сохраняется в `raw/code` по относительному пути `canonicalId`. Если идентификатора нет, saver кода не сохраняет текст; изображение всё равно сохраняется.

### Сохранение распознанного кода

- Для `ide_code` результат распознавания кода сохраняется в `$KB_BASE_DIR/raw/code/<canonicalId>`. `KB_BASE_DIR` задаёт базовую директорию хранилища; `canonicalId` используется как путь относительно `raw/code`, включая каталоги и имя файла. Например, при `KB_BASE_DIR=store` для `src/common/utils/maven/dependency_list.py` создаётся `store/raw/code/src/common/utils/maven/dependency_list.py`.
- Код должен распознаваться Vision-моделью на отдельном этапе `recognize`, а не браться из OCR Tesseract. **IdeCodeRecognizer** возвращает видимые строки, номера которых получены с изображения, и текст каждой строки. Код объединяется **построчно по номерам строк исходного файла, видимым на скан-образе**. Каждая распознанная строка должна находиться в результирующем файле на том же номере, что и на изображении; нельзя сдвигать строки, удалять пустые строки или перенумеровывать диапазон при сохранении и слиянии. Существующие строки вне распознанного диапазона сохраняются; для совпадающих номеров строк текст из нового распознавания заменяет прежний, а ранее отсутствовавшие строки добавляются на свои позиции. Содержимое каждой результирующей строки должно **в точности** совпадать с соответствующей строкой из результата Vision-распознавания: его нельзя исправлять, форматировать, нормализовать или иным образом преобразовывать после распознавания.
- Например, если файл содержит строки `L0–L31`, а со следующего скриншота распознаны `L29–L60`, результат содержит старые `L0–L28`, новые версии `L29–L31` и добавленные `L32–L60`.

### Когда вызывается `identify`

- Шаг **всегда** присутствует в saga.
- Реестр: `getIdentifier(category)` → хендлер или `undefined`.
- Если хендлера нет (сейчас всё, кроме `ide_code`) → сразу выходим, `entityId` не ставим.
- Если хендлер есть → crop + Vision; при любой ошибке — soft-fail (см. VisionClient), пайплайн продолжает `save` со слагом `category`.

### Когда вызывается `recognize`

- Шаг выполняется после `identify` и до `save`.
- Для полного распознавания используется Vision-модель, отдельная от Tesseract OCR, который служит только для классификации Jev.
- Распознаватель выбирается по категории. Для `ide_code` он получает изображение целиком и возвращает строки кода с видимыми номерами строк; для остальных категорий распознаватель по умолчанию возвращает полный текст документа.
- Результат `recognize` передаётся saver’у. Saver не должен повторно использовать текст Tesseract вместо результата Vision.

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
6. Ошибки Vision при идентификации не валят пайплайн — warning в лог, слаг = `category`.
7. Для `ide_code` создаётся файл в `$KB_BASE_DIR/raw/code` по пути из `canonicalId`; повторное распознавание перекрывающихся строк заменяет только строки с совпадающими номерами, сохраняя остальные распознанные строки.
8. Tesseract используется для Jev-классификации, но не для сохранения распознанного содержимого.
9. Полное распознавание Vision выполняется на отдельном шаге `recognize` после `identify` и до `save`; результат этого шага является входом соответствующего saver.

## Ссылки

- NVIDIA Nemotron 3.5 Super VL API: https://build.nvidia.com/nvidia/nemotron-3.5-super-vl-120b-a12b
- Текущий пайплайн: `apps/back/src/services/upload.pipeline.ts`
- Тестовые данные (прогоны): `apps/back/store/raw/images/2026-10-24_*_ide_code*.png`
- Fixtures: `apps/back/test/fixtures/`
