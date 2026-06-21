import { loadConfig } from '../../shared/config';
import { startHealthServer } from '../../shared/health';

// Phase 0：空殼。Phase 4 起在此非同步消費 Redis、寫 MicroUAC 審計、Kafka stub。
const config = loadConfig();
startHealthServer(config.port, config.serviceName);
console.log(`[${config.serviceName}] up (az=${config.azId})`);
