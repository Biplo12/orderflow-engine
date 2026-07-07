import "dotenv/config";
import { Worker } from "bullmq";
import { eq } from "drizzle-orm";
import pino from "pino";
import { env } from "./env.js";
import { db, sql } from "./db.js";
import { payments, outbox } from "./schema.js";
import {
  charge,
  PermanentPaymentError,
  TransientPaymentError,
} from "./gateway.js";

const log = pino({
  level: env.LOG_LEVEL,
  transport:
    env.NODE_ENV === "development" ? { target: "pino-pretty" } : undefined,
});

const connection = {
  host: env.REDIS_HOST,
  port: env.REDIS_PORT,
  maxRetriesPerRequest: null,
};

type OrderItem = { sku: string; quantity: number };
type InventoryReserved = {
  orderId: string;
  customerId: string;
  currency: string;
  items: OrderItem[];
};

// prosta wycena: 1000 jednostek za sztukę
const priceOf = (items: OrderItem[]) =>
  items.reduce((sum, i) => sum + i.quantity * 1000, 0);

const worker = new Worker<InventoryReserved>(
  "payment",
  async (job) => {
    const { orderId, currency, items } = job.data;
    const amount = priceOf(items);

    // idempotencja: już opłacone/rozstrzygnięte?
    const existing = await db
      .select({ id: payments.id })
      .from(payments)
      .where(eq(payments.orderId, orderId))
      .limit(1);
    if (existing.length > 0) {
      log.info({ orderId }, "payment already processed, skip");
      return;
    }

    try {
      await charge(items, amount);
    } catch (err) {
      if (err instanceof TransientPaymentError) {
        // przejściowy -> rzuć, BullMQ ponowi z backoffem
        log.warn({ orderId, err: err.message }, "transient error, will retry");
        throw err;
      }
      if (err instanceof PermanentPaymentError) {
        // trwały -> zapis failed + event, BEZ rzucania (retry nic nie da)
        await db.transaction(async (tx) => {
          await tx.insert(payments).values({
            orderId,
            status: "failed",
            amount,
            currency,
            reason: err.message,
          });
          await tx.insert(outbox).values({
            aggregateType: "order",
            aggregateId: orderId,
            eventType: "payment.failed",
            payload: { orderId, reason: err.message, items },
          });
        });
        log.warn(
          { orderId, reason: err.message },
          "payment failed (permanent)",
        );
        return;
      }
      throw err; // nieznany błąd -> traktuj jak przejściowy
    }

    // sukces
    await db.transaction(async (tx) => {
      await tx.insert(payments).values({
        orderId,
        status: "succeeded",
        amount,
        currency,
      });
      await tx.insert(outbox).values({
        aggregateType: "order",
        aggregateId: orderId,
        eventType: "payment.succeeded",
        payload: { orderId, amount, currency },
      });
    });
    log.info({ orderId, amount }, "payment succeeded");
  },
  { connection, concurrency: env.CONCURRENCY },
);

worker.on("failed", (job, err) =>
  log.error(
    { jobId: job?.id, attempts: job?.attemptsMade, err: err.message },
    "job failed",
  ),
);

const shutdown = async (signal: string) => {
  log.info({ signal }, "shutting down");
  await worker.close();
  await sql.end({ timeout: 5 });
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

log.info("payment-worker started");
