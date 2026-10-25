#!/usr/bin/env bash
# Test Vision API with actual fixture image

set -euo pipefail

IMAGE_PATH="test/fixtures/code-13.png"
INVOKE_URL="https://integrate.api.nvidia.com/v1/chat/completions"

if [[ -z "${NVIDIA_API_KEY:-}" ]]; then
  echo "Error: NVIDIA_API_KEY not set"
  exit 1
fi

# Convert image to base64 data URL
BASE64_IMAGE=$(base64 -w 0 "$IMAGE_PATH")
DATA_URL="data:image/png;base64,$BASE64_IMAGE"

# Our actual prompt from identifiers/index.ts
PROMPT='Ты видишь верхнюю часть скриншота IDE (вкладки и breadcrumbs).

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
}'

# Build JSON payload
PAYLOAD=$(cat <<JSON
{
  "model": "nvidia/nemotron-3.5-super-vl-120b-a12b",
  "messages": [
    {
      "role": "user",
      "content": [
        {"type": "text", "text": $(jq -Rs . <<< "$PROMPT")},
        {"type": "image_url", "image_url": {"url": $(jq -Rs . <<< "$DATA_URL")}}
      ]
    }
  ],
  "temperature": 0.1,
  "top_p": 0.95,
  "max_tokens": 2048,
  "chat_template_kwargs": {"enable_thinking": true},
  "stream": false
}
JSON
)

echo "Sending request to Vision API..."
echo "Image size: $(wc -c < "$IMAGE_PATH") bytes"
echo "Base64 length: ${#BASE64_IMAGE} chars"

# Send request
printf 'header = "Authorization: Bearer %s"\n' "$NVIDIA_API_KEY" | \
curl --fail-with-body --config - -sS \
  --request POST \
  --url "$INVOKE_URL" \
  --header "Accept: application/json" \
  --header "Content-Type: application/json" \
  --data "$PAYLOAD" | jq .