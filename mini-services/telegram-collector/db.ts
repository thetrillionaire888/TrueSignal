// Direct SQLite access via the shared unified connection layer.
// Writes Channels (catalog.db) + ChannelStats (catalog.db) + Messages/Signals
// (audit.db) using the shared `sqlite` connection from `@/lib/db`.
//
// Architecture notes:
//   - Static channel identity lives in `catalog.Channel` (rare writes).
//   - Volatile counters (subscriberCount, lastMessageAt, messageCount,
//     signalCount, status) live in `catalog.ChannelStats` (frequent writes).
//   - Messages + Signals live in `audit.Message` / `audit.Signal` (the main
//     DB, no prefix needed).
//   - All 3 DBs are ATTACH'd on the shared connection, so cross-DB writes
//     compose into a single transaction.
//   - `$`-prefixed named params work in both bun:sqlite and better-sqlite3.
import { sqlite } from "@/lib/db";
import { cuid } from "./cuid";

// ── Prepared statements ─────────────────────────────────────────────────────
// All statements are created lazily against the shared `sqlite` connection.
// Channel + ChannelStats live in the `catalog` attached DB.
const stmts = {
  // ── catalog.Channel (static identity) ─────────────────────────────────────
  findChannelByTelegramId: sqlite.prepare(
    "SELECT id, telegramId, name, type, category, description, avatarColor, verified FROM catalog.Channel WHERE telegramId = $telegramId LIMIT 1"
  ),

  insertChannel: sqlite.prepare(
    `INSERT INTO catalog.Channel
       (id, telegramId, name, type, category, description, avatarColor, language, region, verified, monitoredSince, createdAt)
     VALUES ($id, $telegramId, $name, $type, $category, $description, $avatarColor, $language, $region, $verified, $monitoredSince, $createdAt)`
  ),

  // ── catalog.ChannelStats (volatile counters) ──────────────────────────────
  findChannelStats: sqlite.prepare(
    "SELECT channelId, subscriberCount, lastMessageAt, messageCount, signalCount, status FROM catalog.ChannelStats WHERE channelId = $channelId LIMIT 1"
  ),

  insertChannelStats: sqlite.prepare(
    `INSERT INTO catalog.ChannelStats
       (channelId, subscriberCount, lastMessageAt, messageCount, signalCount, status, updatedAt)
     VALUES ($channelId, $subscriberCount, $lastMessageAt, 0, 0, $status, datetime('now'))`
  ),

  updateChannelStatsMeta: sqlite.prepare(
    `UPDATE catalog.ChannelStats
       SET subscriberCount = $subscriberCount,
           lastMessageAt   = $lastMessageAt,
           updatedAt       = datetime('now')
     WHERE channelId = $channelId`
  ),

  incrementMessageCount: sqlite.prepare(
    `UPDATE catalog.ChannelStats
       SET messageCount = messageCount + 1,
           lastMessageAt = $postedAt,
           updatedAt     = datetime('now')
     WHERE channelId = $channelId`
  ),

  incrementSignalCount: sqlite.prepare(
    `UPDATE catalog.ChannelStats
       SET signalCount = signalCount + 1,
           updatedAt   = datetime('now')
     WHERE channelId = $channelId`
  ),

  // ── audit.Message (no prefix — main DB) ───────────────────────────────────
  findMessage: sqlite.prepare(
    "SELECT id FROM Message WHERE channelId = $channelId AND telegramMessageId = $telegramMessageId LIMIT 1"
  ),

  insertMessage: sqlite.prepare(
    `INSERT INTO Message
       (id, channelId, telegramMessageId, rawText, rawJson, senderId, senderName,
        hasMedia, mediaType, views, forwards, reactions, postedAt, ingestedAt,
        parseStatus, ingestSource)
     VALUES ($id, $channelId, $telegramMessageId, $rawText, $rawJson, $senderId, $senderName,
             $hasMedia, $mediaType, $views, $forwards, $reactions, $postedAt, $ingestedAt,
             $parseStatus, $ingestSource)`
  ),

  // ── audit.Signal (no prefix — main DB) ─────────────────────────────────────
  insertSignal: sqlite.prepare(
    `INSERT OR IGNORE INTO Signal
       (id, messageId, channelId, instrument, instrumentType, action, entryPrice,
        entryLow, entryHigh, isRange, stopLoss, takeProfits, positionSize, leverage,
        timeframe, confidence, parserVersion, parsedAt, status, notes, dedupHash)
     VALUES ($id, $messageId, $channelId, $instrument, $instrumentType, $action, $entryPrice,
             $entryLow, $entryHigh, $isRange, $stopLoss, $takeProfits, $positionSize, $leverage,
             $timeframe, $confidence, $parserVersion, $parsedAt, $status, $notes, $dedupHash)`
  ),

  // ── Stats / recent message queries (read from audit DB) ───────────────────
  countMessages: sqlite.prepare(
    "SELECT COUNT(*) as c FROM Message WHERE channelId = $channelId"
  ),
  countSignals: sqlite.prepare(
    "SELECT COUNT(*) as c FROM Signal WHERE channelId = $channelId"
  ),
  recentMessages: sqlite.prepare(
    "SELECT id, telegramMessageId, rawText, senderName, postedAt, parseStatus, hasMedia FROM Message WHERE channelId = $channelId ORDER BY postedAt DESC LIMIT $limit OFFSET $offset"
  ),
};

const AVATAR_COLORS = ["emerald", "teal", "amber", "cyan", "violet", "rose", "fuchsia", "yellow"];

export type ChannelRecord = {
  id: string;
  telegramId: string;
  name: string;
  type: string;
  category: string;
  description: string;
  subscriberCount: number;
  verified: boolean;
  avatarColor: string;
};

/**
 * Upsert a channel:
 *   - If the channel already exists in catalog.Channel (matched by telegramId),
 *     update its volatile stats in catalog.ChannelStats (subscriberCount,
 *     lastMessageAt) only.
 *   - If new, insert into BOTH catalog.Channel and catalog.ChannelStats inside
 *     a single transaction (atomic: either both succeed, or neither does).
 *
 * Returns a ChannelRecord (with the resolved id) for use by the caller.
 */
export function upsertChannel(info: {
  telegramId: string;
  name: string;
  type: string;
  category: string;
  description: string;
  subscriberCount: number;
  verified: boolean;
}): ChannelRecord {
  const existing = stmts.findChannelByTelegramId.get({ $telegramId: info.telegramId }) as
    | {
        id: string;
        telegramId: string;
        name: string;
        type: string;
        category: string;
        description: string;
        avatarColor: string;
        verified: number;
      }
    | null;

  if (existing) {
    // Channel exists — update only volatile stats. The static identity fields
    // (name, type, category, description, avatarColor, verified) are immutable
    // post-creation by design (rare write path).
    stmts.updateChannelStatsMeta.run({
      $channelId: existing.id,
      $lastMessageAt: new Date().toISOString(),
      $subscriberCount: info.subscriberCount,
    });
    return {
      id: existing.id,
      telegramId: existing.telegramId,
      name: existing.name,
      type: existing.type,
      category: existing.category,
      description: info.description, // reflect latest resolved description
      avatarColor: existing.avatarColor,
      verified: !!existing.verified,
      subscriberCount: info.subscriberCount,
    };
  }

  // New channel — insert into BOTH catalog.Channel + catalog.ChannelStats
  // atomically. The shared `sqlite` connection is ATTACH'd to catalog.db so
  // cross-DB writes compose into one transaction.
  const id = cuid();
  const now = new Date().toISOString();
  const avatarColor = AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)];
  const record: ChannelRecord = {
    id,
    telegramId: info.telegramId,
    name: info.name,
    type: info.type,
    category: info.category,
    description: info.description,
    subscriberCount: info.subscriberCount,
    verified: info.verified,
    avatarColor,
  };

  const insertChannelTx = sqlite.transaction(() => {
    stmts.insertChannel.run({
      $id: record.id,
      $telegramId: record.telegramId,
      $name: record.name,
      $type: record.type,
      $category: record.category,
      $description: record.description,
      $avatarColor: record.avatarColor,
      $language: "en",
      $region: "global",
      $verified: record.verified ? 1 : 0,
      $monitoredSince: now,
      $createdAt: now,
    });
    stmts.insertChannelStats.run({
      $channelId: record.id,
      $subscriberCount: record.subscriberCount,
      $lastMessageAt: now,
      $status: "active",
    });
  });
  insertChannelTx();

  return record;
}

/**
 * Insert a message into audit.Message (idempotent by channelId+telegramMessageId).
 * After a successful insert, increment catalog.ChannelStats.messageCount.
 */
export function insertMessage(msg: {
  channelId: string;
  telegramMessageId: number;
  rawText: string;
  rawJson: string;
  senderId: string | null;
  senderName: string | null;
  hasMedia: boolean;
  mediaType: string | null;
  views: number;
  forwards: number;
  reactions: number;
  postedAt: string;
  parseStatus: string;
}): string {
  // Idempotent: skip if already ingested (by channelId + telegramMessageId).
  const dup = stmts.findMessage.get({
    $channelId: msg.channelId,
    $telegramMessageId: msg.telegramMessageId,
  }) as { id: string } | null;
  if (dup) return dup.id;

  const id = cuid();
  stmts.insertMessage.run({
    $id: id,
    $channelId: msg.channelId,
    $telegramMessageId: msg.telegramMessageId,
    $rawText: msg.rawText,
    $rawJson: msg.rawJson,
    $senderId: msg.senderId,
    $senderName: msg.senderName,
    $hasMedia: msg.hasMedia ? 1 : 0,
    $mediaType: msg.mediaType,
    $views: msg.views,
    $forwards: msg.forwards,
    $reactions: msg.reactions,
    $postedAt: msg.postedAt,
    $ingestedAt: new Date().toISOString(),
    $parseStatus: msg.parseStatus,
    $ingestSource: "teleproto-mtproto",
  });

  // Bump the volatile counter on catalog.ChannelStats (best-effort; ignore if
  // the row is missing — shouldn't happen, but tolerate schema drift).
  try {
    stmts.incrementMessageCount.run({
      $channelId: msg.channelId,
      $postedAt: msg.postedAt,
    });
  } catch {
    /* non-fatal */
  }

  return id;
}

/**
 * Insert a parsed signal into audit.Signal with INSERT OR IGNORE (dedup by
 * dedupHash). If the insert actually happened (changes > 0), bump the
 * catalog.ChannelStats.signalCount counter.
 *
 * Returns the new signal id on success, or null if the signal was a duplicate.
 */
export function insertSignal(sig: {
  messageId: string;
  channelId: string;
  instrument: string;
  instrumentType: string;
  action: string;
  entryPrice: number;
  entryLow: number | null;
  entryHigh: number | null;
  isRange: boolean;
  stopLoss: number;
  takeProfits: string;
  positionSize: string | null;
  leverage: string | null;
  timeframe: string | null;
  confidence: number;
  notes: string | null;
  postedAt: string; // message timestamp — used for dedup
}): string | null {
  // dedupHash: channelId + postedAt timestamp. Simple and unique per message.
  const dedupHash = `${sig.channelId}|${sig.postedAt}`;

  const id = cuid();
  const result = stmts.insertSignal.run({
    $id: id,
    $messageId: sig.messageId,
    $channelId: sig.channelId,
    $instrument: sig.instrument,
    $instrumentType: sig.instrumentType,
    $action: sig.action,
    $entryPrice: sig.entryPrice,
    $entryLow: sig.entryLow,
    $entryHigh: sig.entryHigh,
    $isRange: sig.isRange ? 1 : 0,
    $stopLoss: sig.stopLoss,
    $takeProfits: sig.takeProfits,
    $positionSize: sig.positionSize,
    $leverage: sig.leverage,
    $timeframe: sig.timeframe,
    $confidence: sig.confidence,
    $parserVersion: "teleproto-regex-v2.1",
    $parsedAt: new Date().toISOString(),
    $status: "evaluating",
    $notes: sig.notes,
    $dedupHash: dedupHash,
  }) as { changes: number };

  if (result.changes > 0) {
    // Bump the volatile counter on catalog.ChannelStats (best-effort).
    try {
      stmts.incrementSignalCount.run({ $channelId: sig.channelId });
    } catch {
      /* non-fatal */
    }
    return id;
  }
  return null;
}

export function getChannelStats(channelId: string) {
  const m = stmts.countMessages.get({ $channelId: channelId }) as { c: number };
  const s = stmts.countSignals.get({ $channelId: channelId }) as { c: number };
  return { messages: m.c, signals: s.c };
}

export function getRecentMessages(channelId: string, limit = 20, offset = 0) {
  return stmts.recentMessages.all({
    $channelId: channelId,
    $limit: limit,
    $offset: offset,
  });
}
