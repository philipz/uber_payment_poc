import Redis from 'ioredis';
import type { Config } from './config';

// 建立 ioredis 連線。阻塞式指令（如 BRPOP）建議使用獨立連線，
// 並以 maxRetriesPerRequest=null 避免逾時誤判。
export function createRedis(config: Config): Redis {
  return new Redis(config.redisUrl, { maxRetriesPerRequest: null });
}
