// Mermaid may fetch image shapes while rendering, before its sandbox is created.
export function isSafeFlowchartSource(source) {
  return source.length <= 8192 && !/(?:%%\s*\{|@\s*\{|<|(?:https?|data|javascript|file|blob):|(?:^|[\n;])\s*(?:click|classDef|style|linkStyle)\b|(?:^|[^a-z0-9_])\/\/|url\s*\()/i.test(source);
}
