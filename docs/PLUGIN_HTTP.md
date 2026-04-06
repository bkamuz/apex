# Внешние плагины и REST API

Сервер (`server/`) поднимает OpenAPI-совместимый REST. Интерактивная документация: **http://localhost:8787/documentation** (порт задаётся переменной `PORT`, по умолчанию `8787`).

## Запуск

Из корня репозитория:

```bash
npm run dev:api
```

Вместе с фронтендом (прокси `/api` на Vite):

```bash
npm run dev:all
```

В production-сборке Vite прокси не используется: нужен обратный прокси (nginx и т.п.) с тем же префиксом `/api` на бэкенд или отключите синхронизацию, если API недоступен.

## Основные операции

### Проверка живости

```bash
curl -s http://localhost:8787/api/v1/health
```

### Снимок элементов проекта

Клиент при изменениях документа шлёт debounced `PUT` на `/api/v1/projects/default/elements` (тело — JSON с полями `projectId`, `updatedAt`, `elements`).

Прочитать снимок:

```bash
curl -s http://localhost:8787/api/v1/projects/default/elements
```

До первого `PUT` проект отсутствует — ответ `404`.

### Один элемент

```bash
curl -s "http://localhost:8787/api/v1/projects/default/elements/ifc-123"
```

## Расширение

Новые маршруты добавляйте в `server/src/routes.ts`, схемы для Swagger — в `schema` каждого хендлера. Типы DTO синхронизируйте с `shared/dto.ts`.
