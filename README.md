# PayPal Delight AI

Конкурсный проект для PayPal AI Hackathon 2026: после подтверждённой сервером
PayPal Sandbox-оплаты покупатель сможет создать один персональный AI-подарок.
Планируемые режимы: **Caricature**, **Greeting Card**, **Mini Comic**.

Сейчас реализован **этап 1 — локальный каркас**: Vue-страница с проверкой соединения
и Fastify API. Оплата, AI-генерация и постоянное хранилище пока не реализованы.
Выбор БД требует отдельного согласования.

## Требования

- Node.js **22.12+ в ветке 22.x**; npm **9+**.
- Windows PowerShell: используйте `npm.cmd`. В Linux/macOS те же команды работают с `npm`.
- Ключи PayPal/OpenAI для первого этапа не нужны.

## Установка

Из каталога репозитория:

```powershell
npm.cmd ci
Copy-Item .env.example .env
```

Копирование `.env` необязательно: значения по умолчанию уже подходят для локального
запуска. Не перезаписывайте существующий `.env` при повторной установке.
После изменения зависимостей используйте `npm.cmd install` и сохраняйте обновлённый
корневой `package-lock.json` вместе с манифестами обоих workspaces.

## Локальная разработка

Откройте два терминала в корне репозитория.

Терминал 1 — backend с перезапуском при изменении исходников:

```powershell
npm.cmd run dev:server
```

Терминал 2 — frontend:

```powershell
npm.cmd run dev:client
```

Откройте **http://127.0.0.1:5173**. На странице появится `Service is connected`.
Оба процесса останавливаются через `Ctrl+C`.

Прямая проверка API:

```powershell
Invoke-RestMethod http://127.0.0.1:8003/api/health
```

Ожидается HTTP 200 и JSON:

```json
{"status":"ok","service":"paypal-delight-ai"}
```

Frontend вызывает относительный `/api/health`. Vite перенаправляет `/api` в backend
без удаления префикса. Дополнительная настройка CORS не требуется.
Порты frontend фиксированы: при занятом порте Vite сообщает ошибку, а не выбирает другой.

## Сборка и проверки

```powershell
npm.cmd run typecheck
npm.cmd run build
npm.cmd test
npm.cmd run test:smoke
```

- `typecheck` проверяет TypeScript, Vue-компоненты и конфигурацию Vite.
- `build` создаёт `client/dist/` и `server/dist/index.js`.
- `test` собирает backend и запускает встроенный `node:test`: health, неизвестный
  маршрут и валидация конфигурации. Fastify `inject` не требует свободного TCP-порта.
- `test:smoke` требует предварительной сборки. Он запускает настоящий собранный
  backend, Vite dev и Vite preview на временных loopback-портах; проверяет HTTP,
  статику и `/api/health` через proxy. После проверки процессы закрываются.

Проверка собранного приложения вручную, также в двух терминалах:

```powershell
# Терминал 1
npm.cmd start
```

```powershell
# Терминал 2
npm.cmd run preview
```

Frontend: **http://127.0.0.1:4173**. Preview предназначен для локальной проверки сборки.

## Конфигурация

| Переменная | По умолчанию | Назначение |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Адрес, на котором слушает Fastify |
| `PORT` | `8003` | TCP-порт Fastify, целое число от 1 до 65535 |

Backend читает `.env` из корня репозитория встроенным механизмом Node.js;
существующие переменные окружения имеют приоритет. Без `.env` сервер также запускается.
Vite использует `HOST`/`PORT` для настройки своего локального proxy. После изменения
этих значений перезапустите оба процесса. Для одинаковой локальной конфигурации
используйте корневой `.env`, а не отдельные Vite `.env.development`/`.env.local`.

`.env`, сборки, `node_modules`, npm cache и приватный инфраструктурный отчёт исключены
из Git. Не помещайте серверные секреты в переменные `VITE_*`: они доступны браузеру.

## Структура

```text
client/
  index.html
  package.json
  tsconfig.json
  vite.config.ts
  src/
    App.vue
    main.ts
    style.css
server/
  package.json
  tsconfig.json
  src/
    app.ts
    config.ts
    index.ts
  test/
    app.test.mjs
    config.test.mjs
tests/
  smoke.test.mjs
.env.example
.gitignore
.nvmrc
package.json
package-lock.json
tsconfig.base.json
README.md
LICENSE
```

## Контракт будущего развёртывания

Каркас совместим со схемой отдельных release directories и переключением `current`:

- frontend — статические файлы `client/dist/`, которые сможет отдавать Nginx;
- backend — `node server/dist/index.js` из корня релиза;
- релизу нужны корневые `package.json`, `package-lock.json`, оба workspace
  `package.json` и обе директории `dist`;
- runtime-зависимости устанавливаются командой `npm ci --omit=dev` на целевой ОС;
  Windows `node_modules` не переносятся;
- systemd сможет передавать `HOST`, `PORT` и будущие серверные настройки через
  окружение; runtime не требует TypeScript, tsx или Vite;
- Nginx должен сохранять префикс `/api` при проксировании к backend.

Deployment и настройка VPS в первый этап не входят. Конфигурации Nginx/systemd,
домен, хранилище и дальнейшие архитектурные решения согласовываются отдельно.
Приватный документ передачи инфраструктуры хранится вне репозитория.
