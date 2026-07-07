import "dotenv/config";
import { Worker } from "bullmq";
import { eq, sql as dsql } from "drizzle-orm";
import pino from "pino";
import { env } from "./env.js";
import { db, sql } from "./db.js";
import { inventory, inventoryReservations, outbox } from "./schema.js";

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

type OrderCreated = {
  orderId: string;
  customerId: string;
  currency: string;
  items: OrderItem[];
};

async function reserve(data: {
  orderId: string;
  customerId: string;
  currency: string;
  items: OrderItem[];
}) {
  const { orderId, items } = data;
  await db.transaction(async (tx) => {
    const existing = await tx
      .select({ id: inventoryReservations.id })
      .from(inventoryReservations)
      .where(eq(inventoryReservations.orderId, orderId))
      .limit(1);
    if (existing.length > 0) {
      log.info({ orderId }, "already processed, skip");
      return;
    }

    let ok = true;
    let reason = "";
    for (const item of items) {
      const [inv] = await tx
        .select()
        .from(inventory)
        .where(eq(inventory.sku, item.sku))
        .for("update");
      if (!inv) {
        ok = false;
        reason = `unknown sku: ${item.sku}`;
        break;
      }
      if (inv.available < item.quantity) {
        ok = false;
        reason = `insufficient stock: ${item.sku}`;
        break;
      }
    }

    if (ok) {
      for (const item of items) {
        await tx
          .update(inventory)
          .set({
            available: dsql`${inventory.available} - ${item.quantity}`,
            updatedAt: new Date(),
          })
          .where(eq(inventory.sku, item.sku));
      }
      await tx
        .insert(inventoryReservations)
        .values({ orderId, status: "reserved", items });
      await tx.insert(outbox).values({
        aggregateType: "order",
        aggregateId: orderId,
        eventType: "inventory.reserved",
        payload: { ...data },
      });
      log.info({ orderId }, "reserved");
    } else {
      await tx
        .insert(inventoryReservations)
        .values({ orderId, status: "rejected", items, reason });
      await tx.insert(outbox).values({
        aggregateType: "order",
        aggregateId: orderId,
        eventType: "inventory.rejected",
        payload: { orderId, reason },
      });
      log.warn({ orderId, reason }, "rejected");
    }
  });
}

async function release(data: { orderId: string; reason: string }) {
  const { orderId } = data;
  await db.transaction(async (tx) => {
    const [res] = await tx
      .select()
      .from(inventoryReservations)
      .where(eq(inventoryReservations.orderId, orderId))
      .for("update");

    if (!res) {
      log.warn({ orderId }, "no reservation to release");
      return;
    }
    if (res.status !== "reserved") {
      log.info(
        { orderId, status: res.status },
        "already released/not reserved, skip",
      );
      return;
    }

    for (const item of res.items) {
      await tx
        .update(inventory)
        .set({
          available: dsql`${inventory.available} + ${item.quantity}`,
          updatedAt: new Date(),
        })
        .where(eq(inventory.sku, item.sku));
    }
    await tx
      .update(inventoryReservations)
      .set({ status: "released", reason: data.reason })
      .where(eq(inventoryReservations.orderId, orderId));

    log.info({ orderId }, "reservation released (compensation)");
  });
}

type OrderItem = { sku: string; quantity: number };

const worker = new Worker(
  "inventory",
  async (job) => {
    if (job.name === "order.created") {
      return reserve(
        job.data as {
          orderId: string;
          customerId: string;
          currency: string;
          items: OrderItem[];
        },
      );
    }
    if (job.name === "payment.failed") {
      return release(job.data as { orderId: string; reason: string });
    }
    log.warn({ name: job.name }, "unknown event, ignoring");
  },
  { connection, concurrency: env.CONCURRENCY },
);

worker.on("failed", (job, err) =>
  log.error({ jobId: job?.id, err }, "job failed"),
);

const shutdown = async (signal: string) => {
  log.info({ signal }, "shutting down");
  await worker.close();
  await sql.end({ timeout: 5 });
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

log.info("inventory-worker started");
