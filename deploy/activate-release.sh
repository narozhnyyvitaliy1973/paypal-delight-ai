#!/bin/bash
# Run as root, only for this application. Never restarts adjacent services.
set -euo pipefail
APP=/var/www/paypal-delight-ai
RELEASE_ID=${1:?Usage: activate-release.sh RELEASE_ID ARCHIVE}
ARCHIVE=${2:?Archive required}
[[ "$RELEASE_ID" =~ ^[0-9]{8}T[0-9]{6}Z-[a-f0-9]{7,40}$ ]] || exit 2
[[ "$ARCHIVE" == "/tmp/paypal-delight-$RELEASE_ID.tar.gz" ]] || exit 2
test -f "$ARCHIVE"
test -f /etc/paypal-delight-ai/runtime.env
test -f /etc/systemd/system/paypal-delight-ai.service
exec 9>"$APP/ops/deploy.lock"
flock -n 9
RELEASE="$APP/releases/$RELEASE_ID"
test ! -e "$RELEASE"
python3 - "$ARCHIVE" <<'PY'
import sys, tarfile
from pathlib import PurePosixPath
with tarfile.open(sys.argv[1]) as archive:
    for item in archive.getmembers():
        p = PurePosixPath(item.name)
        allowed = item.name in ('package.json','package-lock.json','client/package.json','server/package.json','client/dist','server/dist') or item.name.startswith(('client/dist/','server/dist/'))
        if not allowed or p.is_absolute() or '..' in p.parts or not (item.isfile() or item.isdir()):
            raise SystemExit('Unsafe or unexpected archive member')
PY
install -d -m 0755 -o deploy -g www-data "$RELEASE"
tar -xzf "$ARCHIVE" -C "$RELEASE" --no-same-owner
rm -f -- "$ARCHIVE"
chown -R deploy:www-data "$RELEASE"
install -d -m 0700 -o deploy -g deploy "$APP/build-cache"
runuser -u deploy -- env npm_config_cache="$APP/build-cache" npm ci --omit=dev --no-audit --no-fund --prefix "$RELEASE"
test -f "$RELEASE/server/dist/index.js"
test -f "$RELEASE/server/dist/assets/mock-caricature.png"
test -f "$RELEASE/client/dist/index.html"
runuser -u paypal-delight -- node --input-type=module - "$RELEASE" <<'JS'
import {createRequire} from 'node:module';
const require = createRequire(process.argv[2] + '/package.json');
const Database = require('better-sqlite3');
const db = new Database(':memory:'); db.prepare('select 1').get(); db.close();
const sharp = require('sharp');
await sharp(process.argv[2] + '/server/dist/assets/mock-caricature.png').metadata();
console.log('Linux native dependencies: OK');
JS
PREVIOUS=
if [[ -L "$APP/current" ]]; then PREVIOUS=$(readlink -f "$APP/current");
elif [[ -e "$APP/current" ]]; then echo 'current must be a symlink' >&2; exit 1; fi
if [[ -n "$PREVIOUS" ]]; then
    [[ "$PREVIOUS" == "$APP/releases/"* ]] && test -d "$PREVIOUS"
fi
BACKUP="$APP/backups/before-$RELEASE_ID"
install -d -m 0700 "$BACKUP"
cp -p /etc/paypal-delight-ai/runtime.env "$BACKUP/runtime.env"
cp -p /etc/nginx/sites-available/paypal-delight-ai "$BACKUP/nginx.conf"
if [[ -f /etc/paypal-delight-ai/nginx/lab.conf ]]; then
    cp -p /etc/paypal-delight-ai/nginx/lab.conf "$BACKUP/lab.conf"
fi
STAGED="/etc/paypal-delight-ai/next-$RELEASE_ID"
CONFIG_CHANGED=0
rollback() {
    code=$?
    trap - ERR
    set +e
    systemctl stop paypal-delight-ai.service
    # Each stage keeps its own database. Restore the previous path, never its data.
    cp -p "$BACKUP/runtime.env" /etc/paypal-delight-ai/runtime.env
    if [[ -f "$BACKUP/lab.conf" ]]; then
        cp -p "$BACKUP/lab.conf" /etc/paypal-delight-ai/nginx/lab.conf
    elif [[ "$CONFIG_CHANGED" == 1 ]]; then
        rm -f /etc/paypal-delight-ai/nginx/lab.conf
    fi
    if [[ -n "$PREVIOUS" ]]; then
        ln -s "$PREVIOUS" "$APP/current.rollback"
        mv -Tf "$APP/current.rollback" "$APP/current"
        systemctl restart paypal-delight-ai.service
        if curl --fail --silent --retry 15 --retry-connrefused --retry-delay 1 --max-time 4 http://127.0.0.1:8003/api/health >/dev/null; then
            cp -p "$BACKUP/nginx.conf" /etc/nginx/sites-available/paypal-delight-ai
            if nginx -t && systemctl reload nginx; then rm -f "$APP/maintenance"; fi
        fi
        echo 'Activation failed; previous PayPal release and runtime restored. Databases were not replaced.' >&2
    else
        systemctl stop paypal-delight-ai.service || true
        echo 'First activation failed; only PayPal service stopped.' >&2
    fi
    exit "$code"
}
trap rollback ERR
# Only this vhost enters maintenance. Adjacent services are never restarted.
touch "$APP/maintenance"
install -d -m 0700 /etc/paypal-delight-ai/nginx
install -m 0644 "$APP/ops/nginx-paypal-delight-ai.conf" /etc/nginx/sites-available/paypal-delight-ai
nginx -t
systemctl reload nginx
# Graceful stop drains already accepted requests before switching runtime settings.
systemctl stop paypal-delight-ai.service
if [[ -f "$STAGED.env" ]]; then
    test -f "$STAGED.conf"
    install -m 0600 "$STAGED.env" /etc/paypal-delight-ai/runtime.env
    install -m 0600 "$STAGED.conf" /etc/paypal-delight-ai/nginx/lab.conf
    CONFIG_CHANGED=1
    nginx -t
    systemctl reload nginx
fi
test ! -e "$APP/current.next"
ln -s "$RELEASE" "$APP/current.next"
mv -Tf "$APP/current.next" "$APP/current"
systemctl restart paypal-delight-ai.service
curl --fail --silent --show-error --retry 15 --retry-connrefused --retry-delay 1 --max-time 4 http://127.0.0.1:8003/api/health
if [[ -n "$PREVIOUS" ]]; then printf '%s\n' "$PREVIOUS" > "$APP/ops/previous-release"; fi
rm -f "$APP/maintenance" "$STAGED.env" "$STAGED.conf"
trap - ERR
echo
printf 'Active release: %s\n' "$RELEASE_ID"
