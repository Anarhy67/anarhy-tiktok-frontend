# ANARHY OS — MVP backend foundation

## Что внутри
- `frontend/` — текущие интерфейсы ANARHY.
- `db/schema.sql` — схема PostgreSQL/Supabase.
- `backend/server.js` — минимальный API-контур.
- `.env.example` — переменные окружения.

## Быстрый запуск

```bash
npm install
cp .env.example .env
npm run dev
```

API будет доступен на `http://localhost:3000`.

## Перед продакшеном
1. Создать проект Supabase/PostgreSQL.
2. Выполнить `db/schema.sql`.
3. Заполнить `.env`.
4. Подключить авторизацию.
5. Подключить платёжный webhook.
6. Настроить домен `anarhy.ru`.

## Важный принцип партнёрки
Комиссия начисляется только после подтверждённой продажи цифрового продукта. Клики и регистрации сами по себе не оплачиваются.
