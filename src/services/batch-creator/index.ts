import { loadConfig } from '../../shared/config';
import { startHealthServer } from '../../shared/health';

// Phase 0：空殼。Phase 1 起在此加上 POST /accounts/:id/transactions 與 results cache 輪詢。
const config = loadConfig();
startHealthServer(config.port, config.serviceName);
console.log(`[${config.serviceName}] up (az=${config.azId})`);
