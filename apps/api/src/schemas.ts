import { z } from "zod";

export const OrderItemSchema = z.object({
  sku: z.string().min(1),
  quantity: z.number().int().positive(),
});

export const CreateOrderSchema = z.object({
  customerId: z.string().uuid(),
  currency: z.string().length(3).default("EUR"),
  items: z.array(OrderItemSchema).min(1),
});
export type CreateOrder = z.infer<typeof CreateOrderSchema>;

export const CreateOrderResponseSchema = z.object({
  orderId: z.string().uuid(),
  status: z.literal("accepted"),
});
