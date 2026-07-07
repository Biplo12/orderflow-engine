type OrderItem = { sku: string; quantity: number };

export class TransientPaymentError extends Error {}
export class PermanentPaymentError extends Error {}

export async function charge(
  items: OrderItem[],
  amount: number,
): Promise<void> {
  const skus = items.map((i) => i.sku).join(",");
  await new Promise((r) => setTimeout(r, 150));

  if (skus.includes("FAIL")) {
    throw new PermanentPaymentError("card_declined");
  }
  if (skus.includes("TIMEOUT")) {
    throw new TransientPaymentError("gateway_timeout");
  }
}
