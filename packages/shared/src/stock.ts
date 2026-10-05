/** Split each variant's stock across shards; remainders go to the lowest shards. */
export function shardCapacities(stock: number, shards: number): number[] {
  const base = Math.floor(stock / shards);
  const rem = stock % shards;
  return Array.from({ length: shards }, (_, i) => base + (i < rem ? 1 : 0));
}
