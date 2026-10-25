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
restore() {
    code=$?
    trap - ERR
    ln -s "$CURRENT" "$APP/current.restore"
    mv -Tf "$APP/current.restore" "$APP/current"
    systemctl restart paypal-delight-ai.service
    exit "$code"
}
trap restore ERR
ln -s "$PREVIOUS" "$APP/current.rollback"
mv -Tf "$APP/current.rollback" "$APP/current"
systemctl restart paypal-delight-ai.service
curl --fail --silent --show-error --retry 15 --retry-connrefused --retry-delay 1 --max-time 4 http://127.0.0.1:8003/api/health
printf '%s\n' "$CURRENT" > "$APP/ops/previous-release"
trap - ERR
echo
echo 'Previous PayPal code release restored; shared DB and configuration unchanged.'
