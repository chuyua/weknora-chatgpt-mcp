// Explicit, fail-closed owner consent for optional knowledge writes.
// A client requesting mcp:write does not grant itself that privilege.
import { WRITE_SCOPE } from "./write-tools.ts";
export const READ_SCOPE = "mcp:read";
export function decideScopes(
  requested: readonly string[],
  opts: {writeReady:boolean;writeConsent:boolean},
): string[] {
  const allowed=new Set([READ_SCOPE,"offline_access"]);
  if(opts.writeReady && opts.writeConsent && requested.includes(WRITE_SCOPE)) {
    allowed.add(WRITE_SCOPE);
  }
  const result=[...new Set(requested.filter(s=>allowed.has(s)))];
  if(!result.includes(READ_SCOPE)) result.push(READ_SCOPE);
  return result;
}
