# Закрытый тестовый deployment

URL: https://91-99-101-189.sslip.io

Приложение работает только с PayPal Sandbox. По умолчанию `AI_PROVIDER=mock`;
Cloudflare включается отдельным разрешённым deployment. Все страницы,
статические файлы и API закрыты Nginx Basic Auth по HTTPS. На HTTP доступен только
ACME challenge, остальные запросы перенаправляются на HTTPS. Backend слушает
`127.0.0.1:8003`; открывать этот порт наружу не требуется.

## Вход

Данные входа первого deployment хранятся у владельца в отдельном защищённом
локальном файле, исключённом из Git.
Откройте URL и введите их в стандартном окне авторизации браузера. Пароль не
передавайте в URL, командной строке, чате или Git. Это отдельный пароль тестового
сайта, а не учётная запись PayPal.

Для покупки используйте Sandbox Personal account, отличный от продавца. Заказы
локального localhost-магазина не переносились: на VPS создана новая SQLite.

## Установленные объекты

- `/var/www/paypal-delight-ai/releases/<UTC timestamp>-<SHA>` — отдельные релизы.
- `/var/www/paypal-delight-ai/current` — атомарно переключаемый symlink.
- `/var/www/paypal-delight-ai/shared/delight-stage5.sqlite` — текущая БД, режим 600;
  каталог shared имеет режим 700, владелец `paypal-delight`.
- `/etc/paypal-delight-ai/runtime.env` — Sandbox-настройки, root:root 600.
- `/etc/nginx/paypal-delight-ai.htpasswd` — только хеш пароля, root:www-data 640.
- `/etc/systemd/system/paypal-delight-ai.service` — отдельный runtime-пользователь,
  автозапуск, запись только в shared, ограничение памяти 768 MiB.
- `/etc/nginx/sites-available/paypal-delight-ai` — новый vhost; соседние сайты не меняются.
- `/etc/letsencrypt/live/paypal-delight-ai/` — отдельный сертификат; продление через
  существующий `certbot.timer`, webroot в `acme/`, deploy-hook проверяет и reload Nginx.
- `/var/www/paypal-delight-ai/ops/` — activate-release.sh, rollback.sh и контрольные
  сведения deployment; `/backups/` — закрытые копии runtime и Nginx для отката.

NGINX ограничивает upload 8 MiB, backend — 7 MiB JSON/base64 и 5 MiB / 16 MP самого
фото. Proxy request buffering отключён, буфер тела 8 MiB: оригинальные фото не
сохраняются в Nginx temporary request-body files. Authorization удаляется перед proxy.

## Следующее обновление кода

Публикация выполняется только по разрешению владельца. После проверки и согласованного
commit изменений в `main` (рабочее дерево должно быть чистым) запустите из корня:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\deploy\publish.ps1
```

Скрипт запускает typecheck и build, без тестовых наборов. Архив содержит только
package manifests/lockfile, `client/dist` и `server/dist`; без .env, SQLite, Git и
Windows node_modules. Временный архив удаляется локально после публикации и на
сервере после распаковки. Доставка — SCP с проверкой SSH host key. На Linux выполняется
`npm ci --omit=dev`, проверяются native SQLite/Sharp. Stage 5 использует отдельную
`shared/delight-stage5.sqlite`; прежняя `shared/delight.sqlite` не мигрируется.
Переключается current и перезапускается **только** PayPal-сервис. На время активации
закрывается только этот сайт. При ошибке health возвращаются прежний код, runtime
с прежним путём БД и Nginx. Файлы баз данных не восстанавливаются поверх друг друга.

После публикации проверьте HTTPS, вход, каталог, API и кнопку PayPal без автоматической
оплаты. Обычный deployment не меняет systemd/Nginx, сертификат, пароль и runtime.env.
Изменение инфраструктурных файлов из этой папки требует отдельной установки; скрипт
publish.ps1 не переписывает их автоматически. Docker и GitHub Actions не используются.

## Откат

После хотя бы одного успешного обновления:

```powershell
ssh -o StrictHostKeyChecking=yes root@91.99.101.189 /var/www/paypal-delight-ai/ops/rollback.sh
```

Скрипт возвращает предыдущий релиз и проверяет health. На первом deployment предыдущего
релиза ещё нет; неудачная первая активация останавливает только PayPal-сервис.
Откат восстанавливает runtime и Nginx из `backups/before-<текущий релиз>`.
После очистки сохраняются текущий релиз, один предыдущий релиз и настройки для
отката к нему. Старые релизы и backups автоматически не удаляются.

## Диагностика

```powershell
ssh root@91.99.101.189 systemctl status paypal-delight-ai.service --no-pager
ssh root@91.99.101.189 curl -fsS http://127.0.0.1:8003/api/health
ssh root@91.99.101.189 certbot renew --cert-name paypal-delight-ai --dry-run --no-random-sleep-on-renew
```

Не выводите runtime.env, htpasswd, ключи TLS или подробные данные заказов в отчёты.
Пароль менять через отдельный защищённый ввод; новые значения не добавлять в этот файл.
Юридические placeholders остаются черновиками: перед публичным открытием доступа
владелец заполняет и проверяет их. В этом deployment свободного публичного доступа нет.

## Подготовленный deployment Cloudflare (выполняет разработчик после разрешения)

`publish.ps1 -EnableCloudflareLab` использует существующий release/systemd/Nginx механизм.
Он проверяет подтверждение Workers Free и локальные credentials без внешнего API,
передаёт allowlist настроек через SSH stdin, сохраняет их в root-only staging вне
релизов, обновляет только vhost этого приложения и его activation script.
Cloudflare API Token не попадает в аргументы процесса, Git или tar-архив.
Новый внутренний proxy token создаётся автоматически и подставляется Nginx только
после штатной Basic Auth. Клиентский одноимённый заголовок перезаписывается.
Параметры PayPal и пароль сайта не меняются. Для Stage 5 выбирается отдельная SQLite.
Три соседних сервиса не перезапускаются. Разрешение Cloudflare — 512×512.

После публикации владелец открывает `/ai-lab` под существующим паролем и создаёт
изображения кнопкой. Автоматическая проверка deployment никогда не генерирует AI.
Действуют общий бюджет 50 попыток / 8000 расчётных Neurons, два одновременных запроса,
фиксированная модель FLUX.2 klein 4B и отсутствие платных fallback.
Тестовые PNG, ошибки и расход хранятся отдельно от заказов; повторы одного ID идемпотентны.
Новый тест после ошибки разрешён вручную без сброса израсходованного бюджета.

Публикация и очистка сервера выполняются только по разрешению владельца.
