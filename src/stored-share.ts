import { z } from "zod";
import { ChatHistorySchema, type ChatHistory } from "./share-schema";

export const STORED_SHARE_FORMAT = "threadshare-object@v1";

const StoredShareSchema = z
  .object({
    format: z.literal(STORED_SHARE_FORMAT),
    createdAt: z.string().datetime(),
    expiresAt: z.string().datetime().optional(),
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
  expiresInSeconds?: number,
): StoredShare {
  const createdAt = new Date(now).toISOString();
  return {
    format: STORED_SHARE_FORMAT,
    createdAt,
    ...(expiresInSeconds === undefined
      ? {}
      : { expiresAt: new Date(now + expiresInSeconds * 1000).toISOString() }),
    history,
  };
}

export function decodeStoredShare(raw: string): {
  history: ChatHistory;
  expiresAt: string | undefined;
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
    return { history: stored.data.history, expiresAt: stored.data.expiresAt };
  }

  const history = ChatHistorySchema.safeParse(parsed);
  if (!history.success) throw new Error("Stored share is invalid");
  return { history: history.data, expiresAt: undefined };
}

export function isShareExpired(expiresAt: string | undefined, now: number): boolean {
  return expiresAt !== undefined && now >= Date.parse(expiresAt);
}
