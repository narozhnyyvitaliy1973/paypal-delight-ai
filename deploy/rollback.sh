#!/bin/bash
set -euo pipefail
APP=/var/www/paypal-delight-ai
exec 9>"$APP/ops/deploy.lock"
flock -n 9
test -f "$APP/ops/previous-release"
PREVIOUS=$(cat "$APP/ops/previous-release")
CURRENT=$(readlink -f "$APP/current")
[[ "$PREVIOUS" == "$APP/releases/"* && "$CURRENT" == "$APP/releases/"* ]]
test -d "$PREVIOUS"
test "$PREVIOUS" != "$CURRENT"
test ! -e "$APP/current.rollback"
BACKUP="$APP/backups/before-$(basename "$CURRENT")"
test -f "$BACKUP/runtime.env"
test -f "$BACKUP/nginx.conf"
SAVED="$APP/backups/rollback-$(basename "$CURRENT")"
install -d -m 0700 "$SAVED"
cp -p /etc/paypal-delight-ai/runtime.env "$SAVED/runtime.env"
cp -p /etc/nginx/sites-available/paypal-delight-ai "$SAVED/nginx.conf"
if [[ -f /etc/paypal-delight-ai/nginx/lab.conf ]]; then
    cp -p /etc/paypal-delight-ai/nginx/lab.conf "$SAVED/lab.conf"
fi
restore_config() {
    cp -p "$1/runtime.env" /etc/paypal-delight-ai/runtime.env
    cp -p "$1/nginx.conf" /etc/nginx/sites-available/paypal-delight-ai
    if [[ -f "$1/lab.conf" ]]; then
        cp -p "$1/lab.conf" /etc/paypal-delight-ai/nginx/lab.conf
    else
        rm -f /etc/paypal-delight-ai/nginx/lab.conf
    fi
    nginx -t
    systemctl reload nginx
}
restore() {
    code=$?
    trap - ERR
    restore_config "$SAVED"
    ln -s "$CURRENT" "$APP/current.restore"
    mv -Tf "$APP/current.restore" "$APP/current"
    systemctl restart paypal-delight-ai.service
    exit "$code"
}
trap restore ERR
touch "$APP/maintenance"
systemctl stop paypal-delight-ai.service
restore_config "$BACKUP"
ln -s "$PREVIOUS" "$APP/current.rollback"
mv -Tf "$APP/current.rollback" "$APP/current"
systemctl restart paypal-delight-ai.service
curl --fail --silent --show-error --retry 15 --retry-connrefused --retry-delay 1 --max-time 4 http://127.0.0.1:8003/api/health
rm -f "$APP/maintenance"
trap - ERR
echo
echo 'Previous PayPal release and runtime restored; database files unchanged.'
