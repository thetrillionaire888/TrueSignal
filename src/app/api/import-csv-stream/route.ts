import { NextRequest, NextResponse } from "next/server";
import { request as httpRequest } from "node:http";
import type { IncomingMessage } from "node:http";

// Streaming proxy for /api/import-csv-stream → collector:3001
//
// Next.js rewrites buffer the entire request body, which defeats streaming
// and causes OOM on large (400MB+) CSV uploads. This route handler pipes
// the incoming request stream directly to the collector service on port
// 3001, preserving the streaming behavior end-to-end.
//
// The collector handles the actual multipart parsing + CSV import.

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Allow large uploads (no body size limit) + long duration (5 minutes)
export const maxDuration = 300;

const COLLECTOR_HOST = "localhost";
const COLLECTOR_PORT = 3001;
const COLLECTOR_PATH = "/api/import-csv-stream";

export async function POST(req: NextRequest) {
  // Forward query params (instrument, source, timeframe)
  const searchParams = req.nextUrl.searchParams;
  const params = new URLSearchParams();
  for (const [key, value] of searchParams) {
    if (key !== "XTransformPort") {
      params.set(key, value);
    }
  }

  const targetPath = `${COLLECTOR_PATH}?${params}`;
  const contentType = req.headers.get("content-type") ?? "";

  return new Promise<NextResponse>((resolve) => {
    const proxyReq = httpRequest({
      hostname: COLLECTOR_HOST,
      port: COLLECTOR_PORT,
      path: targetPath,
      method: "POST",
      headers: {
        "Content-Type": contentType,
        // Don't set Content-Length — we're streaming, let the proxy use
        // chunked transfer encoding
      },
    }, (proxyRes: IncomingMessage) => {
      // Read the full response from the collector and forward it
      const chunks: Buffer[] = [];
      proxyRes.on("data", (chunk) => chunks.push(chunk));
      proxyRes.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf-8");
        resolve(new NextResponse(body, {
          status: proxyRes.statusCode ?? 200,
          headers: {
            "Content-Type": proxyRes.headers["content-type"] ?? "application/json",
          },
        }));
      });
      proxyRes.on("error", (err) => {
        resolve(NextResponse.json(
          { error: `Proxy response error: ${err.message}` },
          { status: 502 }
        ));
      });
    });

    proxyReq.on("error", (err) => {
      resolve(NextResponse.json(
        { error: `Failed to connect to collector: ${err.message}` },
        { status: 502 }
      ));
    });

    // Pipe the incoming request body directly to the collector
    // This is the key: req.body is a ReadableStream, we convert it to
    // a Node.js readable and pipe it — true streaming, no buffering.
    const reader = req.body?.getReader();
    if (!reader) {
      proxyReq.end();
      return;
    }

    const pump = () => {
      reader.read().then(({ done, value }) => {
        if (done) {
          proxyReq.end();
        } else {
          proxyReq.write(value);
          pump();
        }
      }).catch((err) => {
        proxyReq.destroy(err);
      });
    };
    pump();
  });
}

