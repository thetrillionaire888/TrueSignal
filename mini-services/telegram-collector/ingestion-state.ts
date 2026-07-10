// Ingestion job state manager: tracks the active ingestion job and supports
// pause / resume / stop control signals. Also persists resume position
// (offsetId) per channel so ingestion can resume from where it left off.
import { Database } from "bun:sqlite";
import { resolve } from "node:path";

const DB_PATH = resolve(import.meta.dir, "../../db/custom.db");
const db = new Database(DB_PATH);
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA busy_timeout = 5000;");

// Persist the last-fetched offsetId per channel so we can resume.
db.exec(`
  CREATE TABLE IF NOT EXISTS IngestState (
    channelId     TEXT PRIMARY KEY,
    offsetId      INTEGER NOT NULL,
    fetchedCount  INTEGER NOT NULL DEFAULT 0,
    updatedAt     TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

const stmts = {
  getIngestState: db.prepare<{ offsetId: number; fetchedCount: number }, { $channelId: string }>(
    "SELECT offsetId, fetchedCount FROM IngestState WHERE channelId = $channelId"
  ),
  upsertIngestState: db.prepare<
    unknown,
    { $channelId: string; $offsetId: number; $fetchedCount: number }
  >(
    "INSERT INTO IngestState (channelId, offsetId, fetchedCount, updatedAt) VALUES ($channelId, $offsetId, $fetchedCount, datetime('now')) ON CONFLICT(channelId) DO UPDATE SET offsetId = $offsetId, fetchedCount = $fetchedCount, updatedAt = datetime('now')"
  ),
  clearIngestState: db.prepare<unknown, { $channelId: string }>(
    "DELETE FROM IngestState WHERE channelId = $channelId"
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
  const row = stmts.getIngestState.get({ $channelId: channelId });
  if (!row) return null;
  return { offsetId: row.offsetId, fetchedCount: row.fetchedCount };
}

export function clearResumePosition(channelId: string) {
  stmts.clearIngestState.run({ $channelId: channelId });
}
