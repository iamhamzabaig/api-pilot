#!/usr/bin/env node
import { createServer } from "node:http";

/**
 * The service this example talks to. Zero dependencies, one file, deliberately
 * boring — it exists so the example can be *executed*, in CI and by you, rather
 * than being a README nobody has run since it was written.
 *
 * It returns a list big enough that pasting it into a model context is the
 * mistake API Pilot exists to prevent: 400 widgets, ~38 KB of JSON.
 */

const PORT = Number(process.env.WIDGET_PORT ?? 8787);
const TOKEN = process.env.WIDGET_TOKEN ?? "example-token";

const widgets = Array.from({ length: 400 }, (_, i) => ({
  id: `wgt_${String(i + 1).padStart(6, "0")}`,
  name: `Widget ${i + 1}`,
  colour: ["red", "green", "blue"][i % 3],
  createdAt: new Date(Date.UTC(2026, 0, 1 + (i % 28))).toISOString(),
}));

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", `http://127.0.0.1:${PORT}`);

  // The point of the auth check is to prove the token really travelled: the
  // model never sees its value, and the request still authenticates.
  if (request.headers.authorization !== `Bearer ${TOKEN}`) {
    return json(response, 401, {
      error: { code: "unauthorized", message: "Bad or missing token." },
    });
  }

  if (url.pathname === "/widgets" && request.method === "GET") {
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 500);
    return json(response, 200, {
      object: "list",
      has_more: limit < widgets.length,
      data: widgets.slice(0, limit),
    });
  }

  if (url.pathname === "/widgets" && request.method === "POST") {
    return json(response, 201, { ...widgets[0], id: "wgt_000401", name: "Created by the example" });
  }

  if (url.pathname.startsWith("/widgets/") && request.method === "DELETE") {
    response.writeHead(204).end();
    return;
  }

  json(response, 404, { error: { code: "not_found", message: `No route for ${url.pathname}.` } });
});

server.listen(PORT, "127.0.0.1", () => {
  process.stdout.write(`widget store listening on http://127.0.0.1:${PORT}\n`);
});

function json(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}
