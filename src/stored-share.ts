import { z } from "zod";
import { ChatHistorySchema, type ChatHistory } from "./share-schema";

export const STORED_SHARE_FORMAT = "threadshare-object@v1";
const REVOKE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
const REVOKE_TOKEN_SHA256_PATTERN = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;

const StoredShareSchema = z
  .object({
    format: z.literal(STORED_SHARE_FORMAT),
    createdAt: z.string().datetime(),
    expiresAt: z.string().datetime().optional(),
    revokeTokenSha256: z.string().regex(REVOKE_TOKEN_SHA256_PATTERN).optional(),
    history: ChatHistorySchema,
  })
  .strict()
  .refine(
    (share) =>
      share.expiresAt === undefined || Date.parse(share.expiresAt) > Date.parse(share.createdAt),
    "Expiration must be after creation",
  );

export type StoredShare = z.infer<typeof StoredShareSchema>;

export function createStoredShare(
  history: ChatHistory,
  now: number,
  {
    expiresInSeconds,
    revokeTokenSha256,
  }: { expiresInSeconds?: number; revokeTokenSha256?: string } = {},
): StoredShare {
  const createdAt = new Date(now).toISOString();
  return {
    format: STORED_SHARE_FORMAT,
    createdAt,
    ...(expiresInSeconds === undefined
      ? {}
      : { expiresAt: new Date(now + expiresInSeconds * 1000).toISOString() }),
    ...(revokeTokenSha256 === undefined ? {} : { revokeTokenSha256 }),
    history,
  };
}

export function decodeStoredShare(raw: string): {
  history: ChatHistory;
  expiresAt: string | undefined;
  revokeTokenSha256: string | undefined;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Stored share is invalid");
  }

  if (
    parsed !== null &&
    typeof parsed === "object" &&
    "format" in parsed &&
    parsed.format === STORED_SHARE_FORMAT
  ) {
    const stored = StoredShareSchema.safeParse(parsed);
    if (!stored.success) throw new Error("Stored share is invalid");
    return {
      history: stored.data.history,
      expiresAt: stored.data.expiresAt,
      revokeTokenSha256: stored.data.revokeTokenSha256,
    };
  }

  const history = ChatHistorySchema.safeParse(parsed);
  if (!history.success) throw new Error("Stored share is invalid");
  return { history: history.data, expiresAt: undefined, revokeTokenSha256: undefined };
}

export function isShareExpired(expiresAt: string | undefined, now: number): boolean {
  return expiresAt !== undefined && now >= Date.parse(expiresAt);
}

export function isRevokeTokenSha256(value: string): boolean {
  return REVOKE_TOKEN_SHA256_PATTERN.test(value);
}

export function parseRevokeAuthorization(
  authorization: string | null | undefined,
): string | undefined {
  const match = /^Bearer ([A-Za-z0-9_-]{42}[AEIMQUYcgkosw048])$/i.exec(authorization ?? "");
  return match && REVOKE_TOKEN_PATTERN.test(match[1]) ? match[1] : undefined;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function revokeTokenSha256(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return bytesToBase64Url(new Uint8Array(digest));
}

function constantTimeDigestEqual(expected: string, actual: string): boolean {
  if (!isRevokeTokenSha256(expected) || !isRevokeTokenSha256(actual)) return false;
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) {
    difference |= expected.charCodeAt(index) ^ actual.charCodeAt(index);
  }
  return difference === 0;
}

export async function revokeTokenMatches(
  expectedDigest: string | undefined,
  token: string | undefined,
): Promise<boolean> {
  if (expectedDigest === undefined || token === undefined || !REVOKE_TOKEN_PATTERN.test(token)) {
    return false;
  }
  return constantTimeDigestEqual(expectedDigest, await revokeTokenSha256(token));
}
