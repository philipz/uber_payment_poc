import { loadConfig } from '../../shared/config';
import { startHealthServer } from '../../shared/health';

// Phase 0：空殼。Phase 1 起在此競爭領取 Redis 任務、讀 Postgres、樂觀鎖寫回。
const config = loadConfig();
startHealthServer(config.port, config.serviceName);
console.log(`[${config.serviceName}] up (az=${config.azId})`);
