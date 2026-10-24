# Backend (apps/back)

Сервис загрузки скриншотов с OCR и классификацией через JEV (LLM).

## Структура проекта

```
apps/back/
├── .envs/
│   └── dev.env              # Переменные окружения для разработки
├── store/                   # Knowledge base (KB_BASE_DIR, не в git)
│   ├── tmp/                 # Временные файлы при загрузке
│   ├── raw/
│   │   ├── images/          # Препроцессированные скриншоты (вход OCR / Vision)
│   │   └── docs/            # Распознанные (OCR) файлы
│   └── wiki/                # Переработанные файлы
├── test/
│   └── fixtures/            # Тестовые файлы для интеграционных тестов
│       ├── github-repo.png
│       ├── jira-ticket.png
│       ├── teams-chat.png
│       └── invalid.txt      # Не-изображение для теста валидации
├── http/
│   └── upload.http          # REST Client запросы для ручного тестирования
├── src/
│   ├── index.ts             # Точка входа, Express app, DI
│   ├── controllers/
│   │   └── upload.controller.ts
│   ├── middlewares/
│   │   ├── upload.middleware.ts      # Multer: парсинг multipart, сохранение во временную папку
│   │   ├── validate-file.middleware.ts # file-type: проверка magic bytes
│   │   └── error.middleware.ts
│   ├── services/
│   │   ├── jev.service.ts            # Запросы к JEV API (OpenRouter)
│   │   ├── upload.service.ts         # Оркестрация пайплайна
│   │   └── upload.pipeline.ts        # Saga/FSM шаги: preprocess → OCR → classify → save → postprocess
│   ├── utils/
│   │   ├── ocr.ts                    # Запуск tesseract через child_process
│   │   └── preprocess.ts             # Preprocess для OCR: grayscale → invert? → contrast → upscale
│   ├── fsm/                          # Мини-фреймворк Saga/FSM
│   │   ├── types.ts
│   │   ├── saga.ts
│   │   └── index.ts
│   └── types/
│       └── jev.types.ts
├── package.json
└── tsconfig.json
```

## Переменные окружения (.envs/dev.env)

| Переменная | Описание | По умолчанию |
|------------|----------|--------------|
| PORT | Порт HTTP сервера | 3000 |
| OPENROUTER_API_URL | Эндпоинт OpenRouter | https://openrouter.ai/api/alpha/decisions |
| OPENROUTER_API_KEY | API ключ (обязателен) | — |
| JEV_MODEL | Модель для классификации | typesafe/jev-1.13 |
| KB_BASE_DIR | Корень knowledge base (относительно apps/back): `tmp/`, `raw/`, `wiki/` | store |
| UPLOAD_TEMP_DIR | Временная папка для загрузок (обычно `KB_BASE_DIR/tmp`) | store/tmp |
| UPLOAD_MAX_FILE_SIZE_MB | Макс. размер файла | 10 |

## Запуск

```bash
# Из корня монорепо
npm run dev:back

# Или напрямую
cd apps/back
npm run dev        # tsx watch src/index.ts
npm run debug      # с инспектором
npm run build      # tsc
npm run start      # node dist/index.js
```

Сервер поднимется на `http://localhost:3000`.

## API

### POST /api/upload

Загрузка одного или нескольких изображений (до 10 за запрос).

**Content-Type:** `multipart/form-data`
**Поле:** `images` (массив файлов)

**Валидация:**
1. Multer проверяет `Content-Type` части (image/jpeg, image/png, image/webp) и размер
2. `validateFileContent` читает magic bytes сохранённого файла через `file-type`
3. При несоответствии — файл удаляется, возвращается `400`

**Успешный ответ (200):**
```json
{
  "processed": [
    {
      "success": true,
      "originalName": "github-repo.png",
      "savedImagePath": "store/raw/images/2026-09-27_16-21-16_github_repo.png",
      "category": "github_repo",
      "confidence": 1,
      "probabilities": { "github_repo": 1 }
    }
  ],
  "failed": []
}
```

**Ошибки:**
- `400` — нет файлов / неверный тип / не изображение по содержимому
- `413` — превышен лимит размера
- `500` — ошибка OCR / JEV / сохранения (детали в логах)

## Пайплайн обработки (Saga)

```
preprocess → OCR (tesseract) → classify (JEV) → name → save → postprocess
```

`preprocess` готовит изображение для Tesseract и будущего Vision (имя/путь/URL): grayscale → при тёмном UI invert → normalize → upscale ×2 при маленьком кадре → sharpen → белая рамка 10px. Hard binarization не делается — её оставляет Tesseract. В `raw/images` сохраняется именно эта препроцессированная PNG; исходный upload из tmp удаляется.

Каждый шаг изолирован, при ошибке срабатывает `onError`, при успехе — `onComplete`. Контекст передаётся по цепочке.

Шаг `name` ещё не в коде. Он читает заголовок документа из полосы скриншота (имя репозитория, ключ задачи, вкладка, тема письма) и кладёт его в имя файла. Категория Jev для этого не используется. Правила и список файлов: `store/wiki/filename-from-screenshot.md`.

## Тестирование

**REST Client (VS Code):**
Откройте `http/upload.http`, запустите сервер (`npm run dev:back`), нажмите "Send Request" над нужным блоком.

**curl:**
```bash
# Одиночный файл
curl -X POST http://localhost:3000/api/upload \
  -F "images=@test/fixtures/github-repo.png"

# Несколько файлов
curl -X POST http://localhost:3000/api/upload \
  -F "images=@test/fixtures/github-repo.png" \
  -F "images=@test/fixtures/jira-ticket.png"
```

## Зависимости

- **Runtime:** Node.js 22+, tesseract (системный, `apt install tesseract-ocr`)
- **npm:** express, multer, helmet, cors, dotenv, file-type, tsx, typescript
- **Dev:** @types/node, @types/express, @types/multer, @types/cors