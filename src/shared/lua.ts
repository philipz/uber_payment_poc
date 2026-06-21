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

// 關閉所有已到期的窗口：將其交易打包成單一 batch 任務推入全域佇列。
// 由「每窗口 setTimeout」與「低頻 sweeper」共同呼叫，靠 Redis 單執行緒保證原子與冪等。
// ARGV: [1]=queueKey
// 回傳: 本次關閉的窗口數
export const SWEEP_LUA = `
local queue = ARGV[1]
local t = redis.call('TIME')
local nowMs = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local due = redis.call('ZRANGEBYSCORE', 'windows:active', 0, nowMs)
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
    local task = '{"taskId":"' .. bucket .. '","accountId":"' .. accountId ..
      '","windowStart":' .. windowStart ..
      ',"transactions":[' .. table.concat(items, ',') .. ']}'
    redis.call('LPUSH', queue, task)
    flushed = flushed + 1
  end
end
return flushed
`;
