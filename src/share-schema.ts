import { z } from "zod";

const TimestampWithOffsetSchema = z.string().datetime({ offset: true });
const TimestampSchema = z.string().refine(
  (value) => {
    const match =
      /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):([0-5]\d):((?:[0-5]\d|60)(?:\.\d+)?)(?:Z|([+-])([01]\d|2[0-3]):([0-5]\d))$/i.exec(
        value,
      );
    if (!match) return false;
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    const second = Number(match[3]);
    const offsetSign = match[4] === "-" ? -1 : 1;
    const offsetHour = Number(match[5] ?? 0);
    const offsetMinute = Number(match[6] ?? 0);
    if (offsetHour > 23 || offsetMinute > 59) return false;

    // Zod rejects :60, so substitute :59 only while checking the calendar date.
    const valueForDateCheck =
      second >= 60 && second < 61
        ? value.replace(/:60(?=(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$)/i, ":59")
        : value;
    if (!TimestampWithOffsetSchema.safeParse(valueForDateCheck.toUpperCase()).success) return false;
    if (second < 60) return true;

    // A leap second is valid only when the offset-adjusted time lands at 23:59:60 UTC.
    const utcMinute = minute - offsetMinute * offsetSign;
    const utcHour = hour - offsetHour * offsetSign - (utcMinute < 0 ? 1 : 0);
    return (
      second < 61 &&
      (utcHour === 23 || utcHour === -1) &&
      (utcMinute === 59 || utcMinute === -1)
    );
  },
  "Invalid RFC 3339 date-time",
);
const LegacyTimestampSchema = z.string().datetime();
const EntryBaseSchema = z.object({
  id: z.string().min(1),
  createdAt: TimestampSchema,
});

const ChatHistoryEntrySchema = z.discriminatedUnion("kind", [
  EntryBaseSchema.extend({
    kind: z.literal("message"),
    role: z.enum(["user", "assistant"]),
    markdown: z.string(),
  }).strict(),
  EntryBaseSchema.extend({
    kind: z.literal("tool"),
    name: z.string().min(1),
    status: z.enum(["running", "completed", "failed", "canceled"]),
    input: z.unknown().optional(),
    output: z.unknown().optional(),
    error: z.unknown().optional(),
  }).strict(),
  EntryBaseSchema.extend({
    kind: z.literal("thought"),
    text: z.string(),
    status: z.enum(["loading", "ready"]),
  }).strict(),
  EntryBaseSchema.extend({
    kind: z.literal("todo"),
    items: z.array(
      z
        .object({
          text: z.string(),
          completed: z.boolean(),
        })
        .strict(),
    ),
  }).strict(),
  EntryBaseSchema.extend({
    kind: z.literal("activity"),
    message: z.string(),
    level: z.enum(["system", "info", "success", "error"]),
  }).strict(),
  EntryBaseSchema.extend({
    kind: z.literal("compaction"),
    status: z.enum(["loading", "completed"]),
    trigger: z.enum(["auto", "manual"]).optional(),
    preTokens: z.number().int().nonnegative().optional(),
  }).strict(),
]);

const ConversationSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    provider: z.string().optional(),
    model: z.string().optional(),
    source: z.enum(["paseo", "codex", "claude", "other"]).optional(),
  })
  .strict();

const LegacyEntryBaseSchema = z.object({
  id: z.string().min(1),
  createdAt: LegacyTimestampSchema,
});

const LegacyChatHistoryEntrySchema = z.discriminatedUnion("kind", [
  LegacyEntryBaseSchema.extend({
    kind: z.literal("message"),
    role: z.enum(["user", "assistant"]),
    markdown: z.string(),
  }).strict(),
  LegacyEntryBaseSchema.extend({
    kind: z.literal("tool"),
    name: z.string().min(1),
    status: z.enum(["running", "completed", "failed", "canceled"]),
    input: z.unknown().optional(),
    output: z.unknown().optional(),
    error: z.unknown().optional(),
  }).strict(),
  LegacyEntryBaseSchema.extend({
    kind: z.literal("thought"),
    text: z.string(),
    status: z.enum(["loading", "ready"]),
  }).strict(),
  LegacyEntryBaseSchema.extend({
    kind: z.literal("todo"),
    items: z.array(
      z
        .object({
          text: z.string(),
          completed: z.boolean(),
        })
        .strict(),
    ),
  }).strict(),
  LegacyEntryBaseSchema.extend({
    kind: z.literal("activity"),
    message: z.string(),
    level: z.enum(["system", "info", "success", "error"]),
  }).strict(),
  LegacyEntryBaseSchema.extend({
    kind: z.literal("compaction"),
    status: z.enum(["loading", "completed"]),
    trigger: z.enum(["auto", "manual"]).optional(),
    preTokens: z.number().int().nonnegative().optional(),
  }).strict(),
]);

const LegacyConversationSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    provider: z.string().optional(),
    model: z.string().optional(),
  })
  .strict();

export const ThreadshareHistorySchema = z
  .object({
    format: z.literal("threadshare-history@v1"),
    schemaVersion: z.literal(1),
    exportedAt: TimestampSchema,
    conversation: ConversationSchema,
    entries: z.array(ChatHistoryEntrySchema),
  })
  .strict();

// Paseo emitted this shape before Threadshare became an independent service.
const LegacyPaseoHistorySchema = z
  .object({
    schemaVersion: z.literal(1),
    exportedAt: LegacyTimestampSchema,
    conversation: LegacyConversationSchema,
    entries: z.array(LegacyChatHistoryEntrySchema),
  })
  .strict();

export const ChatHistorySchema = z.union([ThreadshareHistorySchema, LegacyPaseoHistorySchema]);

export type ChatHistory = z.infer<typeof ChatHistorySchema>;
export type ThreadshareHistory = z.infer<typeof ThreadshareHistorySchema>;

export const CHAT_SHARE_MAX_BYTES = 5 * 1024 * 1024;

export function isShareId(value: string): boolean {
  return /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value);
}

export function shareKey(id: string): string {
  return `shares/${id.toLowerCase()}.json`;
}
