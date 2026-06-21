// 各服務共用的環境設定。

export interface Config {
  serviceName: string;
  port: number;
  azId: string;
  redisUrl: string;
  databaseUrl: string;
}

export function loadConfig(): Config {
  return {
    serviceName: process.env.SERVICE_NAME ?? 'unknown',
    port: Number(process.env.PORT ?? 3000),
    azId: process.env.AZ_ID ?? 'az-local',
    redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
    databaseUrl: process.env.DATABASE_URL ?? 'postgres://poc:poc@localhost:5432/poc',
  };
}
