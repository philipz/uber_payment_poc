// Redis Lua 腳本：以 Redis TIME 作為權威時鐘，原子地完成窗口歸集與關閉。
// bucket key 格式：batch:{windowStart}:{accountId}
//   windowStart 為純數字（無冒號），accountId 在最後，故可安全還原即使 accountId 含冒號。
// windows:active 為 sorted set，member=bucket、score=關閉截止時間(ms)，供 sweeper 使用。

// 將一筆交易歸集進當前 250ms 窗口。
// ARGV: [1]=accountId [2]=txnJson [3]=windowMs
// 回傳: {windowStart, isNew(1/0), msUntilClose}
export const ACCUMULATE_LUA = `
local accountId = ARGV[1]
local txn = ARGV[2]
local windowMs = tonumber(ARGV[3])
local t = redis.call('TIME')
local nowMs = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local windowStart = math.floor(nowMs / windowMs) * windowMs
local bucket = 'batch:' .. windowStart .. ':' .. accountId
local isNew = 0
if redis.call('EXISTS', bucket) == 0 then isNew = 1 end
redis.call('RPUSH', bucket, txn)
redis.call('PEXPIRE', bucket, windowMs + 60000)
if isNew == 1 then
  redis.call('ZADD', 'windows:active', windowStart + windowMs, bucket)
end
return {windowStart, isNew, (windowStart + windowMs) - nowMs}
`;

// 關閉「單一」指定窗口（由該窗口的 setTimeout 精準觸發）。冪等：bucket 不存在則 no-op。
// ARGV: [1]=bucket [2]=queueKey
// 回傳: 1 表示有打包推入、0 表示空窗或已關閉
export const CLOSE_ONE_LUA = `
local bucket = ARGV[1]
local queue = ARGV[2]
local items = redis.call('LRANGE', bucket, 0, -1)
redis.call('ZREM', 'windows:active', bucket)
redis.call('DEL', bucket)
if #items == 0 then return 0 end
local rest = string.sub(bucket, 7)
local sep = string.find(rest, ':')
local windowStart = string.sub(rest, 1, sep - 1)
local accountId = string.sub(rest, sep + 1)
-- 注意：此處手動拼接 JSON 依賴 accountId 的嚴格字元限制（creator 已驗證 [A-Za-z0-9_-]）。
-- 若未來放寬限制，必須改為轉義處理，否則 JSON 可能損壞或被注入。
local task = '{"taskId":"' .. bucket .. '","accountId":"' .. accountId ..
  '","windowStart":' .. windowStart ..
  ',"transactions":[' .. table.concat(items, ',') .. ']}'
redis.call('LPUSH', queue, task)
return 1
`;

// 兜底：關閉所有「已到期」的窗口。setTimeout 漏掉或節點重啟時由低頻 interval 呼叫。
// 加 LIMIT 限制單次處理量，避免大量窗口同時到期時單次 Lua 執行過久而阻塞 Redis；
// 未處理完的會在下次 sweep 接續。
// ARGV: [1]=queueKey [2]=limit
// 回傳: 本次關閉的窗口數
export const SWEEP_LUA = `
local queue = ARGV[1]
local limit = tonumber(ARGV[2])
local t = redis.call('TIME')
local nowMs = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local due = redis.call('ZRANGEBYSCORE', 'windows:active', 0, nowMs, 'LIMIT', 0, limit)
local flushed = 0
for _, bucket in ipairs(due) do
  local items = redis.call('LRANGE', bucket, 0, -1)
  redis.call('ZREM', 'windows:active', bucket)
  redis.call('DEL', bucket)
  if #items > 0 then
    local rest = string.sub(bucket, 7)
    local sep = string.find(rest, ':')
    local windowStart = string.sub(rest, 1, sep - 1)
    local accountId = string.sub(rest, sep + 1)
    -- 注意：手動拼接 JSON 依賴 accountId 嚴格字元限制（見 CLOSE_ONE_LUA 說明）。
    local task = '{"taskId":"' .. bucket .. '","accountId":"' .. accountId ..
      '","windowStart":' .. windowStart ..
      ',"transactions":[' .. table.concat(items, ',') .. ']}'
    redis.call('LPUSH', queue, task)
    flushed = flushed + 1
  end
end
return flushed
`;
