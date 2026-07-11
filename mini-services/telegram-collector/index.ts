// Telegram collector mini-service.
// HTTP API + Socket.IO for real-time ingestion progress.
// Runs on port 3001.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Server as IOServer } from "socket.io";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { sqlite } from "@/lib/db";
import * as tg from "./telegram";
import { parseSignal } from "./parser";
import { evaluateSignals, getEvalStats, type EvalProgress } from "./evaluator";
import { importFromSource } from "./importers";
import { getCacheSummary } from "./bar-cache";
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
      // Run evaluation asynchronously, stream progress via socket.io
      const jobId = `eval-${Date.now()}`;
      evaluateSignals(channelId, (p: EvalProgress) => {
        io.emit("evaluate:progress", p);
      }).catch((e) => {
        console.error("Evaluation error:", e);
        io.emit("evaluate:progress", {
          jobId,
          phase: "error",
          message: e instanceof Error ? e.message : String(e),
        } as EvalProgress);
      });
      return json(res, 200, { jobId, message: "Evaluation started", channelId });
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

        // Fetch bars with retry (48h window from signal post time)
        const signalTime = parseDbDate(signal.postedAt);
        const { bars, stats } = await fetchBars(dukascopyInstrument, signalTime, 48);

        // Delete old evaluation
        sqlite.prepare("DELETE FROM Evaluation WHERE signalId = ?").run(signalId);

        // Re-evaluate
        const result = evaluateSignal(signal, bars);
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

    // ── Export bars (PriceBar cache) ────────────────────────────────────────
    if (path === "/api/export-bars" && req.method === "GET") {
      const format = url.searchParams.get("format") || "csv";
      const instrument = url.searchParams.get("instrument") || undefined;
      const source = url.searchParams.get("source") || undefined;

      // Use the shared `sqlite` connection (audit.db with market.db ATTACH'd).
      // market.PriceBar is the attached table alias.
      let query = "SELECT source, instrument, timeframe, timestamp, open, high, low, close, volume FROM market.PriceBar";
      const conditions: string[] = [];
      const params: Record<string, unknown> = {};
      if (instrument) { conditions.push("instrument = $instrument"); params.$instrument = instrument; }
      if (source) { conditions.push("source = $source"); params.$source = source; }
      if (conditions.length > 0) query += " WHERE " + conditions.join(" AND ");
      query += " ORDER BY timestamp ASC LIMIT 10000";

      const rows = sqlite.prepare(query).all(params) as Array<{
        source: string; instrument: string; timeframe: string;
        timestamp: number; open: number; high: number; low: number; close: number; volume: number;
      }>;

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

httpServer.listen(PORT, () => {
  console.log(`✓ Telegram collector service on http://localhost:${PORT}`);
  console.log(`  API:  /api/status, /api/connect, /api/auth/*, /api/resolve-channel, /api/ingest`);
  console.log(`  WS:   socket.io path "/" (use ?XTransformPort=${PORT} from frontend)`);
});

// Auto-connect on startup if session exists
(async () => {
  try {
    const info = await tg.connect();
    console.log(`  Startup auth state: ${info.state}${info.me ? ` (${info.me.firstName})` : ""}`);
  } catch (e) {
    console.warn("  Startup connect failed:", e);
  }
})();
