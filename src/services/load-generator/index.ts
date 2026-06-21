import { loadConfig } from '../../shared/config';

// Phase 0：佔位。Phase 6 起在此對單一熱點賬戶灌可設定負載，並提供批次 vs 天真對照。
const config = loadConfig();
console.log(`[${config.serviceName}] load-generator placeholder (尚未實作，見 Phase 6 / issue #7)`);
