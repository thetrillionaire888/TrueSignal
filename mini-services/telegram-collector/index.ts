// Telegram collector mini-service.
// HTTP API + Socket.IO for real-time ingestion progress.
// Runs on port 3001.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Server as IOServer } from "socket.io";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { sqlite } from "@/lib/db";
import { getMarketDbSync, listMarketDbs } from "@/lib/market-db";
import * as tg from "./telegram";
import { parseSignal } from "./parser";
import { evaluateSignals, getEvalStats, type EvalProgress } from "./evaluator";
import { importFromSource } from "./importers";
import { getCacheSummary, importBars, type Bar } from "./bar-cache";
import { parseCsvFlexible, aggregateBars, detectTimeframe, StreamingCsvParser } from "./csv-parser";
import { randomUUID } from "node:crypto";
import {
  startJob,
  updateProgress,
  finishJob,
  pauseJob,
  resumeJob,
  stopJob,
  getIngestionStatus,
  getResumePosition,
  clearResumePosition,
  getOldestStoredMessageId,
  countStoredMessages,
  type IngestionStatus,
} from "./ingestion-state";
import {
  upsertChannel,
  insertMessage,
  insertSignal,
  getChannelStats,
  getRecentMessages,
} from "./db";

const PORT = 3001;

// ── Chunked upload sessions ─────────────────────────────────────────────────
// Maps uploadId → session state for chunked CSV imports.
// Each session holds a StreamingCsvParser that accumulates state across chunks.
type ChunkUploadSession = {
  parser: StreamingCsvParser;
  batch: Bar[];
  totalInserted: number;
  totalSkipped: number;
  totalParsed: number;
  firstBarTs: number | null;
  lastBarTs: number | null;
  sourceTimeframe: string;
  instrument: string;
  source: string;
  timeframe: string;
  flushBatch: () => void;
};

const chunkUploadSessions = new Map<string, ChunkUploadSession>();

const CHUNK_BATCH_SIZE = 5000;

function createChunkUploadSession(
  uploadId: string,
  instrument: string,
  source: string,
  timeframe: string,
  io: IOServer
): ChunkUploadSession {
  const session: ChunkUploadSession = {
    parser: null as any, // set below
    batch: [],
    totalInserted: 0,
    totalSkipped: 0,
    totalParsed: 0,
    firstBarTs: null,
    lastBarTs: null,
    sourceTimeframe: "m1",
    instrument,
    source,
    timeframe,
    flushBatch: () => {}, // set below
  };

  session.flushBatch = () => {
    if (session.batch.length === 0) return;
    const { inserted, skipped } = importBars(source, instrument, timeframe, session.batch);
    session.totalInserted += inserted;
    session.totalSkipped += skipped;
    session.batch = [];
  };

  let timeframeDetected = false;
  let detectionBars: Bar[] = [];

  session.parser = new StreamingCsvParser({
    onBar: (bar) => {
      session.totalParsed++;
      if (session.firstBarTs === null) session.firstBarTs = bar.timestamp;
      session.lastBarTs = bar.timestamp;

      // Detect timeframe from first 100 bars
      if (!timeframeDetected) {
        detectionBars.push(bar);
        if (detectionBars.length >= 100) {
          const detected = detectTimeframe(detectionBars);
          if (detected) session.sourceTimeframe = detected;
          timeframeDetected = true;
          detectionBars = [];
        }
      }

      session.batch.push(bar);
      if (session.batch.length >= CHUNK_BATCH_SIZE) {
        session.flushBatch();
      }
    },
  });

  // Auto-cleanup after 30 minutes (in case client disconnects mid-upload)
  setTimeout(() => {
    if (chunkUploadSessions.has(uploadId)) {
      console.warn(`[import-csv-chunk] Session ${uploadId} timed out — cleaning up`);
      chunkUploadSessions.delete(uploadId);
    }
  }, 30 * 60 * 1000);

  return session;
}

const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const path = url.pathname;

  // ── Streaming CSV upload (must be handled BEFORE readBody to avoid OOM) ──
  // This endpoint receives multipart/form-data with a large CSV file.
  // It streams the file through a line-by-line parser and batch-inserts,
  // so memory usage stays flat regardless of file size.
  // All other POST endpoints use readBody (JSON body) which buffers the
  // full body in memory — fine for small payloads, OOM for 400MB+ CSVs.
  if (path === "/api/import-csv-stream" && req.method === "POST") {
    return handleStreamingCsvImport(req, res, io);
  }

  const body = req.method === "POST" ? await readBody(req) : {};

  try {
    // ── Auth endpoints ──────────────────────────────────────────────────────
    if (path === "/api/status" && req.method === "GET") {
      const info = tg.getSessionInfo();
      return json(res, 200, info);
    }

    if (path === "/api/connect" && req.method === "POST") {
      const info = await tg.connect();
      return json(res, 200, info);
    }

    if (path === "/api/auth/request-code" && req.method === "POST") {
      const phone = String(body.phone ?? "").trim();
      if (!phone) return json(res, 400, { error: "phone is required" });
      const info = await tg.requestCode(phone);
      return json(res, 200, info);
    }

    if (path === "/api/auth/submit-code" && req.method === "POST") {
      const code = String(body.code ?? "").trim();
      if (!code) return json(res, 400, { error: "code is required" });
      const info = await tg.submitCode(code);
      return json(res, 200, info);
    }

    if (path === "/api/auth/submit-2fa" && req.method === "POST") {
      const password = String(body.password ?? "");
      if (!password) return json(res, 400, { error: "password is required" });
      const info = await tg.submit2fa(password);
      return json(res, 200, info);
    }

    if (path === "/api/auth/logout" && req.method === "POST") {
      const info = await tg.logout();
      return json(res, 200, info);
    }

    // ── Channel resolve ─────────────────────────────────────────────────────
    if (path === "/api/resolve-channel" && req.method === "POST") {
      const query = String(body.query ?? "").trim();
      if (!query) return json(res, 400, { error: "query is required" });
      const session = tg.getSessionInfo();
      if (session.state !== "authenticated") {
        return json(res, 401, { error: "Not authenticated. Complete login first." });
      }
      const resolved = await tg.resolveChannel(query);
      if (!resolved) return json(res, 404, { error: "Channel not found" });
      // If this channel already exists in the DB, update its subscriber count
      // (and lastMessageAt) so the UI shows the real member count.
      const telegramId = resolved.username
        ? `@${resolved.username}`
        : `id:${resolved.id}`;
      try {
        upsertChannel({
          telegramId,
          name: resolved.title,
          type: resolved.type,
          category: inferCategory(resolved.title),
          description: resolved.about || `${resolved.title} — no channel description set`,
          subscriberCount: resolved.participantCount,
          verified: resolved.verified,
        });
      } catch {
        /* non-fatal — channel may not exist in DB yet */
      }
      return json(res, 200, { channel: resolved });
    }

    // ── Ingest ──────────────────────────────────────────────────────────────
    if (path === "/api/ingest" && req.method === "POST") {
      const query = String(body.query ?? "").trim();
      // limit: 0 means "all messages" (no cap). Otherwise cap at 50000 for safety.
      const rawLimit = Number(body.limit ?? 200);
      const limit = rawLimit === 0 ? 0 : Math.min(50000, Math.max(1, rawLimit));
      if (!query) return json(res, 400, { error: "query is required" });
      const session = tg.getSessionInfo();
      if (session.state !== "authenticated") {
        return json(res, 401, { error: "Not authenticated. Complete login first." });
      }

      // Run ingestion asynchronously, stream progress via socket.io
      const jobId = `ingest-${Date.now()}`;
      ingestAsync(jobId, query, limit, io).catch((e) => {
        console.error("Ingestion error:", e);
        io.emit("ingest:error", { jobId, phase: "error", message: e instanceof Error ? e.message : String(e) });
      });
      return json(res, 200, { jobId, message: "Ingestion started", limit });
    }

    // ── Channel stats (from DB) ─────────────────────────────────────────────
    if (path.startsWith("/api/channel-stats/") && req.method === "GET") {
      const channelId = path.split("/").pop() ?? "";
      const page = Math.max(1, Number(url.searchParams.get("page") ?? "1"));
      const pageSize = Math.min(100, Math.max(5, Number(url.searchParams.get("pageSize") ?? "20")));
      const offset = (page - 1) * pageSize;
      const stats = getChannelStats(channelId);
      const recent = getRecentMessages(channelId, pageSize, offset);
      return json(res, 200, {
        stats,
        recent,
        page,
        pageSize,
        total: stats.messages,
        totalPages: Math.max(1, Math.ceil(stats.messages / pageSize)),
      });
    }

    // ── Evaluate signals against Dukascopy historical data ─────────────────
    if (path === "/api/evaluate" && req.method === "POST") {
      const channelId = (body.channelId as string) || null;
      const forceReevaluate = Boolean(body.forceReevaluate);
      // Run evaluation asynchronously, stream progress via socket.io
      const jobId = `eval-${Date.now()}`;
      evaluateSignals(channelId, (p: EvalProgress) => {
        io.emit("evaluate:progress", p);
      }, forceReevaluate).catch((e) => {
        console.error("Evaluation error:", e);
        io.emit("evaluate:progress", {
          jobId,
          phase: "error",
          message: e instanceof Error ? e.message : String(e),
        } as EvalProgress);
      });
      return json(res, 200, { jobId, message: forceReevaluate ? "Re-evaluation started (all signals)" : "Evaluation started", channelId, forceReevaluate });
    }

    // ── Re-evaluate a single signal by ID ───────────────────────────────────
    // Fetches fresh bars from Dukascopy (with retry), evaluates, and replaces
    // the existing Evaluation record. Used when the user wants to re-check a
    // signal — especially 'no_data' outcomes caused by Dukascopy socket errors.
    if (path === "/api/evaluate-signal" && req.method === "POST") {
      const signalId = (body.signalId as string) || null;
      if (!signalId) return json(res, 400, { error: "signalId is required" });

      try {
        const { evaluateSignal, extractEntryType, parseDbDate, toDukascopyInstrument, fetchBars, saveEvaluation, EvalResult, SignalRow } = {
          evaluateSignal: (await import("./evaluator")).evaluateSignal,
          extractEntryType: (await import("./evaluator")).extractEntryType,
          parseDbDate: (await import("./evaluator")).parseDbDate,
          toDukascopyInstrument: (await import("./evaluator")).toDukascopyInstrument,
          fetchBars: (await import("./evaluator")).fetchBars,
          saveEvaluation: (await import("./evaluator")).saveEvaluation,
        };

        // Get the signal + its message
        const signal = sqlite.prepare(`
          SELECT s.id as signalId, s.messageId, s.channelId, s.instrument, s.action,
                 s.entryPrice, s.entryLow, s.entryHigh, s.isRange, s.stopLoss,
                 s.takeProfits, s.notes, m.postedAt
          FROM Signal s
          JOIN Message m ON s.messageId = m.id
          WHERE s.id = ?
        `).get(signalId) as any;

        if (!signal) return json(res, 404, { error: "Signal not found" });

        const dukascopyInstrument = toDukascopyInstrument(signal.instrument);
        if (!dukascopyInstrument) {
          return json(res, 400, { error: `Cannot map ${signal.instrument} to Dukascopy instrument` });
        }

        // Fetch bars with retry (48h window from signal post time).
        // forceRefresh=true bypasses the cache-hit optimization so we always
        // try Dukascopy — important for re-evaluating 'no_data' signals where
        // new bars may have become available since the first eval attempt.
        const signalTime = parseDbDate(signal.postedAt);
        const { bars, stats } = await fetchBars(dukascopyInstrument, signalTime, 48, undefined, true);

        // Derive the marketDataSource label from the fetch stats
        const sourceLabel = stats.source
          ? stats.source.toLowerCase().split(" ")[0]
          : "dukascopy";
        let timeframe = "m15";
        if (bars.length >= 2) {
          const gap = bars[1].timestamp - bars[0].timestamp;
          if (gap === 60000) timeframe = "m1";
          else if (gap === 900000) timeframe = "m15";
        }
        const marketDataSource = `${sourceLabel}-${timeframe}`;

        // Delete old evaluation
        sqlite.prepare("DELETE FROM Evaluation WHERE signalId = ?").run(signalId);

        // Re-evaluate
        const result = evaluateSignal(signal, bars, marketDataSource);
        saveEvaluation(result);

        return json(res, 200, {
          signalId,
          outcome: result.outcome,
          exitPrice: result.exitPrice,
          exitReason: result.exitReason,
          rMultiple: result.rMultiple,
          barsAnalyzed: result.barsAnalyzed,
          barsCached: stats.cached,
          barsFetched: stats.fetched,
          message: `Re-evaluated: ${result.outcome} (R=${result.rMultiple}, ${bars.length} bars, ${stats.cached} cached / ${stats.fetched} fetched)`,
        });
      } catch (e) {
        return json(res, 500, { error: e instanceof Error ? e.message : String(e) });
      }
    }

    // ── Parse messages for a channel (multi-stage parser + correlator) ──────
    // Clears old signals/evaluations, re-parses all messages, then runs the
    // order-ID correlator for multi-message signals. Idempotent — safe to
    // call multiple times.
    if (path === "/api/parse" && req.method === "POST") {
      const channelId = (body.channelId as string) || null;
      if (!channelId) return json(res, 400, { error: "channelId is required" });

      try {
        const { parseSignal } = await import("./parser");
        const { correlateChannelSignals } = await import("./correlator");
        const { cuid } = await import("./cuid");

        // Get all messages for this channel
        const messages = sqlite.prepare(
          "SELECT id, channelId, rawText, postedAt FROM Message WHERE channelId = ? ORDER BY postedAt ASC"
        ).all(channelId) as Array<{ id: string; channelId: string; rawText: string; postedAt: string }>;

        // Clear old signals + evaluations for this channel
        const clearTx = sqlite.transaction(() => {
          sqlite.prepare("DELETE FROM Evaluation WHERE signalId IN (SELECT id FROM Signal WHERE channelId = ?)").run(channelId);
          sqlite.prepare("DELETE FROM Signal WHERE channelId = ?").run(channelId);
        });
        clearTx();

        // Re-parse each message with the multi-stage parser
        let parsedCount = 0;
        let correlatedCount = 0;
        const insertSignal = sqlite.prepare(
          `INSERT OR IGNORE INTO Signal (id, messageId, channelId, instrument, instrumentType, action, entryPrice, entryLow, entryHigh, isRange, stopLoss, takeProfits, positionSize, leverage, timeframe, confidence, parserVersion, parsedAt, status, notes, dedupHash) VALUES ($id, $messageId, $channelId, $instrument, $instrumentType, $action, $entryPrice, $entryLow, $entryHigh, $isRange, $stopLoss, $takeProfits, $positionSize, $leverage, $timeframe, $confidence, $parserVersion, $parsedAt, $status, $notes, $dedupHash)`
        );

        const parseTx = sqlite.transaction(() => {
          for (const msg of messages) {
            const result = parseSignal(msg.rawText || "");
            if (result) {
              const id = cuid();
              const dedupHash = `${msg.channelId}|${msg.postedAt}`;
              insertSignal.run({
                $id: id, $messageId: msg.id, $channelId: msg.channelId,
                $instrument: result.instrument, $instrumentType: result.instrumentType,
                $action: result.action, $entryPrice: result.entryPrice,
                $entryLow: result.entryLow, $entryHigh: result.entryHigh,
                $isRange: result.isRange ? 1 : 0, $stopLoss: result.stopLoss,
                $takeProfits: JSON.stringify(result.takeProfits),
                $positionSize: result.positionSize, $leverage: result.leverage,
                $timeframe: result.timeframe, $confidence: result.confidence,
                $parserVersion: "multi-stage-v3", $parsedAt: new Date().toISOString(),
                $status: "evaluating", $notes: result.notes, $dedupHash: dedupHash,
              });
              sqlite.prepare("UPDATE Message SET parseStatus = 'parsed' WHERE id = ?").run(msg.id);
              parsedCount++;
            } else {
              const hasText = (msg.rawText || "").trim().length > 0;
              sqlite.prepare("UPDATE Message SET parseStatus = ? WHERE id = ?").run(hasText ? "no_signal" : "no_text", msg.id);
            }
          }
        });
        parseTx();

        // Run correlator for multi-message signals (order ID / magic number)
        const corrResult = correlateChannelSignals(channelId);
        correlatedCount = corrResult.signalsCreated;

        // Update channel stats
        sqlite.prepare(
          "UPDATE catalog.ChannelStats SET signalCount = (SELECT COUNT(*) FROM Signal WHERE channelId = ?), messageCount = (SELECT COUNT(*) FROM Message WHERE channelId = ?), updatedAt = datetime('now') WHERE channelId = ?"
        ).all(channelId, channelId, channelId);

        return json(res, 200, {
          channelId,
          messagesProcessed: messages.length,
          signalsParsed: parsedCount,
          signalsCorrelated: correlatedCount,
          totalSignals: parsedCount + correlatedCount,
        });
      } catch (e) {
        return json(res, 500, { error: e instanceof Error ? e.message : String(e) });
      }
    }

    if (path === "/api/eval-stats" && req.method === "GET") {
      const channelId = url.searchParams.get("channelId") ?? undefined;
      const stats = getEvalStats(channelId);
      return json(res, 200, stats);
    }

    // ── Chunked CSV import (for very large files — 400MB+) ─────────────────
    // Splits the file into 5MB chunks on the frontend, sends each as a
    // separate small JSON request. The server maintains a per-upload
    // StreamingCsvParser session and feeds each chunk to it.
    //
    // This avoids the ERR_CONNECTION_RESET that happens with single-request
    // multipart uploads of 400MB+ through Caddy/proxy layers.
    //
    // Body: { uploadId, instrument, source, timeframe, chunkIndex, totalChunks, data, isLast }
    //   - uploadId: unique session ID (generated by frontend)
    //   - data: a 5MB chunk of CSV text
    //   - isLast: true on the final chunk
    if (path === "/api/import-csv-chunk" && req.method === "POST") {
      const uploadId = String(body.uploadId ?? "");
      const instrument = String(body.instrument ?? "").trim().toLowerCase();
      const source = String(body.source ?? "dukascopy").toLowerCase();
      const timeframe = String(body.timeframe ?? "m1").toLowerCase();
      const chunkIndex = Number(body.chunkIndex ?? 0);
      const totalChunks = Number(body.totalChunks ?? 0);
      const data = String(body.data ?? "");
      const isLast = Boolean(body.isLast);

      if (!uploadId || !instrument) {
        return json(res, 400, { error: "uploadId and instrument are required" });
      }
      if (!data && !isLast) {
        return json(res, 400, { error: "data is required for non-final chunks" });
      }

      // Get or create the upload session
      let session = chunkUploadSessions.get(uploadId);
      if (!session) {
        // First chunk — create a new session
        session = createChunkUploadSession(uploadId, instrument, source, timeframe, io);
        chunkUploadSessions.set(uploadId, session);
      }

      // Feed the chunk data to the streaming parser
      if (data) {
        session.parser.feed(data);
      }

      // Emit progress
      io.emit("import:progress", {
        jobId: uploadId,
        phase: "importing" as const,
        message: `Uploading ${instrument.toUpperCase()}: chunk ${chunkIndex + 1}/${totalChunks} (${session.totalParsed.toLocaleString()} bars parsed so far)`,
        parsed: session.totalParsed,
        inserted: session.totalInserted,
        skipped: session.totalSkipped,
        instrument,
        timeframe,
        chunkIndex,
        totalChunks,
      });

      if (isLast) {
        // Final chunk — finish parsing and return results
        session.parser.end();
        session.flushBatch();

        const result = {
          instrument,
          source,
          timeframe,
          parsedBars: session.totalParsed,
          inserted: session.totalInserted,
          skipped: session.totalSkipped,
          sourceTimeframe: session.sourceTimeframe,
          dateRange: {
            from: session.firstBarTs !== null ? new Date(session.firstBarTs).toISOString() : null,
            to: session.lastBarTs !== null ? new Date(session.lastBarTs).toISOString() : null,
          },
        };

        // Clean up the session
        chunkUploadSessions.delete(uploadId);

        // Emit complete event
        io.emit("import:progress", {
          jobId: uploadId,
          phase: "complete" as const,
          message: `Import complete: ${result.inserted.toLocaleString()} bars inserted, ${result.skipped.toLocaleString()} skipped`,
          parsed: result.parsedBars,
          inserted: result.inserted,
          skipped: result.skipped,
          instrument,
          timeframe,
          sourceTimeframe: result.sourceTimeframe,
          dateRange: result.dateRange,
        });

        console.log(`[import-csv-chunk] Complete: ${uploadId} — ${result.inserted} inserted, ${result.skipped} skipped, ${result.parsedBars} parsed`);

        return json(res, 200, result);
      }

      // Intermediate chunk — acknowledge
      return json(res, 200, {
        uploadId,
        chunkIndex,
        totalParsed: session.totalParsed,
        inserted: session.totalInserted,
        skipped: session.totalSkipped,
        message: `Chunk ${chunkIndex + 1}/${totalChunks} received`,
      });
    }

    // ── Import CSV (flexible format, high-quality Dukascopy data) ───────────
    // Accepts CSV text in multiple formats:
    //   - StrategyQuant: Date,Time,Open,High,Low,Close,Volume (YYYYMMDD HH:MM:SS)
    //   - Combined:      DateTime,Open,High,Low,Close,Volume (ISO 8601)
    //   - Unix:          timestamp,open,high,low,close,volume (epoch)
    //   - Bid/Ask:       DateTime,Bid,Ask,Volume (mid-price derived)
    //
    // Body: { instrument, source, timeframe, csvText, aggregate? }
    //   - instrument: e.g. "xauusd"
    //   - source: e.g. "dukascopy" (stored in PriceBar.source)
    //   - timeframe: target timeframe for storage (e.g. "m1" or "m15")
    //   - csvText: the CSV content as a string
    //   - aggregate: optional, "auto" | true | false
    //     - "auto": detect source timeframe from bar gaps, aggregate if needed
    //     - true: always aggregate to target timeframe
    //     - false: store as-is (timestamps must already match target timeframe)
    //     - default: "auto"
    if (path === "/api/import-csv" && req.method === "POST") {
      const instrument = String(body.instrument ?? "").trim().toLowerCase();
      const source = String(body.source ?? "dukascopy").toLowerCase();
      const timeframe = String(body.timeframe ?? "m1").toLowerCase();
      const csvText = body.csvText as string | undefined;
      const aggregateMode = body.aggregate ?? "auto"; // "auto" | true | false

      if (!instrument) {
        return json(res, 400, { error: "instrument is required" });
      }
      if (!csvText || csvText.trim().length === 0) {
        return json(res, 400, { error: "csvText is required (non-empty)" });
      }

      try {
        // Parse the CSV (auto-detects format)
        const parsedBars = parseCsvFlexible(csvText);
        if (parsedBars.length === 0) {
          return json(res, 400, { error: "No valid bars found in CSV. Check the format." });
        }

        // Detect the source timeframe from bar gaps
        const detectedTf = detectTimeframe(parsedBars);
        const sourceTimeframe = detectedTf ?? "m1";

        // Decide whether to aggregate
        let barsToStore: Bar[] = parsedBars;
        let aggregated = false;
        let aggregationNote: string | undefined;

        if (aggregateMode === "auto") {
          if (sourceTimeframe !== timeframe) {
            try {
              barsToStore = aggregateBars(parsedBars, sourceTimeframe, timeframe);
              aggregated = true;
              aggregationNote = `aggregated ${sourceTimeframe} → ${timeframe}`;
            } catch (e) {
              // If aggregation fails (e.g., unknown timeframe), store as-is
              aggregationNote = `aggregation skipped: ${e instanceof Error ? e.message : String(e)}`;
            }
          }
        } else if (aggregateMode === true || aggregateMode === "true") {
          try {
            barsToStore = aggregateBars(parsedBars, sourceTimeframe, timeframe);
            aggregated = true;
            aggregationNote = `aggregated ${sourceTimeframe} → ${timeframe}`;
          } catch (e) {
            return json(res, 400, { error: `Aggregation failed: ${e instanceof Error ? e.message : String(e)}` });
          }
        }
        // else aggregateMode === false: store as-is

        // Insert into the per-asset DB
        const { inserted, skipped } = importBars(source, instrument, timeframe, barsToStore);

        return json(res, 200, {
          instrument,
          source,
          timeframe,
          parsedBars: parsedBars.length,
          storedBars: barsToStore.length,
          inserted,
          skipped,
          aggregated,
          sourceTimeframe,
          aggregationNote,
          dateRange: {
            from: barsToStore.length > 0 ? new Date(barsToStore[0].timestamp).toISOString() : null,
            to: barsToStore.length > 0 ? new Date(barsToStore[barsToStore.length - 1].timestamp).toISOString() : null,
          },
          sampleRows: barsToStore.slice(0, 3).map((b) => ({
            timestamp: b.timestamp,
            datetime: new Date(b.timestamp).toISOString(),
            open: b.open,
            high: b.high,
            low: b.low,
            close: b.close,
            volume: b.volume,
          })),
        });
      } catch (e) {
        return json(res, 500, { error: e instanceof Error ? e.message : String(e) });
      }
    }

    // ── Import price data from various sources ──────────────────────────────
    if (path === "/api/import" && req.method === "POST") {
      const source = String(body.source ?? "").toLowerCase();
      const instrument = String(body.instrument ?? "").trim().toLowerCase();
      const timeframe = String(body.timeframe ?? "m15").toLowerCase();
      const startDate = body.startDate ? new Date(body.startDate as string) : null;
      const endDate = body.endDate ? new Date(body.endDate as string) : null;
      const csvText = body.csvText as string | undefined;

      if (!source || !instrument) {
        return json(res, 400, { error: "source and instrument are required" });
      }
      if (source !== "csv" && (!startDate || !endDate)) {
        return json(res, 400, { error: "startDate and endDate are required for non-CSV sources" });
      }

      try {
        const result = await importFromSource(
          source,
          instrument,
          timeframe,
          startDate ?? new Date(0),
          endDate ?? new Date(),
          csvText
        );
        return json(res, 200, {
          source,
          instrument,
          timeframe,
          barsFetched: result.bars.length,
          inserted: result.inserted,
          skipped: result.skipped,
          dateRange: {
            from: result.bars.length > 0 ? new Date(result.bars[0].timestamp).toISOString() : null,
            to: result.bars.length > 0 ? new Date(result.bars[result.bars.length - 1].timestamp).toISOString() : null,
          },
        });
      } catch (e) {
        return json(res, 500, { error: e instanceof Error ? e.message : String(e) });
      }
    }

    // ── Cache summary (for Data Manager) ────────────────────────────────────
    if (path === "/api/cache-summary" && req.method === "GET") {
      const summary = getCacheSummary();
      return json(res, 200, summary);
    }

    // ── No-data signals follow-up (for Data Manager > No Data tab) ──────────
    // Returns all signals with outcome='no_data', grouped by instrument.
    // For each instrument, checks if market data exists in the per-asset DBs.
    if (path === "/api/no-data-signals" && req.method === "GET") {
      try {
        // Get all no_data signals with their postedAt + channel info
        const signals = sqlite.prepare(`
          SELECT s.id, s.instrument, s.channelId, m.postedAt,
                 c.name as channelName
          FROM Signal s
          JOIN Message m ON s.messageId = m.id
          JOIN catalog.Channel c ON s.channelId = c.id
          JOIN Evaluation e ON e.signalId = s.id
          WHERE e.outcome = 'no_data'
          ORDER BY m.postedAt DESC
        `).all() as Array<{
          id: string; instrument: string; channelId: string;
          postedAt: string; channelName: string;
        }>;

        // Group by instrument
        const byInstrument = new Map<string, {
          instrument: string;
          count: number;
          channels: Set<string>;
          earliestSignal: string | null;
          latestSignal: string | null;
          signalIds: string[];
        }>();

        for (const s of signals) {
          if (!byInstrument.has(s.instrument)) {
            byInstrument.set(s.instrument, {
              instrument: s.instrument,
              count: 0,
              channels: new Set(),
              earliestSignal: null,
              latestSignal: null,
              signalIds: [],
            });
          }
          const g = byInstrument.get(s.instrument)!;
          g.count++;
          g.channels.add(s.channelName);
          g.signalIds.push(s.id);
          if (!g.earliestSignal || s.postedAt < g.earliestSignal) g.earliestSignal = s.postedAt;
          if (!g.latestSignal || s.postedAt > g.latestSignal) g.latestSignal = s.postedAt;
        }

        // For each instrument, check market data availability
        const { listMarketDbs, getMarketDbSync } = await import("@/lib/market-db");
        const marketDbs = listMarketDbs();
        const instruments = Array.from(byInstrument.values()).map((g) => {
          // Check if any market DB exists for this instrument
          const matchingDbs = marketDbs.filter(d => d.instrument === g.instrument.toLowerCase());
          let marketDataStatus: "available" | "partial" | "missing" = "missing";
          let marketDataRange: { earliest: number; latest: number } | null = null;
          let marketDataTimeframes: string[] = [];

          if (matchingDbs.length > 0) {
            // Get the overall range across all timeframes for this instrument
            let overallMin = Infinity;
            let overallMax = 0;
            for (const db of matchingDbs) {
              marketDataTimeframes.push(db.timeframe);
              try {
                const conn = getMarketDbSync(db.instrument, db.timeframe);
                const range = conn.prepare("SELECT MIN(timestamp) as e, MAX(timestamp) as l FROM PriceBar").get() as { e: number; l: number };
                if (range.e && range.e < overallMin) overallMin = range.e;
                if (range.l && range.l > overallMax) overallMax = range.l;
              } catch { /* skip */ }
            }
            if (overallMin !== Infinity) {
              marketDataRange = { earliest: overallMin, latest: overallMax };
              // Check if the data covers the signal's evaluation window
              const signalStart = new Date(g.earliestSignal!).getTime();
              const signalEnd = new Date(g.latestSignal!).getTime() + 48 * 3600000;
              if (overallMin <= signalStart && overallMax >= signalEnd) {
                marketDataStatus = "available";
              } else {
                marketDataStatus = "partial";
              }
            }
          }

          return {
            instrument: g.instrument,
            count: g.count,
            channels: Array.from(g.channels),
            earliestSignal: g.earliestSignal,
            latestSignal: g.latestSignal,
            signalIds: g.signalIds,
            marketDataStatus,
            marketDataRange: marketDataRange ? {
              earliest: new Date(marketDataRange.earliest).toISOString(),
              latest: new Date(marketDataRange.latest).toISOString(),
            } : null,
            marketDataTimeframes,
          };
        });

        // Sort by count descending (most no_data signals first)
        instruments.sort((a, b) => b.count - a.count);

        return json(res, 200, {
          total: signals.length,
          affectedInstruments: instruments.length,
          affectedChannels: new Set(signals.map(s => s.channelName)).size,
          instruments,
        });
      } catch (e) {
        return json(res, 500, { error: e instanceof Error ? e.message : String(e) });
      }
    }

    // ── Browse price bars (paginated, filtered) ─────────────────────────────
    // Query params: instrument, source, timeframe, from (ISO date), to (ISO date),
    //               page (1-based), pageSize (max 500)
    //
    // With per-asset DBs, when instrument+timeframe are specified we query that
    // specific DB. When they're not specified, we aggregate across all DBs.
    if (path === "/api/browse-bars" && req.method === "GET") {
      const instrument = url.searchParams.get("instrument") || undefined;
      const source = url.searchParams.get("source") || undefined;
      const timeframe = url.searchParams.get("timeframe") || undefined;
      const fromIso = url.searchParams.get("from");
      const toIso = url.searchParams.get("to");
      const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
      const pageSize = Math.min(500, Math.max(10, parseInt(url.searchParams.get("pageSize") || "50", 10)));

      const fromMs = fromIso ? new Date(fromIso).getTime() : undefined;
      const toMs = toIso ? new Date(toIso).getTime() : undefined;

      // Build the WHERE clause for use within a single per-asset DB.
      // (instrument and timeframe are implicit — they're the DB's identity.)
      const conditions: string[] = [];
      const params: unknown[] = [];
      if (source) { conditions.push("source = ?"); params.push(source.toLowerCase()); }
      if (fromMs) { conditions.push("timestamp >= ?"); params.push(fromMs); }
      if (toMs) { conditions.push("timestamp < ?"); params.push(toMs); }
      const whereClause = conditions.length > 0 ? "WHERE " + conditions.join(" AND ") : "";
      const offset = (page - 1) * pageSize;

      // Determine which DBs to query
      const allDbs = listMarketDbs();
      const targetDbs = allDbs.filter(d =>
        (!instrument || d.instrument === instrument.toLowerCase()) &&
        (!timeframe || d.timeframe === timeframe.toLowerCase())
      );

      // Aggregate count + rows across target DBs
      let totalCount = 0;
      const allRows: Array<{
        source: string; instrument: string; timeframe: string;
        timestamp: number; open: number; high: number; low: number;
        close: number; volume: number; fetchedAt: string;
      }> = [];

      const allInstruments = new Set<string>();
      const allSources = new Set<string>();
      const allTimeframes = new Set<string>();

      for (const { instrument: inst, timeframe: tf } of targetDbs) {
        try {
          const db = getMarketDbSync(inst, tf);

          // Collect distinct values for filter dropdowns
          const instRows = db.prepare("SELECT DISTINCT instrument FROM PriceBar").all() as Array<{ instrument: string }>;
          instRows.forEach(r => allInstruments.add(r.instrument));
          const srcRows = db.prepare("SELECT DISTINCT source FROM PriceBar").all() as Array<{ source: string }>;
          srcRows.forEach(r => allSources.add(r.source));
          const tfRows = db.prepare("SELECT DISTINCT timeframe FROM PriceBar").all() as Array<{ timeframe: string }>;
          tfRows.forEach(r => allTimeframes.add(r.timeframe));

          // Count
          const countRow = db.prepare(`SELECT COUNT(*) as c FROM PriceBar ${whereClause}`).get(...params) as { c: number };
          totalCount += countRow.c;

          // Rows (we fetch from each DB, then sort+paginate across all)
          const rows = db.prepare(
            `SELECT source, instrument, timeframe, timestamp, open, high, low, close, volume, fetchedAt
             FROM PriceBar ${whereClause}
             ORDER BY timestamp DESC
             LIMIT ? OFFSET ?`
          ).all(...params, pageSize, offset) as Array<{
            source: string; instrument: string; timeframe: string;
            timestamp: number; open: number; high: number; low: number;
            close: number; volume: number; fetchedAt: string;
          }>;
          allRows.push(...rows);
        } catch (e) {
          console.warn(`[browse-bars] failed to read ${inst}_${tf}: ${e}`);
        }
      }

      // Sort all rows by timestamp DESC (merge across DBs) and paginate
      allRows.sort((a, b) => b.timestamp - a.timestamp);
      const paginatedRows = allRows.slice(0, pageSize);

      return json(res, 200, {
        bars: paginatedRows,
        total: totalCount,
        page,
        pageSize,
        totalPages: Math.ceil(totalCount / pageSize),
        filters: {
          instruments: Array.from(allInstruments).sort(),
          sources: Array.from(allSources).sort(),
          timeframes: Array.from(allTimeframes).sort(),
        },
      });
    }

    // ── Export bars (PriceBar cache) ────────────────────────────────────────
    if (path === "/api/export-bars" && req.method === "GET") {
      const format = url.searchParams.get("format") || "csv";
      const instrument = url.searchParams.get("instrument") || undefined;
      const source = url.searchParams.get("source") || undefined;

      // Determine which DBs to query
      const allDbs = listMarketDbs();
      const targetDbs = allDbs.filter(d =>
        (!instrument || d.instrument === instrument.toLowerCase())
      );

      const allRows: Array<{
        source: string; instrument: string; timeframe: string;
        timestamp: number; open: number; high: number; low: number; close: number; volume: number;
      }> = [];

      for (const { instrument: inst, timeframe: tf } of targetDbs) {
        try {
          const db = getMarketDbSync(inst, tf);
          let query = "SELECT source, instrument, timeframe, timestamp, open, high, low, close, volume FROM PriceBar";
          const conditions: string[] = [];
          const params: Record<string, unknown> = {};
          if (source) { conditions.push("source = $source"); params.$source = source; }
          if (conditions.length > 0) query += " WHERE " + conditions.join(" AND ");
          query += " ORDER BY timestamp ASC LIMIT 10000";

          const rows = db.prepare(query).all(params) as Array<{
            source: string; instrument: string; timeframe: string;
            timestamp: number; open: number; high: number; low: number; close: number; volume: number;
          }>;
          allRows.push(...rows);
        } catch (e) {
          console.warn(`[export-bars] failed to read ${inst}_${tf}: ${e}`);
        }
      }

      // Sort all rows by timestamp ASC
      allRows.sort((a, b) => a.timestamp - b.timestamp);
      const rows = allRows.slice(0, 10000);

      if (format === "json") {
        const body = JSON.stringify({ count: rows.length, bars: rows }, null, 2);
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Content-Disposition": `attachment; filename="bars-${Date.now()}.json"`,
        });
        res.end(body);
        return;
      }

      // CSV
      const headers = ["source", "instrument", "timeframe", "timestamp", "datetime", "open", "high", "low", "close", "volume"];
      const csv = [
        headers.join(","),
        ...rows.map((r) => [
          r.source, r.instrument, r.timeframe, r.timestamp,
          new Date(r.timestamp).toISOString(),
          r.open, r.high, r.low, r.close, r.volume,
        ].join(",")),
      ].join("\n");

      res.writeHead(200, {
        "Content-Type": "text/csv",
        "Content-Disposition": `attachment; filename="bars-${Date.now()}.csv"`,
      });
      res.end(csv);
      return;
    }

    // ── Ingestion control: pause / resume / stop / status ────────────────────
    if (path === "/api/ingest/status" && req.method === "GET") {
      return json(res, 200, getIngestionStatus() as IngestionStatus);
    }
    if (path === "/api/ingest/pause" && req.method === "POST") {
      pauseJob();
      io.emit("ingest:progress", {
        jobId: getIngestionStatus().jobId,
        phase: "fetching",
        paused: true,
        message: "Ingestion paused. Click Resume to continue.",
      });
      return json(res, 200, getIngestionStatus() as IngestionStatus);
    }
    if (path === "/api/ingest/resume" && req.method === "POST") {
      resumeJob();
      io.emit("ingest:progress", {
        jobId: getIngestionStatus().jobId,
        phase: "fetching",
        paused: false,
        message: "Ingestion resumed.",
      });
      return json(res, 200, getIngestionStatus() as IngestionStatus);
    }
    if (path === "/api/ingest/stop" && req.method === "POST") {
      stopJob();
      return json(res, 200, { ...getIngestionStatus(), message: "Stop signal sent. Ingestion will halt at the next batch boundary." } as IngestionStatus);
    }
    if (path === "/api/ingest/clear-resume" && req.method === "POST") {
      const channelId = String(body.channelId ?? "");
      if (channelId) clearResumePosition(channelId);
      return json(res, 200, { ok: true, message: "Resume position cleared." });
    }

    // ── Health ──────────────────────────────────────────────────────────────
    if (path === "/health" && req.method === "GET") {
      return json(res, 200, { ok: true, service: "telegram-collector", port: PORT });
    }

    return json(res, 404, { error: "Not found", path });
  } catch (e) {
    console.error("Route error:", e);
    return json(res, 500, {
      error: e instanceof Error ? e.message : String(e),
    });
  }
});

// ── Socket.IO (default path /socket.io/ so HTTP API routes coexist) ────────
// Caddy routes by the XTransformPort query param, so /socket.io/?XTransformPort=3001
// and /api/*?XTransformPort=3001 both reach this service.
const io = new IOServer(httpServer, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  pingTimeout: 60000,
  pingInterval: 25000,
});

io.on("connection", (socket) => {
  console.log(`[io] client connected: ${socket.id}`);
  socket.on("disconnect", () => console.log(`[io] client disconnected: ${socket.id}`));
});

// ── Ingestion worker ────────────────────────────────────────────────────────

async function ingestAsync(
  jobId: string,
  query: string,
  limit: number,
  io: IOServer
) {
  console.log(`[${jobId}] Resolving channel: ${query}`);
  io.emit("ingest:progress", { jobId, phase: "resolve", message: `Resolving "${query}"…` });

  const resolved = await tg.resolveChannel(query);
  if (!resolved) {
    io.emit("ingest:error", { jobId, phase: "error", message: `Channel "${query}" not found` });
    return;
  }

  io.emit("ingest:progress", {
    jobId,
    phase: "resolved",
    message: `Found: ${resolved.title} (${resolved.type}, ${resolved.participantCount} members)`,
    channel: resolved,
  });

  // Upsert channel into DB
  const telegramId = resolved.username ? `@${resolved.username}` : `id:${resolved.id}`;
  const category = inferCategory(resolved.title);
  const channelRecord = upsertChannel({
    telegramId,
    name: resolved.title,
    type: resolved.type,
    category,
    description: resolved.about || `${resolved.title} — no channel description set`,
    subscriberCount: resolved.participantCount,
    verified: resolved.verified,
  });

  // ── Smart resume: skip already-stored messages ────────────────────────────
  // When re-ingesting "all history" (limit=0) after a stop, we don't want to
  // re-fetch messages that are already in the DB. Telegram's GetHistory walks
  // from newest → oldest. By setting offsetId to the oldest stored message ID,
  // we tell Telegram "start from here, go older" — skipping all stored messages.
  //
  // Priority for resume offsetId:
  //   1. Saved IngestState resume position (from a stopped ingestion)
  //   2. Oldest stored message ID (skip already-ingested messages)
  //   3. 0 (start from newest — first ingestion)
  let resumeOffsetId: number | undefined;
  const resumePos = getResumePosition(channelRecord.id);
  const storedCount = countStoredMessages(channelRecord.id);

  if (resumePos?.offsetId && resumePos.offsetId > 0) {
    // Case 1: Resume from saved position (stopped ingestion)
    resumeOffsetId = resumePos.offsetId;
  } else if (limit === 0 && storedCount > 0) {
    // Case 2: Re-ingesting "all history" but already have messages —
    // skip them by starting from the oldest stored message
    const oldestId = getOldestStoredMessageId(channelRecord.id);
    if (oldestId && oldestId > 0) {
      resumeOffsetId = oldestId;
    }
  }
  // Case 3: First ingestion or limit > 0 — resumeOffsetId stays undefined

  // Clear stale resume position if we're using smart-skip instead
  if (resumeOffsetId && !resumePos?.offsetId) {
    clearResumePosition(channelRecord.id);
  }

  // Start tracking the job for pause/stop/resume
  startJob(jobId, channelRecord.id, channelRecord.name);

  const limitLabel = limit === 0 ? "all" : String(limit);
  io.emit("ingest:progress", {
    jobId,
    phase: "fetching",
    message: resumeOffsetId
      ? storedCount > 0 && !resumePos?.offsetId
        ? `Smart resume: skipping ${storedCount} already-stored messages, fetching older history from #${resumeOffsetId}…`
        : `Resuming from message #${resumeOffsetId}… Fetching ${limitLabel} messages.`
      : `Fetching ${limitLabel} messages from channel history…`,
    channelId: channelRecord.id,
  });

  let inserted = 0;
  let signalsParsed = 0;
  let fetched = 0;
  let lastOffsetId = resumeOffsetId ?? 0;

  for await (const msg of tg.iterHistory(resolved.id, limit, (f) => {
    fetched = f;
    if (f % 100 === 0) {
      updateProgress(fetched, inserted, signalsParsed, lastOffsetId);
      io.emit("ingest:progress", {
        jobId,
        phase: "fetching",
        fetched,
        limit,
        message: limit === 0
          ? `Fetched ${fetched} messages… (scanning full history)`
          : `Fetched ${fetched}/${limit} messages…`,
      });
    }
  }, resumeOffsetId)) {
    // Insert message
    const parsed = parseSignal(msg.raw ?? msg.message ?? "");
    const parseStatus = parsed ? "parsed" : msg.message ? "no_signal" : "no_text";
    const messageId = insertMessage({
      channelId: channelRecord.id,
      telegramMessageId: msg.id,
      rawText: msg.message ?? "",
      rawJson: msg.raw,
      senderId: msg.senderId,
      senderName: msg.senderName,
      hasMedia: msg.hasMedia,
      mediaType: msg.mediaType,
      views: msg.views,
      forwards: msg.forwards,
      reactions: msg.reactions,
      postedAt: msg.date,
      parseStatus,
    });

    if (parsed) {
      const signalId = insertSignal({
        messageId,
        channelId: channelRecord.id,
        instrument: parsed.instrument,
        instrumentType: parsed.instrumentType,
        action: parsed.action,
        entryPrice: parsed.entryPrice,
        entryLow: parsed.entryLow,
        entryHigh: parsed.entryHigh,
        isRange: parsed.isRange,
        stopLoss: parsed.stopLoss,
        takeProfits: JSON.stringify(parsed.takeProfits),
        positionSize: parsed.positionSize,
        leverage: parsed.leverage,
        timeframe: parsed.timeframe,
        confidence: parsed.confidence,
        notes: parsed.notes,
        postedAt: msg.date,
      });
      if (signalId) {
        signalsParsed++;
      }
      // If signalId is null, it was a duplicate (dedupHash conflict) — silently skipped
    }

    inserted++;
    lastOffsetId = msg.id;
    if (inserted % 25 === 0) {
      updateProgress(fetched, inserted, signalsParsed, lastOffsetId);
      io.emit("ingest:progress", {
        jobId,
        phase: "ingesting",
        fetched: inserted,
        limit,
        signals: signalsParsed,
        message: `Ingested ${inserted} messages · ${signalsParsed} signals detected`,
      });
    }
  }

  // Check if ingestion was stopped (not completed naturally)
  const status = getIngestionStatus();
  const wasStopped = status.state === "stopped";

  // Persist final position
  updateProgress(fetched, inserted, signalsParsed, lastOffsetId);

  finishJob();

  const stats = getChannelStats(channelRecord.id);
  io.emit("ingest:complete", {
    jobId,
    phase: "complete",
    channelId: channelRecord.id,
    channelName: channelRecord.name,
    inserted,
    signalsParsed,
    totalMessages: stats.messages,
    totalSignals: stats.signals,
    stopped: wasStopped,
    canResume: wasStopped,
    message: wasStopped
      ? `Ingestion stopped. Ingested ${inserted} messages, detected ${signalsParsed} signals. Position saved — you can resume later.`
      : `Done. Ingested ${inserted} messages, detected ${signalsParsed} signals.`,
  });
  console.log(`[${jobId}] ${wasStopped ? "Stopped" : "Complete"}: ${inserted} messages, ${signalsParsed} signals`);
}

function inferCategory(title: string): string {
  const t = title.toLowerCase();
  if (/fx|forex|pip|currency|eur|usd|jpy|gbp/.test(t)) return "forex";
  if (/crypto|btc|alt|defi|token|coin|blockchain/.test(t)) return "crypto";
  if (/stock|equit|share|nyse|nasdaq|earnings/.test(t)) return "stocks";
  if (/gold|xau|silver|oil|commodit|metal/.test(t)) return "commodities";
  if (/index|spx|nas|dow|dax/.test(t)) return "index";
  return "mixed";
}

// ── helpers ────────────────────────────────────────────────────────────────

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolveFn) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      if (!data) return resolveFn({});
      try {
        resolveFn(JSON.parse(data) as Record<string, unknown>);
      } catch {
        resolveFn({});
      }
    });
  });
}

function json(res: ServerResponse, code: number, body: unknown) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

// ── Streaming CSV import (handles large files without OOM) ──────────────────
//
// Receives multipart/form-data with:
//   - instrument (text field)
//   - source (text field, default "dukascopy")
//   - timeframe (text field, default "m1")
//   - file (the CSV file)
//
// Streams the file through a line-by-line parser, batch-inserting bars
// every 5,000 rows. Memory usage stays flat regardless of file size.
// Progress is emitted via Socket.IO so the frontend can show a progress bar.
//
// Multipart parsing: we use a simple boundary-based parser. The form fields
// (instrument, source, timeframe) come first as small text parts, then the
// file part. We buffer the text parts fully (they're tiny), and stream the
// file part through the CSV parser.

const STREAM_BATCH_SIZE = 5000;

async function handleStreamingCsvImport(
  req: IncomingMessage,
  res: ServerResponse,
  io: IOServer
): Promise<void> {
  const contentType = req.headers["content-type"] ?? "";

  // Parse the multipart boundary from the Content-Type header
  const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!boundaryMatch) {
    return json(res, 400, { error: "Content-Type must be multipart/form-data with a boundary" });
  }
  const boundary = boundaryMatch[1] ?? boundaryMatch[2];

  // Extract form fields from the URL query string as a fallback.
  // The frontend sends instrument/source/timeframe as query params so we
  // don't need to parse them from the multipart body (simpler + faster).
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const instrument = (url.searchParams.get("instrument") ?? "").trim().toLowerCase();
  const source = (url.searchParams.get("source") ?? "dukascopy").toLowerCase();
  const timeframe = (url.searchParams.get("timeframe") ?? "m1").toLowerCase();

  if (!instrument) {
    return json(res, 400, { error: "instrument query parameter is required" });
  }

  console.log(`[import-csv-stream] Starting: instrument=${instrument}, source=${source}, timeframe=${timeframe}, boundary=${boundary.slice(0, 20)}…`);

  // Send 202 Accepted immediately — the actual processing happens in the
  // background. Progress + final result are sent via Socket.IO.
  // This avoids HTTP timeouts for large files (400MB+ takes 5-15 minutes).
  json(res, 202, {
    jobId: `import-${Date.now()}`,
    message: "Streaming import started. Progress will be reported via Socket.IO.",
    instrument,
    source,
    timeframe,
  });

  // Set up the streaming CSV parser + batch inserter
  const jobId = `import-${Date.now()}`;
  let totalInserted = 0;
  let totalSkipped = 0;
  let totalParsed = 0;
  let batch: Bar[] = [];
  let firstBarTs: number | null = null;
  let lastBarTs: number | null = null;
  let sourceTimeframe = "m1";
  let timeframeDetected = false;
  let firstBarsForDetection: Bar[] = []; // collect first N bars to detect timeframe

  const flushBatch = () => {
    if (batch.length === 0) return;
    const { inserted, skipped } = importBars(source, instrument, timeframe, batch);
    totalInserted += inserted;
    totalSkipped += skipped;
    batch = [];
  };

  const parser = new StreamingCsvParser({
    onBar: (bar) => {
      totalParsed++;
      if (firstBarTs === null) firstBarTs = bar.timestamp;
      lastBarTs = bar.timestamp;

      // Detect timeframe from first 100 bars
      if (!timeframeDetected) {
        firstBarsForDetection.push(bar);
        if (firstBarsForDetection.length >= 100) {
          const detected = detectTimeframe(firstBarsForDetection);
          if (detected) sourceTimeframe = detected;
          timeframeDetected = true;
          firstBarsForDetection = []; // free memory
        }
      }

      // For M1 target, no aggregation needed — add directly to batch.
      // For other target timeframes with M1 source, we'd need to aggregate.
      // For simplicity, the streaming endpoint assumes target === source
      // (the common case: importing M1 CSV as M1 data). The non-streaming
      // /api/import-csv endpoint handles aggregation for other cases.
      batch.push(bar);

      if (batch.length >= STREAM_BATCH_SIZE) {
        flushBatch();
      }
    },
  });

  // Track progress (emit every 50K bars)
  let lastProgressEmit = 0;
  const emitProgress = (force = false) => {
    const now = Date.now();
    if (!force && now - lastProgressEmit < 1000) return; // throttle to 1/sec
    lastProgressEmit = now;
    io.emit("import:progress", {
      jobId,
      phase: "importing" as const,
      message: `Importing ${instrument.toUpperCase()}: ${totalParsed.toLocaleString()} bars parsed, ${totalInserted.toLocaleString()} inserted`,
      parsed: totalParsed,
      inserted: totalInserted,
      skipped: totalSkipped,
      instrument,
      timeframe,
    });
  };

  // ── Stream the request body through the multipart parser ────────────────
  // We're looking for the file part. Multipart format:
  //   --BOUNDARY\r\n
  //   Content-Disposition: form-data; name="file"; filename="x.csv"\r\n
  //   Content-Type: text/csv\r\n
  //   \r\n
  //   <file content>\r\n
  //   --BOUNDARY--\r\n
  //
  // Strategy: find the file part's headers, then stream the file content
  // through the CSV parser until we hit the closing boundary.

  const boundaryBuf = Buffer.from(`\r\n--${boundary}`);
  const fileHeaderMarker = Buffer.from('filename=');

  // State machine for finding the file part
  let inFileContent = false;
  let searchBuf = Buffer.alloc(0);
  let fileBytesReceived = 0;

  try {
    for await (const chunk of req) {
      if (!inFileContent) {
        // Still looking for the file part — accumulate and search for headers
        searchBuf = Buffer.concat([searchBuf, chunk]);

        // Look for "filename=" to find the file part
        const headerIdx = searchBuf.indexOf(fileHeaderMarker);
        if (headerIdx === -1) continue;

        // Found the file part header — find the end of headers (\r\n\r\n)
        const headersEnd = searchBuf.indexOf("\r\n\r\n", headerIdx);
        if (headersEnd === -1) continue;

        // Everything after \r\n\r\n is file content
        const fileStart = headersEnd + 4;
        const fileContent = searchBuf.slice(fileStart);
        searchBuf = Buffer.alloc(0); // free the search buffer
        inFileContent = true;

        // Feed the initial file content to the parser
        if (fileContent.length > 0) {
          parser.feed(fileContent.toString("utf-8"));
          fileBytesReceived += fileContent.length;
        }
      } else {
        // We're in file content — but need to detect the closing boundary.
        // The boundary is preceded by \r\n, so we check if the current
        // chunk (combined with any leftover from the previous chunk) contains it.
        const combined = Buffer.concat([searchBuf, chunk]);
        const boundaryIdx = combined.indexOf(boundaryBuf);

        if (boundaryIdx !== -1) {
          // Found the closing boundary — feed everything before it, then stop
          const fileContent = combined.slice(0, boundaryIdx);
          if (fileContent.length > 0) {
            parser.feed(fileContent.toString("utf-8"));
            fileBytesReceived += fileContent.length;
          }
          parser.end();
          flushBatch();
          break;
        } else {
          // No boundary found — feed everything except the last boundary.length
          // bytes (which might be a partial boundary split across chunks)
          const safeLength = Math.max(0, combined.length - boundaryBuf.length);
          if (safeLength > 0) {
            const fileContent = combined.slice(0, safeLength);
            parser.feed(fileContent.toString("utf-8"));
            fileBytesReceived += fileContent.length;
          }
          // Keep the last boundaryBuf.length bytes for the next iteration
          searchBuf = combined.slice(safeLength);
        }
      }

      // Emit progress periodically
      emitProgress();
    }

    // If the stream ended without hitting the closing boundary (e.g. client
    // closed the connection), flush whatever we have
    if (inFileContent) {
      parser.end();
      flushBatch();
    }

    // Final progress emit with complete results
    io.emit("import:progress", {
      jobId,
      phase: "complete" as const,
      message: `Import complete: ${totalInserted.toLocaleString()} bars inserted, ${totalSkipped.toLocaleString()} skipped`,
      parsed: totalParsed,
      inserted: totalInserted,
      skipped: totalSkipped,
      instrument,
      timeframe,
      sourceTimeframe,
      dateRange: {
        from: firstBarTs !== null ? new Date(firstBarTs).toISOString() : null,
        to: lastBarTs !== null ? new Date(lastBarTs).toISOString() : null,
      },
    });

    console.log(`[import-csv-stream] Complete: ${totalInserted} inserted, ${totalSkipped} skipped, ${totalParsed} parsed, ${fileBytesReceived} file bytes`);

    // Response already sent (202 Accepted) — nothing to return here.
    // The frontend picks up the result from the Socket.IO 'complete' event.
  } catch (e) {
    console.error(`[import-csv-stream] Error:`, e);
    // Emit error via Socket.IO (HTTP response already sent)
    io.emit("import:progress", {
      jobId,
      phase: "error" as const,
      message: e instanceof Error ? e.message : String(e),
      parsed: totalParsed,
      inserted: totalInserted,
      skipped: totalSkipped,
      instrument,
      timeframe,
    });
  }
}

httpServer.listen(PORT, () => {
  console.log(`✓ Telegram collector service on http://localhost:${PORT}`);
  console.log(`  API:  /api/status, /api/connect, /api/auth/*, /api/resolve-channel, /api/ingest`);
  console.log(`  WS:   socket.io path "/" (use ?XTransformPort=${PORT} from frontend)`);
});

// ── Timeout configuration for large uploads ─────────────────────────────────
// Default Node.js HTTP timeouts (2 min) are too short for streaming CSV
// imports of large files (400MB+ takes 5-10 minutes to parse + insert).
// Disable the server-side timeouts so long-running requests can complete.
httpServer.timeout = 0;           // no inactivity timeout
httpServer.requestTimeout = 0;    // no overall request timeout
httpServer.keepAliveTimeout = 0;  // keep connections alive indefinitely
httpServer.headersTimeout = 0;    // no header timeout

// Auto-connect on startup if session exists
(async () => {
  try {
    const info = await tg.connect();
    console.log(`  Startup auth state: ${info.state}${info.me ? ` (${info.me.firstName})` : ""}`);
  } catch (e) {
    console.warn("  Startup connect failed:", e);
  }
})();
