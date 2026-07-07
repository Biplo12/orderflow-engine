import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { CreateOrderSchema, CreateOrderResponseSchema } from "../schemas.js";
import { db } from "../db/client.js";
import { orders } from "../db/schema.js";

export async function orderRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  const schema = {
    schema: {
      body: CreateOrderSchema,
    },
    response: { 202: CreateOrderResponseSchema },
  } as const;

  r.post("/orders", schema, async (request, reply) => {
    const [row] = await db
      .insert(orders)
      .values({
        customerId: request.body.customerId,
        currency: request.body.currency,
        items: request.body.items,
        status: "accepted",
      })
      .returning({ id: orders.id });

    request.log.info({ orderId: row!.id }, "order accepted");
    return reply.code(202).send({ orderId: row!.id, status: "accepted" });
  });
}
