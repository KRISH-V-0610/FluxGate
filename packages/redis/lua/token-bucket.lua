-- Atomic token bucket: take up to `want` tokens from one key's bucket.
--
-- Why Lua: Redis runs a script start-to-finish with no other command in
-- between. So read -> refill -> decide -> write is one indivisible step,
-- and the check-then-act race of the naive version cannot happen.
--
-- The math is identical to tokenBucketStep() in @fluxgate/core.
--
-- KEYS[1]  bucket hash: { tokens, ts }
-- ARGV[1]  capacity
-- ARGV[2]  refill rate, tokens per second
-- ARGV[3]  want: 1 for a normal request, N to lease a batch (takes min(N, available))
-- ARGV[4]  optional "now" in ms, for deterministic tests only; empty = Redis' own clock
--
-- Returns { granted, remaining, reset_ms, retry_after_ms }

local capacity = tonumber(ARGV[1])
local refill_per_ms = tonumber(ARGV[2]) / 1000
local want = tonumber(ARGV[3])
local EPSILON = 1e-6

-- Whose clock? Redis' clock, not the app server's. With 3 app instances
-- whose clocks disagree by a few ms, using their own Date.now() would let
-- one instance "see" tokens that another hasn't earned yet. One clock, one truth.
local now
if ARGV[4] ~= nil and ARGV[4] ~= '' then
  now = tonumber(ARGV[4])
else
  local t = redis.call('TIME') -- { seconds, microseconds }
  now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
end

local state = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(state[1])
local last = tonumber(state[2])
if tokens == nil or last == nil then
  -- Never seen, or expired: an absent key means a full bucket.
  tokens = capacity
  last = now
end

local elapsed = math.max(0, now - last)
tokens = math.min(capacity, tokens + elapsed * refill_per_ms)

local granted = math.min(want, math.floor(tokens + EPSILON))
if granted > 0 then
  tokens = math.max(0, tokens - granted)
end

local reset_ms = math.ceil((capacity - tokens) / refill_per_ms)
local retry_after_ms = 0
if granted == 0 then
  retry_after_ms = math.ceil((1 - tokens) / refill_per_ms)
end

-- %.17g keeps full double precision (tostring would round to 14 digits).
redis.call('HSET', KEYS[1], 'tokens', string.format('%.17g', tokens), 'ts', string.format('%d', now))
-- Once the bucket would be full again, the key carries no information
-- (absent == full), so let Redis delete it. Memory cleans itself up.
redis.call('PEXPIRE', KEYS[1], math.max(1, reset_ms))

return { granted, math.floor(tokens + EPSILON), reset_ms, retry_after_ms }
