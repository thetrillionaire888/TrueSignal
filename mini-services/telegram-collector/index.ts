// Telegram collector mini-service.
// HTTP API + Socket.IO for real-time ingestion progress.
// Runs on port 3001.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Server as IOServer } from "socket.io";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
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

      const { Database } = await import("bun:sqlite");
      const dbPath = resolve(import.meta.dir, "../../db/custom.db");
      const exportDb = new Database(dbPath);
      exportDb.exec("PRAGMA busy_timeout = 5000;");

      let query = "SELECT source, instrument, timeframe, timestamp, open, high, low, close, volume FROM PriceBar";
      const conditions: string[] = [];
      const params: Record<string, unknown> = {};
      if (instrument) { conditions.push("instrument = $instrument"); params.$instrument = instrument; }
      if (source) { conditions.push("source = $source"); params.$source = source; }
      if (conditions.length > 0) query += " WHERE " + conditions.join(" AND ");
      query += " ORDER BY timestamp ASC LIMIT 10000";

      const rows = exportDb.prepare(query).all(params) as Array<{
        source: string; instrument: string; timeframe: string;
        timestamp: number; open: number; high: number; low: number; close: number; volume: number;
      }>;
      exportDb.close();

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

  // Check for resume position
  const resumePos = getResumePosition(channelRecord.id);
  const resumeOffsetId = resumePos?.offsetId;

  // Start tracking the job for pause/stop/resume
  startJob(jobId, channelRecord.id, channelRecord.name);

  const limitLabel = limit === 0 ? "all" : String(limit);
  io.emit("ingest:progress", {
    jobId,
    phase: "fetching",
    message: resumeOffsetId
      ? `Resuming from message #${resumeOffsetId}… Fetching ${limitLabel} messages.`
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
