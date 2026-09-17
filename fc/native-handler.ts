import { createHandler } from "./handler";

// The managed FC Node runtime supplies the HTTP event as JSON bytes and honors
// isBase64Encoded on both requests and responses. Keep binary images lossless.
export function createNativeHandler(options?: Parameters<typeof createHandler>[0]) {
  const handle = createHandler(options);
  return async function handler(event: Buffer | Uint8Array | string | object) {
    const input = typeof event === "string"
      ? JSON.parse(event)
      : event instanceof Uint8Array
        ? JSON.parse(Buffer.from(event).toString("utf8"))
        : event;
    const result = await handle(input);
    // FC's native HTTP gateway already echoes the request Origin. Adding our
    // public wildcard creates two ACAO values, which browsers reject. Only let
    // that gateway supply the origin for responses already allowing everyone;
    // preserve CLI responses and every other application CORS/security header.
    const origin = Object.entries(input.headers ?? {}).find(([name]) => name.toLowerCase() === "origin")?.[1];
    if (typeof origin === "string" && origin.length > 0) {
      result.headers = Object.fromEntries(Object.entries(result.headers).filter(([name, value]) =>
        !(name.toLowerCase() === "access-control-allow-origin" && value === "*"),
      ));
    }
    if (Buffer.isBuffer(result.body)) {
      return { ...result, body: result.body.toString("base64"), isBase64Encoded: true };
    }
    return result;
  };
}

export const handler = createNativeHandler();
