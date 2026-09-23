#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "=========================================="
echo "     Remnawave Renew Pay Installer"
echo "=========================================="
echo

command -v docker >/dev/null 2>&1 || {
  echo "ERROR: Docker не найден."
  exit 1
}

docker compose version >/dev/null 2>&1 || {
  echo "ERROR: Docker Compose не найден."
  exit 1
}

if [ ! -f "$APP_DIR/.env" ]; then
  cp "$APP_DIR/.env.example" "$APP_DIR/.env"
fi

echo "Выберите платёжную систему:"
echo "  1) ЮKassa"
echo "  2) Platega"
echo "  3) ЮKassa + Platega"
read -r -p "Выбор [1-3]: " provider

case "$provider" in
  1) providers="yookassa" ;;
  2) providers="platega" ;;
  3) providers="yookassa,platega" ;;
  *) echo "Неверный выбор"; exit 1 ;;
esac

set_env() {
  key="$1"
  value="$2"
  if grep -q "^${key}=" "$APP_DIR/.env"; then
    sed -i "s#^${key}=.*#${key}=${value}#" "$APP_DIR/.env"
  else
    printf '%s=%s\n' "$key" "$value" >> "$APP_DIR/.env"
  fi
}

set_env PAYMENT_PROVIDERS "$providers"

read -r -p "REMNAWAVE_URL [http://remnawave:3000]: " rw
rw="${rw:-http://remnawave:3000}"
set_env REMNAWAVE_URL "$rw"

read -r -s -p "REMNAWAVE_TOKEN: " token
echo
set_env REMNAWAVE_TOKEN "$token"

read -r -p "PUBLIC_URL (например https://pay.example.com): " public_url
set_env PUBLIC_URL "$public_url"

if [[ "$providers" == *yookassa* ]]; then
  read -r -p "ЮKassa Shop ID: " shop
  read -r -s -p "ЮKassa Secret Key: " secret
  echo
  set_env YOOKASSA_SHOP_ID "$shop"
  set_env YOOKASSA_SECRET_KEY "$secret"
fi

if [[ "$providers" == *platega* ]]; then
  read -r -p "Platega Merchant ID: " merchant
  read -r -s -p "Platega Secret: " psecret
  echo
  set_env PLATEGA_MERCHANT_ID "$merchant"
  set_env PLATEGA_SECRET "$psecret"
fi

mkdir -p "$APP_DIR/data"
touch "$APP_DIR/data/processed.json"

echo
echo "Собираем контейнер..."
cd "$APP_DIR"
docker compose up -d --build

echo
echo "Проверяем..."
sleep 3
docker compose ps
echo
echo "=========================================="
echo "Установка завершена"
echo "=========================================="
echo
echo "Health: ${public_url:-http://SERVER:3100}/health"
echo "ЮKassa webhook: ${public_url:-http://SERVER:3100}/webhook/yookassa"
echo "Platega webhook: ${public_url:-http://SERVER:3100}/webhook/platega"
echo
echo "Логи:"
echo "  docker compose logs -f renew-pay"
