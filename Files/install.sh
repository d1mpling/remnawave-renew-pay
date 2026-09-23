#!/usr/bin/env bash
set -euo pipefail

REPO="https://github.com/d1mpling/remnawave-renew-pay.git"
INSTALL_DIR="/opt/remnawave-renew-pay"

echo "=========================================="
echo "     Remnawave Renew Pay Installer"
echo "=========================================="
echo

if ! command -v docker >/dev/null 2>&1; then
    echo "ERROR: Docker не найден."
    exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
    echo "ERROR: Docker Compose не найден."
    exit 1
fi

echo "Скачиваем файлы проекта..."

rm -rf "$INSTALL_DIR"
rm -rf /tmp/remnawave-renew-pay

if ! command -v git >/dev/null 2>&1; then
    echo "Устанавливаем git..."
    apt-get update
    apt-get install -y git
fi

git clone --depth 1 "$REPO" /tmp/remnawave-renew-pay

mkdir -p "$INSTALL_DIR"
cp -r /tmp/remnawave-renew-pay/Files/. "$INSTALL_DIR/"

rm -rf /tmp/remnawave-renew-pay

cd "$INSTALL_DIR"

if [ ! -f ".env.example" ]; then
    echo "ERROR: .env.example не найден в Files/"
    exit 1
fi

if [ ! -f ".env" ]; then
    cp ".env.example" ".env"
fi

echo
echo "Выберите платёжную систему:"
echo
echo "  1) ЮKassa"
echo "  2) Platega"
echo "  3) ЮKassa + Platega"
echo

read -r -p "Выбор [1-3]: " provider

case "$provider" in
    1)
        providers="yookassa"
        ;;
    2)
        providers="platega"
        ;;
    3)
        providers="yookassa,platega"
        ;;
    *)
        echo "Неверный выбор."
        exit 1
        ;;
esac

set_env() {
    local key="$1"
    local value="$2"

    if grep -q "^${key}=" .env; then
        sed -i "s#^${key}=.*#${key}=${value}#" .env
    else
        printf '%s=%s\n' "$key" "$value" >> .env
    fi
}

set_env PAYMENT_PROVIDERS "$providers"

echo
read -r -p "URL Remnawave [http://remnawave:3000]: " rw
rw="${rw:-http://remnawave:3000}"
set_env REMNAWAVE_URL "$rw"

echo
read -r -s -p "Remnawave API Token: " token
echo
set_env REMNAWAVE_TOKEN "$token"

echo
read -r -p "Публичный URL сервиса (например https://pay.example.com): " public_url
set_env PUBLIC_URL "$public_url"

if [[ "$providers" == *"yookassa"* ]]; then
    echo
    echo "========== ЮKassa =========="

    read -r -p "Shop ID: " shop
    read -r -s -p "Secret Key: " secret
    echo

    set_env YOOKASSA_SHOP_ID "$shop"
    set_env YOOKASSA_SECRET_KEY "$secret"
fi

if [[ "$providers" == *"platega"* ]]; then
    echo
    echo "========== Platega =========="

    read -r -p "Merchant ID: " merchant
    read -r -s -p "Secret: " psecret
    echo

    set_env PLATEGA_MERCHANT_ID "$merchant"
    set_env PLATEGA_SECRET "$psecret"
fi

mkdir -p data
touch data/processed.json

echo
echo "=========================================="
echo "Собираем и запускаем контейнер..."
echo "=========================================="

docker compose up -d --build

echo
echo "=========================================="
echo "       Установка завершена!"
echo "=========================================="
echo

docker compose ps

echo
echo "Health:"
echo "${public_url}/health"

echo
echo "ЮKassa webhook:"
echo "${public_url}/webhook/yookassa"

echo
echo "Platega webhook:"
echo "${public_url}/webhook/platega"

echo
echo "Логи:"
echo "cd $INSTALL_DIR && docker compose logs -f renew-pay"
