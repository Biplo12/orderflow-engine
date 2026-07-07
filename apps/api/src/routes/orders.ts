import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { CreateOrderSchema, CreateOrderResponseSchema } from "../schemas.js";
import { db } from "../db/client.js";
import { orders, outbox } from "../db/schema.js";

export async function orderRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.post(
    "/orders",
    {
      schema: {
        body: CreateOrderSchema,
        response: { 202: CreateOrderResponseSchema },
      },
    },
    async (request, reply) => {
      const orderId = await db.transaction(async (tx) => {
        const [row] = await tx
          .insert(orders)
          .values({
            customerId: request.body.customerId,
            currency: request.body.currency,
            items: request.body.items,
            status: "accepted",
          })
          .returning({ id: orders.id });

        const id = row!.id;

        await tx.insert(outbox).values({
          aggregateType: "order",
          aggregateId: id,
          eventType: "order.created",
          payload: {
            orderId: id,
            customerId: request.body.customerId,
            currency: request.body.currency,
            items: request.body.items,
          },
        });

        return id;
      });

      request.log.info({ orderId }, "order accepted + outbox written");
      return reply.code(202).send({ orderId, status: "accepted" });
    },
  );
}
