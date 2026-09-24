#!/usr/bin/env bash
# remnawave-renew: установка кнопки продления на страницу подписки Remnawave.
#
#   bash <(curl -fsSL https://raw.githubusercontent.com/YOUR_USER/remnawave-renew/main/install.sh)
#
# Меню: 1) всё на домене подписки, 2) отдельный домен оплаты, 3) обновить код, 4) удалить.
# Без меню: install.sh path | domain | update | uninstall
set -Eeuo pipefail

REPO_RAW="${REPO_RAW:-https://raw.githubusercontent.com/YOUR_USER/remnawave-renew/main}"
DIR="${RENEW_DIR:-/opt/renew-pay}"
NODE_IMAGE="node:22-alpine"
SELF="${BASH_SOURCE[0]:-$0}"
SRC_DIR="$(cd "$(dirname "$SELF")" 2>/dev/null && pwd || true)"

# ---------- вывод и ввод ----------
B=$'\e[1m'; G=$'\e[32m'; Y=$'\e[33m'; R=$'\e[31m'; N=$'\e[0m'
say()  { printf '%s\n' "$*" >&2; }
step() { printf '\n%s==> %s%s\n' "$B" "$*" "$N" >&2; }
ok()   { printf '%s✓%s %s\n' "$G" "$N" "$*" >&2; }
warn() { printf '%s!%s %s\n' "$Y" "$N" "$*" >&2; }
die()  { printf '%s✗ %s%s\n' "$R" "$*" "$N" >&2; exit 1; }
trap 'die "Ошибка на строке $LINENO. Изменения nginx (если были) откатываются автоматически."' ERR

[ -r /dev/tty ] || die "Нужен интерактивный терминал (запускайте через SSH, не из cron)."
ask() { # ask "вопрос" "значение по умолчанию"
  local v=""
  if [ -n "${2-}" ]; then read -r -p "$1 [$2]: " v </dev/tty || true
  else read -r -p "$1: " v </dev/tty || true; fi
  printf '%s' "${v:-${2-}}"
}
ask_req() { local v=""; while [ -z "$v" ]; do v="$(ask "$1" "${2-}")"; done; printf '%s' "$v"; }
ask_secret() {
  local v=""
  while [ -z "$v" ]; do read -r -s -p "$1: " v </dev/tty || true; printf '\n' >&2; done
  printf '%s' "$v"
}
ask_yn() { # ask_yn "вопрос" y|n
  local d="${2:-y}" v hint="Y/n"; [ "$d" = n ] && hint="y/N"
  read -r -p "$1 [$hint]: " v </dev/tty || true
  v="${v:-$d}"; [[ "$v" =~ ^[YyДд] ]]
}

# ---------- проверки ----------
need_docker() {
  command -v docker >/dev/null || die "Docker не найден."
  docker compose version >/dev/null 2>&1 && COMPOSE="docker compose" ||
    { command -v docker-compose >/dev/null && COMPOSE="docker-compose" || die "Не найден docker compose."; }
}
[ "$(id -u)" = 0 ] || die "Запустите от root (sudo -i)."

# ---------- файлы приложения ----------
fetch_app() {
  mkdir -p "$DIR/data"
  local f
  for f in server.js renew-button.js; do
    if [ -f "$SRC_DIR/app/$f" ]; then cp "$SRC_DIR/app/$f" "$DIR/$f.new"
    else curl -fsSL "$REPO_RAW/app/$f" -o "$DIR/$f.new" || die "Не удалось скачать $REPO_RAW/app/$f"; fi
    [ -s "$DIR/$f.new" ] || die "Пустой файл $f"
    mv "$DIR/$f.new" "$DIR/$f"
  done
  docker run --rm -v "$DIR/server.js:/a.js:ro" "$NODE_IMAGE" node --check /a.js || die "server.js не проходит проверку синтаксиса"
  docker run --rm -v "$DIR/renew-button.js:/a.js:ro" "$NODE_IMAGE" node --check /a.js || die "renew-button.js не проходит проверку синтаксиса"
  ok "Файлы приложения скачаны и проверены"
}

# ---------- nginx ----------
detect_nginx() {
  NGINX="${NGINX_CONTAINER:-remnawave-nginx}"
  docker inspect "$NGINX" >/dev/null 2>&1 || NGINX="$(ask_req "Имя контейнера nginx" "remnawave-nginx")"
  docker inspect "$NGINX" >/dev/null 2>&1 || die "Контейнер $NGINX не найден"
  CONF="$(docker inspect -f '{{range .Mounts}}{{.Source}}|{{.Destination}}{{"\n"}}{{end}}' "$NGINX" \
          | awk -F'|' '$2 ~ /^\/etc\/nginx\/.*\.conf$/ {print $1; exit}')"
  if [ -z "$CONF" ] || [ ! -f "$CONF" ]; then CONF="$(ask_req "Путь к nginx.conf на хосте" "/opt/remnawave/nginx.conf")"; fi
  [ -f "$CONF" ] || die "Файл $CONF не найден"
  ok "nginx: контейнер $NGINX, конфиг $CONF"
}

strip_markers() {
  sed -e '/# renew-button begin/,/# renew-button end/d' -e '/# renew-pay begin/,/# renew-pay end/d' \
      -e '/# renew-pay-loc begin/,/# renew-pay-loc end/d' "$1"
}

nginx_apply() { # $1 = новый конфиг; пишем через cat >, чтобы bind-mount не потерял inode
  local bak="$CONF.bak.$(date +%Y%m%d-%H%M%S)"
  cp -p "$CONF" "$bak"
  cat "$1" > "$CONF"
  if docker exec "$NGINX" nginx -t >/dev/null 2>&1; then
    docker exec "$NGINX" nginx -s reload >/dev/null
    ok "nginx перезагружен (бэкап: $bak)"
  else
    docker exec "$NGINX" nginx -t >&2 || true
    cat "$bak" > "$CONF"
    die "nginx не принял конфиг, изменения откачены из $bak"
  fi
}

AWK_PATCH='
function count(s, ch,   n, i) { n = 0; for (i = 1; i <= length(s); i++) if (substr(s, i, 1) == ch) n++; return n }
BEGIN {
  dom = ENVIRON["DOM"]; gsub(/\./, "\\.", dom); re = "[ \t]" dom "[ \t;]"
  while ((getline l < ENVIRON["INJ"]) > 0) inj = inj l "\n"
  if (ENVIRON["PAYBLK"] != "") while ((getline l < ENVIRON["PAYBLK"]) > 0) pay = pay l "\n"
  if (ENVIRON["LOC"] != "") while ((getline l < ENVIRON["LOC"]) > 0) loc = loc l "\n"
  inserv = 0; hit = 0
}
{
  if (!inserv && $0 ~ /^[ \t]*server[ \t]*\{[ \t]*$/) { inserv = 1; depth = 0; nb = 0 }
  if (inserv) {
    blk[++nb] = $0
    depth += count($0, "{") - count($0, "}")
    if (depth <= 0) {
      target = 0
      for (i = 1; i <= nb; i++) if (blk[i] ~ /^[ \t]*server_name[ \t]/ && (blk[i] " ") ~ re) target = 1
      if (target) {
        hit++
        ssl = ""
        for (i = 1; i <= nb; i++) if (blk[i] ~ /^[ \t]*ssl_[a-z_]+[ \t]/) ssl = ssl blk[i] "\n"
        if (pay != "") {
          p = index(pay, "@SSL@\n")
          if (p) printf "%s%s%s", substr(pay, 1, p - 1), ssl, substr(pay, p + 6)
          else printf "%s", pay
        }
        for (i = 1; i <= nb; i++) {
          if (i == nb && loc != "") printf "%s", loc
          print blk[i]
          if (blk[i] ~ /^[ \t]*proxy_pass[ \t]/) printf "%s", inj
        }
      } else for (i = 1; i <= nb; i++) print blk[i]
      inserv = 0
    }
    next
  }
  print
}
END { if (!hit) exit 3 }
'

setup_nginx() {
  step "Настройка nginx"
  detect_nginx
  if grep -q 'renew-button.js' "$CONF" && ! grep -q '# renew-button begin' "$CONF"; then
    warn "В $CONF уже есть ручная вставка renew-button.js (без маркеров). Автоправку nginx пропускаю."
    warn "Чтобы скрипт скачивался с сервиса оплаты, замените в sub_filter путь на: $PAY_URL/renew-button.js"
    return 0
  fi
  local tmp; tmp="$(mktemp -d)"
  strip_markers "$CONF" > "$tmp/base.conf"

  cat > "$tmp/inj.txt" <<EOF
        # renew-button begin
        proxy_set_header Accept-Encoding "";
        sub_filter '</body>' '<script src="$PAY_URL/renew-button.js"></script></body>';
        sub_filter_once on;
        # renew-button end
EOF

  : > "$tmp/pay.txt"; : > "$tmp/loc.txt"
  if [ "$PAY_MODE" = path ]; then
    cat > "$tmp/loc.txt" <<EOF
    # renew-pay-loc begin
    location /renew-pay/ {
        proxy_pass http://$UPSTREAM/;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    }
    # renew-pay-loc end
EOF
  else
    local pay_re="${PAY_NAME//./\\.}"
    if grep -Eq "server_name[^;]*[[:space:]]${pay_re}[[:space:];]" "$tmp/base.conf"; then
      ok "Server-блок для $PAY_NAME уже есть, оставляю как есть (проверьте, что он проксирует на $UPSTREAM)"
    else
      local ssl_lines="@SSL@"
      if [ -n "${CERT_CRT:-}" ]; then
        ssl_lines="        ssl_certificate \"$CERT_CRT\";
        ssl_certificate_key \"$CERT_KEY\";"
      fi
      cat > "$tmp/pay.txt" <<EOF
    # renew-pay begin
    server {
        server_name $PAY_NAME;
        listen $PAY_PORT ssl;
$ssl_lines
        location / {
            proxy_pass http://$UPSTREAM;
            proxy_set_header Host \$host;
            proxy_set_header X-Real-IP \$remote_addr;
            proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        }
    }
    # renew-pay end

EOF
    fi
  fi

  local pay_arg=""; [ -s "$tmp/pay.txt" ] && pay_arg="$tmp/pay.txt"
  local loc_arg=""; [ -s "$tmp/loc.txt" ] && loc_arg="$tmp/loc.txt"
  DOM="$SUB_DOMAIN" INJ="$tmp/inj.txt" PAYBLK="$pay_arg" LOC="$loc_arg" awk "$AWK_PATCH" "$tmp/base.conf" > "$tmp/new.conf" ||
    die "В $CONF не найден server-блок с server_name $SUB_DOMAIN. Проверьте домен подписки."
  if diff -q "$CONF" "$tmp/new.conf" >/dev/null; then ok "nginx уже настроен, менять нечего"; rm -rf "$tmp"; return 0; fi
  nginx_apply "$tmp/new.conf"
  rm -rf "$tmp"
}

# ---------- опрос ----------
list_squads() {
  docker run --rm --network "$NETWORK" -e U="$PANEL_URL" -e T="$RW_TOKEN" "$NODE_IMAGE" node -e '
fetch(process.env.U + "/api/internal-squads", { headers: { Authorization: "Bearer " + process.env.T,
  "X-Forwarded-For": "127.0.0.1", "X-Forwarded-Proto": "https" } })
  .then(r => r.json()).then(j => { for (const s of j.response.internalSquads) console.log(s.uuid + "\t" + s.name + "\t" + s.info.membersCount); })
  .catch(e => { console.error(e.message); process.exit(1); })' 2>/dev/null
}

pick_squads() { # $1 = название тарифа; печатает JSON-список "a","b"
  local line n out="" sel
  say "Внутренние сквады для тарифа «$1» (номера через пробел, пусто = не менять сквады пользователя):"
  sel="$(ask "Номера" "")"
  for n in ${sel//,/ }; do
    if [[ "$n" =~ ^[0-9]+$ ]] && [ "$n" -ge 1 ] && [ "$n" -le "${#SQ_UUID[@]}" ]; then
      out+="${out:+,}\"${SQ_UUID[$((n-1))]}\""
    else warn "Пропускаю «$n»"; fi
  done
  printf '%s' "$out"
}

write_plans() {
  local f="$DIR/data/plans.json"
  if [ -f "$f" ] && ask_yn "plans.json уже есть. Оставить как есть?" y; then return 0; fi
  step "Тарифы"
  say "Создам два тарифа-примера (обычный и расширенный). Цены и названия потом можно править в $f."
  SQ_UUID=(); SQ_NAME=()
  local line i=0
  while IFS=$'\t' read -r u nme cnt; do
    [ -n "${u:-}" ] || continue
    SQ_UUID+=("$u"); SQ_NAME+=("$nme"); i=$((i+1))
    say "  $i) $nme  (пользователей: $cnt)"
  done < <(list_squads || true)
  [ "${#SQ_UUID[@]}" -gt 0 ] || warn "Не удалось получить список сквадов, тарифы будут без смены сквадов (поле squads можно вписать вручную)."
  local s1="" s2=""
  if [ "${#SQ_UUID[@]}" -gt 0 ]; then s1="$(pick_squads "Обычный VPN")"; s2="$(pick_squads "VPN + белые списки")"; fi
  cat > "$f" <<EOF
{
  "vpn": {
    "name": "Обычный VPN",
    "desc": "Без белых списков.",
    "squads": [${s1}],
    "prices": { "1": 149, "3": 399, "6": 749, "12": 1299 }
  },
  "wl": {
    "name": "VPN + белые списки",
    "desc": "Все VPN-серверы и белые списки.",
    "squads": [${s2}],
    "prices": { "1": 249, "3": 680, "6": 1270, "12": 2181 }
  }
}
EOF
  if ask_yn "Открыть plans.json в редакторе сейчас?" n; then "${EDITOR:-nano}" "$f" </dev/tty >/dev/tty || true; fi
  docker run --rm -v "$f:/p.json:ro" "$NODE_IMAGE" node -e 'JSON.parse(require("fs").readFileSync("/p.json","utf8"))' || die "plans.json содержит ошибку JSON"
  ok "plans.json готов"
}

write_env_and_compose() {
  [ -f "$DIR/.env" ] && cp -p "$DIR/.env" "$DIR/.env.bak"
  umask 077
  {
    echo "PAY_PROVIDER=$PROVIDER"
    echo "REMNAWAVE_URL=$PANEL_URL"
    echo "REMNAWAVE_API_TOKEN=$RW_TOKEN"
    echo "SUB_PAGE_URL=https://$SUB_DOMAIN"
    if [ "$PROVIDER" = yookassa ]; then
      echo "YK_SHOP_ID=$YK_SHOP"
      echo "YK_SECRET_KEY=$YK_KEY"
      echo "RECEIPT_CONTACT=$RECEIPT"
    else
      echo "PLATEGA_MERCHANT_ID=$PL_ID"
      echo "PLATEGA_SECRET=$PL_SECRET"
      echo "PLATEGA_METHOD=$PL_METHOD"
    fi
  } > "$DIR/.env"
  chmod 600 "$DIR/.env"
  umask 022
  cat > "$DIR/docker-compose.yml" <<EOF
services:
  renew-pay:
    image: $NODE_IMAGE
    container_name: renew-pay
    restart: always
    working_dir: /app
    command: node server.js
    env_file: .env
    volumes:
      - ./server.js:/app/server.js:ro
      - ./renew-button.js:/app/renew-button.js:ro
      - ./data:/data
    ports:
      - '127.0.0.1:3100:3100'
    networks:
      - panel

networks:
  panel:
    name: $NETWORK
    external: true
EOF
  ok "Записаны $DIR/.env (chmod 600) и docker-compose.yml"
}

start_service() {
  step "Запуск сервиса"
  (cd "$DIR" && $COMPOSE up -d --force-recreate >/dev/null 2>&1) || (cd "$DIR" && $COMPOSE up -d --force-recreate)
  local i
  for i in 1 2 3 4 5 6 7 8; do
    sleep 1
    if docker exec renew-pay wget -qO- http://127.0.0.1:3100/health 2>/dev/null | grep -q ok; then ok "Сервис отвечает"; return 0; fi
  done
  docker logs --tail 15 renew-pay >&2 || true
  die "Сервис не запустился, лог выше."
}

# ---------- сценарии ----------
do_install() {
  PAY_MODE="$1"
  need_docker
  step "Какую платёжку использовать?"
  say "  1) YooKassa (ЮKassa): карты, СБП, чеки 54-ФЗ"
  say "  2) Platega: СБП, карты, крипта"
  case "$(ask "Выберите" "1")" in
    2) PROVIDER=platega ;;
    *) PROVIDER=yookassa ;;
  esac
  if [ "$PROVIDER" = yookassa ]; then
    YK_SHOP="$(ask_req "YooKassa shopId")"
    YK_KEY="$(ask_secret "YooKassa секретный ключ")"
    RECEIPT="$(ask "Email или телефон для чеков 54-ФЗ (пусто = без чеков)" "")"
  else
    PL_ID="$(ask_req "Platega MerchantId")"
    PL_SECRET="$(ask_secret "Platega секретный ключ (X-Secret)")"
    PL_METHOD="$(ask "Способ оплаты (2 = СБП, 10 = карты РФ, 13 = крипта)" "2")"
  fi

  step "Remnawave"
  local def_net="remnawave-network" def_panel="http://remnawave:3000"
  if docker inspect remnawave >/dev/null 2>&1; then
    def_net="$(docker inspect -f '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' remnawave | awk '{print $1}')"
  fi
  NETWORK="$(ask_req "Docker-сеть панели" "$def_net")"
  docker network inspect "$NETWORK" >/dev/null 2>&1 || die "Сеть $NETWORK не найдена"
  PANEL_URL="$(ask_req "Адрес панели внутри сети" "$def_panel")"
  RW_TOKEN="$(ask_secret "API-токен Remnawave (Настройки → API-токены)")"
  SUB_DOMAIN="$(ask_req "Домен страницы подписки, без https:// (например sub.example.com)")"
  SUB_DOMAIN="${SUB_DOMAIN#https://}"; SUB_DOMAIN="${SUB_DOMAIN%%/*}"
  if [ "$PAY_MODE" = domain ]; then
    step "Отдельный домен для оплаты"
    PAY_URL="$(ask_req "Публичный адрес оплаты (например https://pay.example.com:8443)")"
    PAY_URL="${PAY_URL%/}"
    [[ "$PAY_URL" == https://* ]] || die "Адрес должен начинаться с https://"
    local hp="${PAY_URL#https://}"; hp="${hp%%/*}"
    PAY_NAME="${hp%%:*}"; PAY_PORT=443; [[ "$hp" == *:* ]] && PAY_PORT="${hp##*:}"
    CERT_CRT=""; CERT_KEY=""
    if ! ask_yn "Взять сертификат из блока страницы подписки (он должен покрывать $PAY_NAME)?" n; then
      say "Пути к сертификату указывайте так, как их видит контейнер nginx."
      CERT_CRT="$(ask_req "ssl_certificate (fullchain)")"
      CERT_KEY="$(ask_req "ssl_certificate_key")"
    fi
  else
    PAY_URL="https://$SUB_DOMAIN/renew-pay"
  fi

  step "Файлы"
  fetch_app
  write_plans
  write_env_and_compose

  local mode; mode="$(docker inspect -f '{{.HostConfig.NetworkMode}}' "${NGINX_CONTAINER:-remnawave-nginx}" 2>/dev/null || echo bridge)"
  if [ "$mode" = host ]; then UPSTREAM="127.0.0.1:3100"; else UPSTREAM="renew-pay:3100"; fi

  start_service
  if ask_yn "Настроить nginx автоматически (страница подписки + server-блок для оплаты)?" y; then setup_nginx
  else warn "nginx пропущен. Добавьте sub_filter и server-блок вручную, см. README."; fi

  step "Проверка снаружи"
  if curl -fsS -m 10 "$PAY_URL/health" 2>/dev/null | grep -q ok; then ok "$PAY_URL/health отвечает"
  else warn "$PAY_URL/health недоступен. Проверьте nginx (docker exec $NGINX nginx -t), а для отдельного домена ещё DNS, порт и сертификат."; fi

  step "Готово"
  if [ "$PROVIDER" = yookassa ]; then
    say "Кабинет YooKassa → Интеграция → HTTP-уведомления:"
    say "  URL:     $PAY_URL/yookassa/webhook"
    say "  Событие: payment.succeeded"
  else
    say "Кабинет Platega → настройки магазина → Callback URL:"
    say "  $PAY_URL/platega/callback"
  fi
  say ""
  say "Тарифы и цены: $DIR/data/plans.json (после правки: cd $DIR && $COMPOSE restart)"
  say "Логи:          docker logs -f renew-pay"
  say "Откройте страницу подписки в режиме инкогнито: кнопка «Продлить» появится в шапке."
}

do_update() {
  need_docker
  [ -f "$DIR/.env" ] || die "$DIR/.env не найден, сначала выполните установку."
  fetch_app
  (cd "$DIR" && $COMPOSE up -d --force-recreate >/dev/null)
  ok "Обновлено и перезапущено"
}

do_uninstall() {
  need_docker
  if ask_yn "Убрать кнопку и server-блок из nginx?" y; then
    detect_nginx
    local tmp; tmp="$(mktemp)"; strip_markers "$CONF" > "$tmp"
    if diff -q "$CONF" "$tmp" >/dev/null; then ok "Маркеров в nginx нет, менять нечего"; else nginx_apply "$tmp"; fi
    rm -f "$tmp"
  fi
  [ -f "$DIR/docker-compose.yml" ] && (cd "$DIR" && $COMPOSE down) || true
  if ask_yn "Удалить каталог $DIR вместе с ключами и списком платежей?" n; then rm -rf "$DIR"; ok "Удалено"; fi
}

MODE="${1:-}"
if [ -z "$MODE" ] || [ "$MODE" = install ]; then
  say ""
  say "${B}remnawave-renew${N}: кнопка «Продлить» для страницы подписки Remnawave"
  say ""
  say "Выберите режим:"
  say "  ${B}1${N}) Всё на домене подписки"
  say "     Сервис оплаты по адресу sub.ваш-домен/renew-pay. Проще всего: используется"
  say "     сертификат сабки, новый DNS и порт не нужны."
  say "  ${B}2${N}) Отдельный домен для оплаты"
  say "     Например pay.ваш-домен:8443. Нужны DNS-запись, открытый порт и сертификат на этот домен."
  say "  ${B}3${N}) Обновить код (если уже установлено)"
  say "  ${B}4${N}) Удалить"
  case "$(ask "Ваш выбор" "1")" in
    2) MODE=domain ;;
    3) MODE=update ;;
    4) MODE=uninstall ;;
    *) MODE=path ;;
  esac
fi
case "$MODE" in
  path|domain) do_install "$MODE" ;;
  update) do_update ;;
  uninstall) do_uninstall ;;
  *) die "Неизвестный режим: $MODE (path | domain | update | uninstall)" ;;
esac
