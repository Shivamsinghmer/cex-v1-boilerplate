import express from "express";
import type { Request } from "express";
import { PrismaClient, OrderSide, OrderStatus, OrderType } from "@prisma/client/index.js";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

const app = express();
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required");
}
const pool = new Pool({ connectionString: databaseUrl });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

app.use(express.json());


const INR_CURRENCY = "INR";

type BookOrder = {
  orderId: number;
  userId: number;
  qty: number;
  filledQty: number;
  createdAt: string;
};

type PriceLevel = {
  totalQty: number;
  orders: BookOrder[];
};

type SymbolOrderBook = {
  bids: Map<number, PriceLevel>;
  asks: Map<number, PriceLevel>;
};

const ORDERBOOKS = new Map<string, SymbolOrderBook>();
const SYMBOL_BY_STOCK_ID = new Map<number, string>();

function ensureBook(symbol: string): SymbolOrderBook {
  const normalized = symbol.toUpperCase();
  const book = ORDERBOOKS.get(normalized);
  if (book) {
    return book;
  }

  const nextBook: SymbolOrderBook = {
    bids: new Map<number, PriceLevel>(),
    asks: new Map<number, PriceLevel>(),
  };

  ORDERBOOKS.set(normalized, nextBook);
  return nextBook;
}

function getSideMap(book: SymbolOrderBook, side: OrderSide): Map<number, PriceLevel> {
  return side === OrderSide.BUY ? book.bids : book.asks;
}

function addOrderToBook(order: {
  id: number;
  userId: number;
  side: OrderSide;
  type: OrderType;
  price: number | null;
  qty: number;
  filledQty: number;
  createdAt: Date;
  stockId: number;
}): void {
  if (order.type !== OrderType.LIMIT || order.price === null) {
    return;
  }

  const remainingQty = order.qty - order.filledQty;
  if (remainingQty <= 0) {
    return;
  }

  const symbol = SYMBOL_BY_STOCK_ID.get(order.stockId);
  if (!symbol) {
    return;
  }

  const book = ensureBook(symbol);
  const sideMap = getSideMap(book, order.side);
  const level = sideMap.get(order.price) ?? { totalQty: 0, orders: [] };

  level.totalQty += remainingQty;
  level.orders.push({
    orderId: order.id,
    userId: order.userId,
    qty: order.qty,
    filledQty: order.filledQty,
    createdAt: order.createdAt.toISOString(),
  });

  sideMap.set(order.price, level);
}

function reduceOrderFromBook(order: {
  id: number;
  side: OrderSide;
  stockId: number;
  price: number | null;
}, reductionQty: number): void {
  if (order.price === null || reductionQty <= 0) {
    return;
  }

  const symbol = SYMBOL_BY_STOCK_ID.get(order.stockId);
  if (!symbol) {
    return;
  }

  const book = ORDERBOOKS.get(symbol);
  if (!book) {
    return;
  }

  const sideMap = getSideMap(book, order.side);
  const level = sideMap.get(order.price);
  if (!level) {
    return;
  }

  level.totalQty = Math.max(0, level.totalQty - reductionQty);

  const restingOrder = level.orders.find((entry) => entry.orderId === order.id);
  if (restingOrder) {
    restingOrder.filledQty += reductionQty;
  }

  const maybeOrder = level.orders.find((entry) => entry.orderId === order.id);
  if (maybeOrder && maybeOrder.filledQty >= maybeOrder.qty) {
    level.orders = level.orders.filter((entry) => entry.orderId !== order.id);
  }

  if (level.totalQty <= 0 || level.orders.length === 0) {
    sideMap.delete(order.price);
  } else {
    sideMap.set(order.price, level);
  }
}

function removeOrderFromBook(order: {
  id: number;
  side: OrderSide;
  stockId: number;
  price: number | null;
  qty: number;
  filledQty: number;
}): void {
  if (order.price === null) {
    return;
  }

  const remainingQty = order.qty - order.filledQty;
  if (remainingQty <= 0) {
    return;
  }

  const symbol = SYMBOL_BY_STOCK_ID.get(order.stockId);
  if (!symbol) {
    return;
  }

  const book = ORDERBOOKS.get(symbol);
  if (!book) {
    return;
  }

  const sideMap = getSideMap(book, order.side);
  const level = sideMap.get(order.price);
  if (!level) {
    return;
  }

  level.totalQty = Math.max(0, level.totalQty - remainingQty);
  level.orders = level.orders.filter((entry) => entry.orderId !== order.id);

  if (level.totalQty <= 0 || level.orders.length === 0) {
    sideMap.delete(order.price);
  } else {
    sideMap.set(order.price, level);
  }
}

function getDepth(symbol: string): { bids: Record<string, PriceLevel>; asks: Record<string, PriceLevel> } {
  const normalized = symbol.toUpperCase();
  const book = ORDERBOOKS.get(normalized);
  if (!book) {
    return { bids: {}, asks: {} };
  }

  const bids = Object.fromEntries(
    [...book.bids.entries()]
      .sort((a, b) => b[0] - a[0])
      .map(([price, level]) => [
        price.toString(),
        {
          totalQty: level.totalQty,
          orders: level.orders,
        },
      ]),
  );

  const asks = Object.fromEntries(
    [...book.asks.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([price, level]) => [
        price.toString(),
        {
          totalQty: level.totalQty,
          orders: level.orders,
        },
      ]),
  );

  return { bids, asks };
}

function getUserId(req: Request): number | null {
  const fromHeader = req.header("x-user-id");
  if (fromHeader) {
    const parsed = Number(fromHeader);
    if (Number.isInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }

  const fromBody = req.body && typeof req.body === "object" ? (req.body as { userId?: unknown }).userId : undefined;
  if (typeof fromBody === "number" && Number.isInteger(fromBody) && fromBody > 0) {
    return fromBody;
  }

  const fromQuery = req.query.userId;
  if (typeof fromQuery === "string") {
    const parsed = Number(fromQuery);
    if (Number.isInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return null;
}

async function ensureCashBalance(userId: number) {
  const existing = await prisma.accountBalance.findUnique({
    where: {
      userId_currency: {
        userId,
        currency: INR_CURRENCY,
      },
    },
  });

  if (existing) {
    return existing;
  }

  return prisma.accountBalance.create({
    data: {
      userId,
      currency: INR_CURRENCY,
      total: 0,
      locked: 0,
    },
  });
}

async function ensureStockBalance(userId: number, stockId: number) {
  const existing = await prisma.stockBalance.findUnique({
    where: {
      userId_stockId: {
        userId,
        stockId,
      },
    },
  });

  if (existing) {
    return existing;
  }

  return prisma.stockBalance.create({
    data: {
      userId,
      stockId,
      total: 0,
      locked: 0,
    },
  });
}

async function lockBuyFunds(userId: number, price: number, qty: number): Promise<void> {
  const amount = price * qty;
  const cash = await ensureCashBalance(userId);

  if (cash.total < amount) {
    throw new Error("Insufficient INR balance for buy LIMIT order");
  }

  await prisma.accountBalance.update({
    where: {
      userId_currency: {
        userId,
        currency: INR_CURRENCY,
      },
    },
    data: {
      total: { decrement: amount },
      locked: { increment: amount },
    },
  });
}

async function unlockBuyFunds(userId: number, amount: number): Promise<void> {
  if (amount <= 0) {
    return;
  }

  await prisma.accountBalance.update({
    where: {
      userId_currency: {
        userId,
        currency: INR_CURRENCY,
      },
    },
    data: {
      total: { increment: amount },
      locked: { decrement: amount },
    },
  });
}

async function lockSellQty(userId: number, stockId: number, qty: number): Promise<void> {
  const stockBalance = await ensureStockBalance(userId, stockId);

  if (stockBalance.total < qty) {
    throw new Error("Insufficient stock quantity for sell LIMIT order");
  }

  await prisma.stockBalance.update({
    where: {
      userId_stockId: { userId, stockId },
    },
    data: {
      total: { decrement: qty },
      locked: { increment: qty },
    },
  });
}

async function unlockSellQty(userId: number, stockId: number, qty: number): Promise<void> {
  if (qty <= 0) {
    return;
  }

  await prisma.stockBalance.update({
    where: {
      userId_stockId: { userId, stockId },
    },
    data: {
      total: { increment: qty },
      locked: { decrement: qty },
    },
  });
}

async function getStockByMarketId(marketId: string) {
  const trimmed = marketId.trim();
  const asNumber = Number(trimmed);
  if (Number.isInteger(asNumber) && asNumber > 0) {
    return prisma.stock.findUnique({
      where: { id: asNumber },
    });
  }

  return prisma.stock.findUnique({
    where: { symbol: trimmed.toUpperCase() },
  });
}

app.post("/signup", async (req, res) => {
  const username = typeof req.body?.username === "string" ? req.body.username.trim() : "";
  const password = typeof req.body?.password === "string" ? req.body.password : "";

  if (!username || !password) {
    return res.status(400).json({ error: "username and password are required" });
  }

  try {
    const user = await prisma.user.create({
      data: {
        username,
        password,
      },
    });

    await prisma.accountBalance.create({
      data: {
        userId: user.id,
        currency: INR_CURRENCY,
        total: 100_000,
        locked: 0,
      },
    });

    return res.status(201).json({
      userId: user.id,
      username: user.username,
    });
  } catch (error) {
    return res.status(409).json({
      error: "username already exists",
      details: error instanceof Error ? error.message : "unknown error",
    });
  }
});

app.post("/signin", async (req, res) => {
  const username = typeof req.body?.username === "string" ? req.body.username.trim() : "";
  const password = typeof req.body?.password === "string" ? req.body.password : "";

  if (!username || !password) {
    return res.status(400).json({ error: "username and password are required" });
  }

  const user = await prisma.user.findUnique({ where: { username } });
  if (!user || user.password !== password) {
    return res.status(401).json({ error: "invalid username/password" });
  }

  return res.json({
    userId: user.id,
    username: user.username,
  });
});

app.post("/order", async (req, res) => {
  const userId = getUserId(req);
  if (!userId) {
    return res.status(401).json({ error: "missing user id (x-user-id header or userId field)" });
  }

  const sideText = typeof req.body?.side === "string" ? req.body.side.toUpperCase() : "";
  const typeText = typeof req.body?.type === "string" ? req.body.type.toUpperCase() : "";
  const qty = Number(req.body?.qty);
  const marketId = typeof req.body?.market_id === "string" ? req.body.market_id : "";
  const rawPrice = req.body?.price;

  if (!["BUY", "SELL"].includes(sideText)) {
    return res.status(400).json({ error: "side must be buy or sell" });
  }

  if (!["MARKET", "LIMIT"].includes(typeText)) {
    return res.status(400).json({ error: "type must be market or limit" });
  }

  if (!Number.isInteger(qty) || qty <= 0) {
    return res.status(400).json({ error: "qty must be a positive integer" });
  }

  if (!marketId) {
    return res.status(400).json({ error: "market_id is required" });
  }

  const side = sideText as OrderSide;
  const type = typeText as OrderType;

  const parsedPrice = rawPrice === null || rawPrice === undefined ? null : Number(rawPrice);
  const price = parsedPrice !== null && Number.isFinite(parsedPrice) ? parsedPrice : null;

  if (type === OrderType.LIMIT && (price === null || price <= 0)) {
    return res.status(400).json({ error: "price must be a positive number for limit orders" });
  }

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    return res.status(401).json({ error: "invalid user" });
  }

  const stock = await getStockByMarketId(marketId);
  if (!stock) {
    return res.status(404).json({ error: "market not found" });
  }

  await ensureCashBalance(userId);
  await ensureStockBalance(userId, stock.id);

  try {
    if (type === OrderType.LIMIT && side === OrderSide.BUY && price !== null) {
      await lockBuyFunds(userId, price, qty);
    }

    if (type === OrderType.LIMIT && side === OrderSide.SELL) {
      await lockSellQty(userId, stock.id, qty);
    }

    if (type === OrderType.MARKET && side === OrderSide.SELL) {
      const sellerStock = await ensureStockBalance(userId, stock.id);
      if (sellerStock.total < qty) {
        return res.status(400).json({ error: "insufficient stock quantity for market sell order" });
      }
    }
  } catch (error) {
    return res.status(400).json({
      error: error instanceof Error ? error.message : "balance check failed",
    });
  }

  const incomingOrder = await prisma.order.create({
    data: {
      userId,
      side,
      type,
      stockId: stock.id,
      price: type === OrderType.LIMIT ? price : null,
      qty,
      filledQty: 0,
      status: OrderStatus.OPEN,
    },
  });

  let remaining = qty;
  let filledQty = 0;
  let tradedValue = 0;

  const opposingSide = side === OrderSide.BUY ? OrderSide.SELL : OrderSide.BUY;
  const priceFilter =
    type === OrderType.LIMIT && price !== null
      ? side === OrderSide.BUY
        ? { lte: price }
        : { gte: price }
      : undefined;

  const opposingOrders = await prisma.order.findMany({
    where: {
      stockId: stock.id,
      side: opposingSide,
      type: OrderType.LIMIT,
      status: { in: [OrderStatus.OPEN, OrderStatus.PARTIALLY_FILLED] },
      ...(priceFilter ? { price: priceFilter } : {}),
    },
    orderBy: [
      {
        price: side === OrderSide.BUY ? "asc" : "desc",
      },
      {
        createdAt: "asc",
      },
    ],
  });

  for (const opposite of opposingOrders) {
    if (remaining <= 0) {
      break;
    }

    const availableQty = opposite.qty - opposite.filledQty;
    if (availableQty <= 0 || opposite.price === null) {
      continue;
    }

    let fillQty = Math.min(remaining, availableQty);
    const executionPrice = opposite.price;

    if (side === OrderSide.BUY && type === OrderType.MARKET) {
      const cash = await ensureCashBalance(userId);
      const affordableQty = Math.floor(cash.total / executionPrice);
      if (affordableQty <= 0) {
        break;
      }
      fillQty = Math.min(fillQty, affordableQty);
    }

    if (fillQty <= 0) {
      break;
    }

    const executionCost = fillQty * executionPrice;

    await prisma.fill.create({
      data: {
        stockId: stock.id,
        price: executionPrice,
        qty: fillQty,
        buyOrderId: side === OrderSide.BUY ? incomingOrder.id : opposite.id,
        sellOrderId: side === OrderSide.SELL ? incomingOrder.id : opposite.id,
      },
    });

    if (side === OrderSide.BUY) {
      if (type === OrderType.LIMIT) {
        await prisma.accountBalance.update({
          where: { userId_currency: { userId, currency: INR_CURRENCY } },
          data: { locked: { decrement: executionCost } },
        });
      } else {
        await prisma.accountBalance.update({
          where: { userId_currency: { userId, currency: INR_CURRENCY } },
          data: { total: { decrement: executionCost } },
        });
      }

      await prisma.stockBalance.update({
        where: { userId_stockId: { userId, stockId: stock.id } },
        data: { total: { increment: fillQty } },
      });
    } else {
      if (type === OrderType.LIMIT) {
        await prisma.stockBalance.update({
          where: { userId_stockId: { userId, stockId: stock.id } },
          data: { locked: { decrement: fillQty } },
        });
      } else {
        await prisma.stockBalance.update({
          where: { userId_stockId: { userId, stockId: stock.id } },
          data: { total: { decrement: fillQty } },
        });
      }

      await prisma.accountBalance.update({
        where: { userId_currency: { userId, currency: INR_CURRENCY } },
        data: { total: { increment: executionCost } },
      });
    }

    await ensureCashBalance(opposite.userId);
    await ensureStockBalance(opposite.userId, stock.id);

    if (opposite.side === OrderSide.BUY) {
      await prisma.accountBalance.update({
        where: { userId_currency: { userId: opposite.userId, currency: INR_CURRENCY } },
        data: { locked: { decrement: executionCost } },
      });
      await prisma.stockBalance.update({
        where: { userId_stockId: { userId: opposite.userId, stockId: stock.id } },
        data: { total: { increment: fillQty } },
      });
    } else {
      await prisma.stockBalance.update({
        where: { userId_stockId: { userId: opposite.userId, stockId: stock.id } },
        data: { locked: { decrement: fillQty } },
      });
      await prisma.accountBalance.update({
        where: { userId_currency: { userId: opposite.userId, currency: INR_CURRENCY } },
        data: { total: { increment: executionCost } },
      });
    }

    const nextOppositeFilledQty = opposite.filledQty + fillQty;
    const oppositeStatus = nextOppositeFilledQty >= opposite.qty ? OrderStatus.FILLED : OrderStatus.PARTIALLY_FILLED;

    await prisma.order.update({
      where: { id: opposite.id },
      data: {
        filledQty: nextOppositeFilledQty,
        status: oppositeStatus,
      },
    });

    reduceOrderFromBook(
      {
        id: opposite.id,
        side: opposite.side,
        stockId: opposite.stockId,
        price: opposite.price,
      },
      fillQty,
    );

    remaining -= fillQty;
    filledQty += fillQty;
    tradedValue += executionCost;
  }

  let finalStatus: OrderStatus;
  if (type === OrderType.MARKET) {
    finalStatus = remaining === 0 ? OrderStatus.FILLED : filledQty > 0 ? OrderStatus.PARTIALLY_FILLED : OrderStatus.CANCELLED;
  } else {
    finalStatus = remaining === 0 ? OrderStatus.FILLED : filledQty > 0 ? OrderStatus.PARTIALLY_FILLED : OrderStatus.OPEN;
  }

  await prisma.order.update({
    where: { id: incomingOrder.id },
    data: {
      filledQty,
      status: finalStatus,
    },
  });

  if (type === OrderType.LIMIT && side === OrderSide.BUY && price !== null && filledQty > 0) {
    const refund = price * filledQty - tradedValue;
    if (refund > 0) {
      await unlockBuyFunds(userId, refund);
    }
  }

  if (type === OrderType.LIMIT && remaining > 0) {
    addOrderToBook({
      id: incomingOrder.id,
      userId,
      side,
      type,
      stockId: stock.id,
      price,
      qty,
      filledQty,
      createdAt: incomingOrder.createdAt,
    });
  }

  return res.status(201).json({
    orderId: incomingOrder.id,
    filledQty,
    averagePrice: filledQty > 0 ? tradedValue / filledQty : null,
    status: finalStatus,
    remainingQty: remaining,
  });
});

app.get("/order/:orderId", async (req, res) => {
  const orderId = Number(req.params.orderId);
  if (!Number.isInteger(orderId) || orderId <= 0) {
    return res.status(400).json({ error: "invalid order id" });
  }

  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: {
      stock: true,
      buyFills: true,
      sellFills: true,
    },
  });

  if (!order) {
    return res.status(404).json({ error: "order not found" });
  }

  return res.json({
    order,
    fills: [...order.buyFills, ...order.sellFills].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()),
  });
});

app.delete("/order/:orderId", async (req, res) => {
  const userId = getUserId(req);
  if (!userId) {
    return res.status(401).json({ error: "missing user id (x-user-id header or userId field)" });
  }

  const orderId = Number(req.params.orderId);
  if (!Number.isInteger(orderId) || orderId <= 0) {
    return res.status(400).json({ error: "invalid order id" });
  }

  const order = await prisma.order.findUnique({
    where: { id: orderId },
  });

  if (!order) {
    return res.status(404).json({ error: "order not found" });
  }

  if (order.userId !== userId) {
    return res.status(403).json({ error: "you can only cancel your own order" });
  }

  if (order.status !== OrderStatus.OPEN && order.status !== OrderStatus.PARTIALLY_FILLED) {
    return res.status(400).json({ error: "only open/partially filled orders can be cancelled" });
  }

  const remainingQty = order.qty - order.filledQty;

  if (order.type === OrderType.LIMIT && order.side === OrderSide.BUY && order.price !== null && remainingQty > 0) {
    await unlockBuyFunds(userId, order.price * remainingQty);
  }

  if (order.type === OrderType.LIMIT && order.side === OrderSide.SELL && remainingQty > 0) {
    await unlockSellQty(userId, order.stockId, remainingQty);
  }

  await prisma.order.update({
    where: { id: orderId },
    data: { status: OrderStatus.CANCELLED },
  });

  removeOrderFromBook(order);

  return res.json({
    orderId,
    status: OrderStatus.CANCELLED,
  });
});

app.get("/depth/:symbol", async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  return res.json({
    symbol,
    depth: getDepth(symbol),
  });
});

app.get("/orders", async (req, res) => {
  const userId = getUserId(req);
  if (!userId) {
    return res.status(401).json({ error: "missing user id (x-user-id header or userId query)" });
  }

  const orders = await prisma.order.findMany({
    where: { userId },
    include: { stock: true },
    orderBy: { createdAt: "desc" },
  });

  return res.json({ orders });
});

app.get("/fills", async (req, res) => {
  const userId = getUserId(req);
  if (!userId) {
    return res.status(401).json({ error: "missing user id (x-user-id header or userId query)" });
  }

  const fills = await prisma.fill.findMany({
    where: {
      OR: [
        { buyOrder: { is: { userId } } },
        { sellOrder: { is: { userId } } },
      ],
    },
    include: {
      stock: true,
      buyOrder: true,
      sellOrder: true,
    },
    orderBy: { createdAt: "desc" },
  });

  return res.json({ fills });
});

app.get("/balance/usd", async (req, res) => {
  const userId = getUserId(req);
  if (!userId) {
    return res.status(401).json({ error: "missing user id (x-user-id header or userId query)" });
  }

  const cash = await ensureCashBalance(userId);

  return res.json({
    currency: INR_CURRENCY,
    free: cash.total,
    locked: cash.locked,
    gross: cash.total + cash.locked,
  });
});

app.get("/balance", async (req, res) => {
  const userId = getUserId(req);
  if (!userId) {
    return res.status(401).json({ error: "missing user id (x-user-id header or userId query)" });
  }

  const cash = await ensureCashBalance(userId);
  const stocks = await prisma.stockBalance.findMany({
    where: { userId },
    include: { stock: true },
  });

  return res.json({
    cash: {
      currency: INR_CURRENCY,
      free: cash.total,
      locked: cash.locked,
      gross: cash.total + cash.locked,
    },
    stocks: stocks.map((holding) => ({
      stockId: holding.stockId,
      symbol: holding.stock.symbol,
      title: holding.stock.title,
      free: holding.total,
      locked: holding.locked,
      gross: holding.total + holding.locked,
    })),
  });
});

app.get("/stocks", async (_req, res) => {
  const stocks = await prisma.stock.findMany({
    orderBy: { id: "asc" },
  });

  return res.json({ stocks });
});

async function seedStocks(): Promise<void> {
  const existing = await prisma.stock.count();
  if (existing > 0) {
    return;
  }

  await prisma.stock.createMany({
    data: [
      { title: "AXIS BANK", symbol: "AXIS" },
      { title: "HDFC BANK", symbol: "HDFC" },
      { title: "TATA STEEL", symbol: "TATA" },
    ],
  });
}

async function hydrateOrderBooks(): Promise<void> {
  const stocks = await prisma.stock.findMany();
  for (const stock of stocks) {
    SYMBOL_BY_STOCK_ID.set(stock.id, stock.symbol);
    ensureBook(stock.symbol);
  }

  const openLimitOrders = await prisma.order.findMany({
    where: {
      type: OrderType.LIMIT,
      status: { in: [OrderStatus.OPEN, OrderStatus.PARTIALLY_FILLED] },
    },
    orderBy: { createdAt: "asc" },
  });

  for (const order of openLimitOrders) {
    addOrderToBook(order);
  }
}

async function startServer() {
  await seedStocks();
  await hydrateOrderBooks();

  app.listen(3000, () => {
    // eslint-disable-next-line no-console
    console.log("Backend running on http://localhost:3000");
  });
}

startServer().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("Failed to start backend", error);
  process.exit(1);
});
