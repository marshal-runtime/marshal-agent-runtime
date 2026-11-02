export interface Order {
  id: string;
  region: string;
  amount: number;
}

export interface OrderSummary {
  totalAmount: number;
  orderCount: number;
  byRegion: Array<{ region: string; amount: number; orderCount: number }>;
}

export default function analyzeOrders(input: { orders: Order[] }): OrderSummary {
  const byRegion = new Map<string, { amount: number; orderCount: number }>();
  for (const order of input.orders) {
    if (!order.id || !order.region || !Number.isFinite(order.amount)) {
      throw new TypeError('Every order requires an id, region, and finite amount.');
    }
    const current = byRegion.get(order.region) ?? { amount: 0, orderCount: 0 };
    current.amount += order.amount;
    current.orderCount += 1;
    byRegion.set(order.region, current);
  }

  return {
    totalAmount: input.orders.reduce((sum, order) => sum + order.amount, 0),
    orderCount: input.orders.length,
    byRegion: [...byRegion.entries()]
      .map(([region, totals]) => ({ region, ...totals }))
      .sort((left, right) => right.amount - left.amount || left.region.localeCompare(right.region)),
  };
}
