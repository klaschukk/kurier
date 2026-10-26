#!/usr/bin/env bash
# Ставит приложение на свой поддомен с настоящим сертификатом (Let's Encrypt).
# Перед запуском: A-запись DOMAIN -> IP этого сервера.
# Запуск: sudo bash /home/kurier/deploy/install.sh [домен]
set -euo pipefail
DOMAIN="${1:-klaschuk.otto-web.online}"
ROOT=/home/kurier/public
CONF=/etc/nginx/sites-available/$DOMAIN

ip_here=$(curl -s4 ifconfig.me || true)
ip_dns=$(getent ahostsv4 "$DOMAIN" | awk 'NR==1{print $1}')
if [ -z "$ip_dns" ] || [ "$ip_dns" != "$ip_here" ]; then
  echo "DNS: $DOMAIN -> '${ip_dns:-нет записи}', а сервер $ip_here. Добавь A-запись и подожди пару минут." >&2
  exit 1
fi

cat > "$CONF" <<NGINX
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;
    root $ROOT;
    index index.html;
    add_header X-Robots-Tag "noindex, nofollow" always;
    location = /sw.js { add_header Cache-Control "no-cache" always; try_files \$uri =404; }
    location = /index.html { add_header Cache-Control "no-cache" always; }
    location / { try_files \$uri \$uri/ /index.html; }
}
NGINX

ln -sf "$CONF" /etc/nginx/sites-enabled/$DOMAIN
nginx -t
systemctl reload nginx
certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --redirect --register-unsafely-without-email
echo "Готово: https://$DOMAIN/"
