import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { randomUUID } from "node:crypto";
import { CreateOrderSchema, CreateOrderResponseSchema } from "../schemas.js";

// temporary storage — we will replace Postgres + outbox in the next step
const orders = new Map<string, unknown>();

export async function orderRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  const schema = {
    schema: {
      body: CreateOrderSchema,
    },
    response: { 202: CreateOrderResponseSchema },
  } as const;

  r.post("/orders", schema, async (request, reply) => {
    const orderId = randomUUID();

    const order = { id: orderId, ...request.body, status: "accepted" };

    orders.set(orderId, order);
    request.log.info({ orderId, order }, "order accepted");

    return reply.code(202).send(order);
  });
}
