#!/bin/zsh

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIG_FILE="$APP_DIR/local-nova.config.json"
OLLAMA_URL="http://127.0.0.1:11434"

pause_on_error() {
  echo
  read -k 1 "?何かキーを押すと閉じます..."
  echo
}

resolve_app_port() {
  if [[ ! -f "$CONFIG_FILE" ]]; then
    echo "3001"
    return
  fi

  local configured_port
  configured_port="$(node -e '
    const fs = require("fs");
    const filePath = process.argv[1];

    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
      const raw = parsed && typeof parsed === "object" ? parsed.appPort : null;
      const port =
        typeof raw === "number" && Number.isInteger(raw)
          ? raw
          : typeof raw === "string" && /^\d+$/.test(raw.trim())
            ? Number(raw.trim())
            : null;

      if (port !== null && port >= 1024 && port <= 65535) {
        process.stdout.write(String(port));
      }
    } catch {}
  ' "$CONFIG_FILE")"

  if [[ -n "$configured_port" ]]; then
    echo "$configured_port"
    return
  fi

  echo "3001"
}

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js が見つかりません。先に Node.js をインストールしてください。"
  pause_on_error
  exit 1
fi

APP_PORT="$(resolve_app_port)"
APP_URL="http://127.0.0.1:${APP_PORT}"

if curl -fsS "$APP_URL" >/dev/null 2>&1; then
  open "$APP_URL"
  exit 0
fi

if ! curl -fsS "$OLLAMA_URL/api/tags" >/dev/null 2>&1; then
  if command -v ollama >/dev/null 2>&1; then
    echo "Ollama を起動します..."
    ollama serve >/tmp/local-nova-ollama.log 2>&1 &
    sleep 2
  else
    echo "Ollama が見つかりません。UI は起動しますが、会話には Ollama が必要です。"
  fi
fi

cd "$APP_DIR" || {
  echo "アプリフォルダへ移動できませんでした。"
  pause_on_error
  exit 1
}

echo "AI共創 LOCAL NOVA を起動します..."
AUTO_OPEN_BROWSER=1 node server.mjs
