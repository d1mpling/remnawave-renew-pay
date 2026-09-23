#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
read -r -p "Удалить контейнер Renew Pay? Данные в ./data сохранятся. [y/N] " answer
if [[ "$answer" =~ ^[Yy]$ ]]; then
  docker compose down
  echo "Контейнер удалён. ./data сохранён."
fi
