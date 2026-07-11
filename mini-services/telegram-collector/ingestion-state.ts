// Ingestion job state manager: tracks the active ingestion job and supports
// pause / resume / stop control signals. Persists resume position (offsetId)
// per channel in `catalog.IngestState` so ingestion can resume from where it
// left off.
//
// Uses the shared `sqlite` connection from `@/lib/db` (catalog.db is ATTACH'd
// as `catalog`). The IngestState table is created by the Drizzle schema push
// (src/lib/schema/catalog.ts → ingestState), so we don't CREATE TABLE here.
// `$`-prefixed named params work in both bun:sqlite and better-sqlite3.
import { sqlite } from "@/lib/db";

const stmts = {
  getIngestState: sqlite.prepare(
    "SELECT offsetId, fetchedCount FROM catalog.IngestState WHERE channelId = $channelId"
  ),
  upsertIngestState: sqlite.prepare(
    "INSERT INTO catalog.IngestState (channelId, offsetId, fetchedCount, updatedAt) VALUES ($channelId, $offsetId, $fetchedCount, datetime('now')) ON CONFLICT(channelId) DO UPDATE SET offsetId = $offsetId, fetchedCount = $fetchedCount, updatedAt = datetime('now')"
  ),
  clearIngestState: sqlite.prepare(
    "DELETE FROM catalog.IngestState WHERE channelId = $channelId"
  ),
  // Get the oldest stored message ID for a channel — used to skip already-ingested
  // messages when re-ingesting "all history" after a stop.
  getOldestMessageId: sqlite.prepare(
    "SELECT MIN(telegramMessageId) as minId FROM Message WHERE channelId = $channelId"
  ),
  // Count how many messages are already stored for a channel
  countMessages: sqlite.prepare(
    "SELECT COUNT(*) as c FROM Message WHERE channelId = $channelId"
  ),
};

export type IngestionControlState = "running" | "paused" | "stopped" | "idle";

export type IngestionStatus = {
  state: IngestionControlState;
  jobId: string | null;
  channelId: string | null;
  channelName: string | null;
  fetched: number;
  inserted: number;
  signalsParsed: number;
  offsetId: number | null; // last position (for resume)
  canResume: boolean; // true if there's a saved position to resume from
};

// In-memory control flags for the active job
let controlState: IngestionControlState = "idle";
let activeJobId: string | null = null;
let activeChannelId: string | null = null;
let activeChannelName: string | null = null;
let activeFetched = 0;
let activeInserted = 0;
let activeSignalsParsed = 0;
let activeOffsetId = 0;

// Control signal: the running generator checks this between batches.
// - "running": continue normally
// - "paused": wait (spin-loop with sleep) until changed
// - "stopped": break out of the loop
let controlSignal: "running" | "paused" | "stopped" = "running";

export function getIngestionStatus(): IngestionStatus {
  const canResume =
    controlState === "idle" &&
    activeChannelId != null &&
    stmts.getIngestState.get({ $channelId: activeChannelId }) != null;

  return {
    state: controlState,
    jobId: activeJobId,
    channelId: activeChannelId,
    channelName: activeChannelName,
    fetched: activeFetched,
    inserted: activeInserted,
    signalsParsed: activeSignalsParsed,
    offsetId: activeOffsetId || null,
    canResume,
  };
}

export function startJob(jobId: string, channelId: string, channelName: string) {
  activeJobId = jobId;
  activeChannelId = channelId;
  activeChannelName = channelName;
  activeFetched = 0;
  activeInserted = 0;
  activeSignalsParsed = 0;
  activeOffsetId = 0;
  controlState = "running";
  controlSignal = "running";
}

export function updateProgress(fetched: number, inserted: number, signalsParsed: number, offsetId: number) {
  activeFetched = fetched;
  activeInserted = inserted;
  activeSignalsParsed = signalsParsed;
  activeOffsetId = offsetId;
  // Persist resume position
  if (activeChannelId) {
    try {
      stmts.upsertIngestState.run({
        $channelId: activeChannelId,
        $offsetId: offsetId,
        $fetchedCount: fetched,
      });
    } catch {
      /* non-fatal */
    }
  }
}

/**
 * Check control signal between batches. Called by iterHistory.
 * - If "paused": blocks (sleeps) until resumed or stopped.
 * - If "stopped": returns true (caller should break).
 * - If "running": returns false (continue).
 */
export async function checkControlSignal(): Promise<boolean> {
  while (controlSignal === "paused") {
    await new Promise((r) => setTimeout(r, 500));
  }
  return controlSignal === "stopped";
}

export function pauseJob() {
  if (controlState === "running") {
    controlState = "paused";
    controlSignal = "paused";
  }
}

export function resumeJob() {
  if (controlState === "paused") {
    controlState = "running";
    controlSignal = "running";
  }
}

export function stopJob() {
  controlSignal = "stopped";
  controlState = "stopped";
}

export function finishJob() {
  // Called when ingestion completes or stops — clear active job state
  // but keep the IngestState row for resume (only cleared on explicit clear)
  controlState = "idle";
  // Don't clear activeChannelId immediately so getIngestionStatus can report canResume
}

export function getResumePosition(channelId: string): { offsetId: number; fetchedCount: number } | null {
  const row = stmts.getIngestState.get({ $channelId: channelId }) as
    | { offsetId: number; fetchedCount: number }
    | null;
  if (!row) return null;
  return { offsetId: row.offsetId, fetchedCount: row.fetchedCount };
}

export function clearResumePosition(channelId: string) {
  stmts.clearIngestState.run({ $channelId: channelId });
}

/**
 * Get the oldest stored telegramMessageId for a channel.
 * Used to skip already-ingested messages when re-ingesting "all history".
 *
 * When a user stops ingestion and re-starts "all history", instead of
 * re-fetching from the newest message (wasting bandwidth on messages
 * already in the DB), we use this as the resume offsetId — Telegram's
 * GetHistory with offsetId=X returns messages older than X.
 */
export function getOldestStoredMessageId(channelId: string): number | null {
  const row = stmts.getOldestMessageId.get({ $channelId: channelId }) as { minId: number | null } | null;
  if (!row || row.minId == null) return null;
  return row.minId;
}

/**
 * Count stored messages for a channel.
 */
export function countStoredMessages(channelId: string): number {
  const row = stmts.countMessages.get({ $channelId: channelId }) as { c: number };
  return row.c;
}
