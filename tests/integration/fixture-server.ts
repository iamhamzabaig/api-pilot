import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A real HTTP server on loopback. The executor talks to a socket in these tests
 * because the interesting failures — redirect chains, truncated bodies, resets,
 * timeouts — live in the transport, and a mocked fetch would assert nothing.
 *
 * No test in this repo may reach the public internet (NFR N7).
 */

export interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: string;
}

export interface FixtureServer {
  readonly origin: string;
  readonly requests: readonly RecordedRequest[];
  close(): Promise<void>;
}

export async function startFixtureServer(): Promise<FixtureServer> {
  const requests: RecordedRequest[] = [];
  const flakyHits = new Map<string, number>();

  const server = createServer((req, res) => {
    void handle(req, res, requests, flakyHits);
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;

  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    async close() {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    },
  };
}

/** A port that is guaranteed to refuse connections, for the ECONNREFUSED path. */
export async function findClosedPort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  server.close();
  await once(server, "close");
  return port;
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  requests: RecordedRequest[],
  flakyHits: Map<string, number>,
): Promise<void> {
  const body = await readRequestBody(req);
  requests.push({
    method: req.method ?? "GET",
    url: req.url ?? "/",
    headers: req.headers,
    body,
  });

  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const path = url.pathname;

  if (path === "/ok") {
    return json(res, 200, { ok: true, name: "api-pilot" });
  }

  if (path.startsWith("/status/")) {
    const code = Number(path.slice("/status/".length));
    return json(res, Number.isFinite(code) ? code : 500, { status: code });
  }

  if (path === "/slow") {
    const ms = Number(url.searchParams.get("ms") ?? "1000");
    await delay(ms);
    return json(res, 200, { slow: true });
  }

  if (path.startsWith("/redirect/")) {
    const remaining = Number(path.slice("/redirect/".length));
    const next = remaining > 1 ? `/redirect/${remaining - 1}` : "/ok";
    res.writeHead(302, { location: next });
    res.end();
    return;
  }

  if (path === "/redirect-loop") {
    res.writeHead(302, { location: "/redirect-loop" });
    res.end();
    return;
  }

  if (path === "/redirect-to") {
    const target = url.searchParams.get("url") ?? "/ok";
    const status = Number(url.searchParams.get("status") ?? "302");
    res.writeHead(status, { location: target });
    res.end();
    return;
  }

  if (path === "/big") {
    const bytes = Number(url.searchParams.get("bytes") ?? "1024");
    res.writeHead(200, { "content-type": "application/octet-stream" });
    const chunk = Buffer.alloc(64 * 1024, 0x61);
    let written = 0;
    while (written < bytes) {
      const size = Math.min(chunk.byteLength, bytes - written);
      res.write(chunk.subarray(0, size));
      written += size;
    }
    res.end();
    return;
  }

  if (path === "/flaky") {
    const key = url.searchParams.get("key") ?? "default";
    const failures = Number(url.searchParams.get("failures") ?? "1");
    const seen = flakyHits.get(key) ?? 0;
    flakyHits.set(key, seen + 1);
    if (seen < failures) {
      res.writeHead(503, { "content-type": "application/json", "retry-after": "0" });
      res.end(JSON.stringify({ error: "unavailable", attempt: seen + 1 }));
      return;
    }
    return json(res, 200, { recovered: true, attempt: seen + 1 });
  }

  if (path === "/reset") {
    // Kills the socket after the request is recorded, so a test can count the
    // attempts a network-level failure actually produced.
    req.socket.destroy();
    return;
  }

  if (path === "/echo") {
    return json(res, 200, {
      method: req.method,
      authorization: req.headers.authorization ?? null,
      contentType: req.headers["content-type"] ?? null,
      body,
    });
  }

  if (path === "/spec.yaml") {
    res.writeHead(200, { "content-type": "application/yaml" });
    res.end(REMOTE_SPEC);
    return;
  }

  if (path === "/set-cookies") {
    res.writeHead(200, {
      "content-type": "application/json",
      "set-cookie": ["a=1; Path=/", "b=2; Path=/"],
    });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  return json(res, 404, { error: "no such fixture route", path });
}

/**
 * Served from `/spec.yaml`, so the URL-loading path is exercised over a real
 * socket without any test reaching the public internet (NFR N7).
 */
const REMOTE_SPEC = `openapi: 3.0.3
info:
  title: Remote Widgets API
  version: "1"
paths:
  /widgets:
    get:
      operationId: listWidgets
      summary: Returns every widget you own.
      responses:
        "200":
          description: A list of widgets.
  /widgets/{id}:
    delete:
      operationId: deleteWidget
      summary: Permanently removes one widget.
      responses:
        "204":
          description: Gone.
`;

function json(res: ServerResponse, status: number, payload: unknown): void {
  const encoded = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(encoded),
  });
  res.end(encoded);
}

async function readRequestBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
