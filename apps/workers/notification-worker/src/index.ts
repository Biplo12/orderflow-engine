import "dotenv/config";
import { Worker } from "bullmq";
import { eq } from "drizzle-orm";
import pino from "pino";
import { env } from "./env.js";
import { db, sql } from "./db.js";
import { notifications, outbox } from "./schema.js";

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

async function sendEmail(orderId: string, kind: string) {
  await new Promise((r) => setTimeout(r, 50));
  log.info({ orderId, kind }, `📧 email sent: ${kind}`);
}

const worker = new Worker(
  "notification",
  async (job) => {
    const orderId = (job.data as { orderId: string }).orderId;
    const kind =
      job.name === "payment.succeeded"
        ? "confirmation"
        : job.name === "inventory.rejected"
          ? "cancellation"
          : null;

    if (!kind) {
      log.warn({ name: job.name }, "unknown event, ignoring");
      return;
    }

    await db.transaction(async (tx) => {
      const existing = await tx
        .select({ id: notifications.id })
        .from(notifications)
        .where(eq(notifications.orderId, orderId))
        .limit(1);
      if (existing.length > 0) {
        log.info({ orderId }, "already notified, skip");
        return;
      }

      await sendEmail(orderId, kind);
      await tx.insert(notifications).values({
        orderId,
        kind,
        channel: "email",
      });
      await tx.insert(outbox).values({
        aggregateType: "order",
        aggregateId: orderId,
        eventType: "notification.sent",
        payload: { orderId, kind },
      });
    });
  },
  { connection, concurrency: env.CONCURRENCY },
);

worker.on("failed", (job, err) =>
  log.error({ jobId: job?.id, err: err.message }, "job failed"),
);

const shutdown = async (signal: string) => {
  log.info({ signal }, "shutting down");
  await worker.close();
  await sql.end({ timeout: 5 });
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

log.info("notification-worker started");
