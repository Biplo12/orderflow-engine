import "dotenv/config";
import { asc, eq } from "drizzle-orm";
import pino from "pino";
import { env } from "./env.js";
import { db, sql } from "./db.js";
import { outbox } from "./schema.js";
import { queueForEvent, closeQueues } from "./queue.js";
import { sleep } from "./utils.js";

const log = pino({
  level: env.LOG_LEVEL,
  transport:
    env.NODE_ENV === "development" ? { target: "pino-pretty" } : undefined,
});

let running = true;

async function tick() {
  await db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(outbox)
      .where(eq(outbox.status, "pending"))
      .orderBy(asc(outbox.createdAt))
      .limit(env.BATCH_SIZE)
      .for("update", { skipLocked: true });

    for (const row of rows) {
      await queueForEvent(row.eventType).add(row.eventType, row.payload, {
        jobId: row.id,
      });

      await tx
        .update(outbox)
        .set({ status: "published", publishedAt: new Date() })
        .where(eq(outbox.id, row.id));
      log.info({ id: row.id, eventType: row.eventType }, "published");
    }
  });
}

async function main() {
  log.info("outbox-relay started");
  while (running) {
    try {
      await tick();
    } catch (err) {
      log.error({ err }, "tick failed");
    }
    await sleep(env.POLL_INTERVAL_MS);
  }
}

const shutdown = async (signal: string) => {
  log.info({ signal }, "shutting down");
  running = false;
  await closeQueues();
  await sql.end({ timeout: 5 });
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

void main();
