import { Queue } from "bullmq";
import { env } from "./env.js";

const connection = { host: env.REDIS_HOST, port: env.REDIS_PORT };

const ROUTES: Record<string, string> = {
  "order.created": "inventory",
  "inventory.reserved": "payment",
  "inventory.rejected": "notification",
  "payment.succeeded": "notification",
  "payment.failed": "notification", // temporarily; in saga phase we will redirect to compensation
};

const queues = new Map<string, Queue>();

export function queueForEvent(eventType: string): Queue {
  const name = ROUTES[eventType];
  if (!name) throw new Error(`No route for event: ${eventType}`);
  let q = queues.get(name);
  if (!q) {
    q = new Queue(name, {
      connection,
      defaultJobOptions: {
        attempts: 5,
        backoff: { type: "exponential", delay: 1000 },
        removeOnComplete: 1000,
        removeOnFail: 5000,
      },
    });

    queues.set(name, q);
  }
  return q;
}

export async function closeQueues() {
  await Promise.all([...Array.from(queues.values())].map((q) => q.close()));
}
