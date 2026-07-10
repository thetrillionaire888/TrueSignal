// Direct SQLite access to the shared audit database.
// Writes Channels, Messages, and parsed Signals using bun:sqlite.
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { cuid } from "./cuid";

const DB_PATH = resolve(import.meta.dir, "../../db/custom.db");

// Ensure the db directory exists (relative to the main project root).
const absDb = DB_PATH;

if (!existsSync(absDb)) {
  mkdirSync(dirname(absDb), { recursive: true });
}

export const db = new Database(absDb);
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA busy_timeout = 5000;");

// Prepared statements (created lazily to tolerate schema not-yet-pushed).
const stmts = {
  findChannelByTelegramId: db.prepare<
    unknown,
    { $telegramId: string }
  >("SELECT * FROM Channel WHERE telegramId = $telegramId LIMIT 1"),

  insertChannel: db.prepare<
    unknown,
    Record<string, unknown>
  >(`INSERT INTO Channel
     (id, telegramId, name, type, category, description, subscriberCount, verified, avatarColor, language, region, monitoredSince, lastMessageAt, status, createdAt)
     VALUES ($id, $telegramId, $name, $type, $category, $description, $subscriberCount, $verified, $avatarColor, $language, $region, $monitoredSince, $lastMessageAt, $status, $createdAt)`),

  updateChannelMeta: db.prepare<
    unknown,
    { $id: string; $lastMessageAt: string; $subscriberCount: number; $description: string }
  >("UPDATE Channel SET lastMessageAt = $lastMessageAt, subscriberCount = $subscriberCount, description = $description WHERE id = $id"),

  findMessage: db.prepare<
    unknown,
    { $channelId: string; $telegramMessageId: number }
  >("SELECT id FROM Message WHERE channelId = $channelId AND telegramMessageId = $telegramMessageId LIMIT 1"),

  insertMessage: db.prepare<
    unknown,
    Record<string, unknown>
  >(`INSERT INTO Message
     (id, channelId, telegramMessageId, rawText, rawJson, senderId, senderName, hasMedia, mediaType, views, forwards, reactions, postedAt, ingestedAt, parseStatus, ingestSource)
     VALUES ($id, $channelId, $telegramMessageId, $rawText, $rawJson, $senderId, $senderName, $hasMedia, $mediaType, $views, $forwards, $reactions, $postedAt, $ingestedAt, $parseStatus, $ingestSource)`),

  insertSignal: db.prepare<
    unknown,
    Record<string, unknown>
  >(`INSERT OR IGNORE INTO Signal
     (id, messageId, channelId, instrument, instrumentType, action, entryPrice, entryLow, entryHigh, isRange, stopLoss, takeProfits, positionSize, leverage, timeframe, confidence, parserVersion, parsedAt, status, notes, dedupHash)
     VALUES ($id, $messageId, $channelId, $instrument, $instrumentType, $action, $entryPrice, $entryLow, $entryHigh, $isRange, $stopLoss, $takeProfits, $positionSize, $leverage, $timeframe, $confidence, $parserVersion, $parsedAt, $status, $notes, $dedupHash)`),

  countMessages: db.prepare<{ c: number }, { $channelId: string }>(
    "SELECT COUNT(*) as c FROM Message WHERE channelId = $channelId"
  ),
  countSignals: db.prepare<{ c: number }, { $channelId: string }>(
    "SELECT COUNT(*) as c FROM Signal WHERE channelId = $channelId"
  ),
  recentMessages: db.prepare<
    {
      id: string;
      telegramMessageId: number;
      rawText: string;
      senderName: string | null;
      postedAt: string;
      parseStatus: string;
      hasMedia: number;
    },
    { $channelId: string; $limit: number; $offset: number }
  >("SELECT id, telegramMessageId, rawText, senderName, postedAt, parseStatus, hasMedia FROM Message WHERE channelId = $channelId ORDER BY postedAt DESC LIMIT $limit OFFSET $offset"),
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
    | ChannelRecord
    | null;
  if (existing) {
    stmts.updateChannelMeta.run({
      $id: existing.id,
      $lastMessageAt: new Date().toISOString(),
      $subscriberCount: info.subscriberCount,
      $description: info.description,
    });
    return { ...existing, subscriberCount: info.subscriberCount, description: info.description };
  }
  const id = cuid();
  const now = new Date().toISOString();
  const record: ChannelRecord = {
    id,
    telegramId: info.telegramId,
    name: info.name,
    type: info.type,
    category: info.category,
    description: info.description,
    subscriberCount: info.subscriberCount,
    verified: info.verified,
    avatarColor: AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)],
  };
  stmts.insertChannel.run({
    $id: record.id,
    $telegramId: record.telegramId,
    $name: record.name,
    $type: record.type,
    $category: record.category,
    $description: record.description,
    $subscriberCount: record.subscriberCount,
    $verified: record.verified ? 1 : 0,
    $avatarColor: record.avatarColor,
    $language: "en",
    $region: "global",
    $monitoredSince: now,
    $lastMessageAt: now,
    $status: "active",
    $createdAt: now,
  });
  return record;
}

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
  return id;
}

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
  // DedupHash: channelId + postedAt timestamp.
  // Simple and unique — each message has a unique timestamp, so the
  // combination of channelId + timestamp uniquely identifies a signal.
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
  });
  return result.changes > 0 ? id : null;
}

export function getChannelStats(channelId: string) {
  const m = stmts.countMessages.get({ $channelId: channelId }) as { c: number };
  const s = stmts.countSignals.get({ $channelId: channelId }) as { c: number };
  return { messages: m.c, signals: s.c };
}

export function getRecentMessages(channelId: string, limit = 20, offset = 0) {
  return stmts.recentMessages.all({ $channelId: channelId, $limit: limit, $offset: offset });
}
