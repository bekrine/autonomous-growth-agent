import { Redis } from "ioredis";

export type RedisConnection = InstanceType<typeof Redis>;

/**
 * BullMQ requires `maxRetriesPerRequest: null` on the connection it's
 * given, so this factory is the one place that decision is made — API and
 * workers both call it instead of constructing IORedis directly.
 */
export function createRedisConnection(redisUrl: string): RedisConnection {
  return new Redis(redisUrl, { maxRetriesPerRequest: null });
}
