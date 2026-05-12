# Backend

## Setup

1. Install dependencies

```bash
bun install
```

2. Configure database

Create `.env` in `backend/`:

```bash
DATABASE_URL="postgresql://USER:PASSWORD@HOST:5432/DB_NAME?schema=public"
```

3. Generate Prisma client and run migrations

```bash
bun run prisma:generate
bun run prisma:migrate
```

4. Start server

```bash
bun run start
```

Server runs on `http://localhost:3000`.

## Implemented DB schema

- `User`
- `Stock`
- `Order`
- `Fill`
- `AccountBalance` (cash: INR free/locked)
- `StockBalance` (per-stock free/locked)

Enums:

- `OrderSide` (`BUY`, `SELL`)
- `OrderType` (`LIMIT`, `MARKET`)
- `OrderStatus` (`OPEN`, `PARTIALLY_FILLED`, `FILLED`, `CANCELLED`)

## Implemented endpoints

- `POST /signup`
- `POST /signin`
- `POST /order`
- `GET /order/:orderId`
- `DELETE /order/:orderId`
- `GET /depth/:symbol`
- `GET /orders`
- `GET /fills`
- `GET /balance/usd`
- `GET /balance`
- `GET /stocks`
