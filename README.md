# Remnawave Renew Pay

Установщик и сервис продления подписок Remnawave через ЮKassa и/или Platega.

## Установка

```bash
git clone https://github.com/YOUR_USERNAME/remnawave-renew-pay.git
cd remnawave-renew-pay
sudo ./install.sh
```

Или после публикации репозитория:

```bash
curl -fsSL https://raw.githubusercontent.com/YOUR_USERNAME/remnawave-renew-pay/main/install.sh | bash
```

Установщик:
- проверяет Docker;
- предлагает ЮKassa, Platega или оба;
- создаёт `.env`;
- запускает Docker Compose;
- добавляет webhook endpoint;
- выполняет автопроверку успешных платежей;
- хранит обработанные payment ID;
- не продлевает бессрочные аккаунты по `expireAt`;
- поддерживает тарифы 1/3/6/12 месяцев.

## Важно

Перед использованием замените API URL/токены Remnawave на реальные значения вашей установки. Установщик не пытается угадывать секреты.

## Управление

```bash
sudo ./update.sh
sudo ./uninstall.sh
docker compose logs -f
```

## Webhook

После установки endpoints:

```text
POST /webhook/yookassa
POST /webhook/platega
GET  /health
```

Настройте публичный reverse proxy на порт `3100`.

## Безопасность

Секреты хранятся только в `.env`, который исключён из Git. Не публикуйте `.env`.
