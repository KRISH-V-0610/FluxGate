/**
 * Demo tier rule: API keys starting with "pro_" are pro, everything else
 * (including anonymous IPs) is free. A real system would look the key up.
 * Used with byTier from @fluxgate/http.
 */
export function demoTierOf(key: string): 'pro' | 'free' {
  return key.startsWith('key:pro_') ? 'pro' : 'free';
}
