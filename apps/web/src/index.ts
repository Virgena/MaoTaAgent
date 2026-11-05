import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { CallError, runPlugin, type Channel, type Definition, type Route } from "@maota/plugin-kit";

import { createBridge, type Bridge } from "./bridge.ts";
import type { AppInfo, HostCatalog } from "./protocol.ts";

const UI = fileURLToPath(new URL("../ui/", import.meta.url));
const DIST = fileURLToPath(new URL("../dist/", import.meta.url));
const VITE_CONFIG = fileURLToPath(new URL("../vite.config.ts", import.meta.url));

/// The web app's own build number, for the about panel: it says which app this
/// is, not which capability it implements.
const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: unknown };
const VERSION = typeof manifest.version === "string" ? manifest.version : "";
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

type Middleware = (request: IncomingMessage, response: ServerResponse, next: (error?: unknown) => void) => void;

interface Settings {
  port: number;
  host: string;
  dev: boolean;
  open: boolean;
}


function settingsFrom(config: Record<string, unknown>, env: string | undefined): Settings {
  const port = Number(config.port);
  return {
    port: Number.isInteger(port) && port >= 0 && port <= 65535 ? port : 8341,
    host: typeof config.host === "string" && config.host.trim() !== "" ? config.host : "127.0.0.1",
    dev: typeof config.dev === "boolean" ? config.dev : env !== "production",
    open: typeof config.open === "boolean" ? config.open : false,
  };
}

let settings = settingsFrom({}, process.env.NODE_ENV);
let bridge!: Bridge;
let server!: Server;
let dev: { middlewares: Middleware; close(): Promise<void> } | null = null;
let capabilities: Record<string, Route> = {};
let channel: Channel | null = null;

function codeOf(error: unknown): number {
  return error instanceof CallError ? error.code : -32603;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function url(): string {
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : settings.port;
  return `http://${settings.host}:${port}`;
}

/// The words every plugin contributed, asked of the i18n store when there is
/// one. A profile without the store still serves the interface: the app's own
/// copy is compiled in, so the reply is null and nothing is missing that the
/// app did not already have.
async function catalog(): Promise<HostCatalog | null> {
  if (channel === null || capabilities["i18n"] === undefined) return null;
  try {
    const reply = (await channel.call("i18n", "catalog", {})) as Partial<HostCatalog> | null;
    if (reply === null || typeof reply !== "object") return null;
    return {
      locale: typeof reply.locale === "string" ? reply.locale : "",
      languages: Array.isArray(reply.languages) ? reply.languages : [],
      namespaces: Array.isArray(reply.namespaces) ? reply.namespaces : [],
      catalog: reply.catalog ?? {},
      problems: Array.isArray(reply.problems) ? reply.problems : [],
    };
  } catch (error) {
    channel.log("warn", `web: could not read the i18n catalog because ${messageOf(error)}`);
    return null;
  }
}

async function info(): Promise<AppInfo> {
  return {
    version: VERSION,
    url: url(),
    listening: server.listening,
    dev: settings.dev,
    capabilities,
    i18n: await catalog(),
    ...(await bridge.facts()),
  };
}

function openBrowser(target: string, channel: Channel): void {
  const [command, args] =
    process.platform === "win32"
      ? ["cmd", ["/c", "start", "", target]]
      : process.platform === "darwin"
        ? ["open", [target]]
        : ["xdg-open", [target]];
  try {
    const launcher = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
    launcher.on("error", (error: Error) => failure(error.message));
    launcher.unref();
  } catch (error) {
    failure(messageOf(error));
  }

  function failure(reason: string): void {
    channel.log("warn", `web: could not open the default browser because ${reason}; open the URL printed above`);
  }
}

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  if (pathname === "/rpc") return await rpc(request, response);
  if (pathname === "/events") return events(request, response);
  if (dev !== null && (await middleware(dev.middlewares, request, response))) return;
  await sendStatic(response, pathname);
}

async function rpc(request: IncomingMessage, response: ServerResponse): Promise<void> {
  let payload: { method?: unknown; params?: unknown };
  try {
    payload = JSON.parse(await readBody(request)) as { method?: unknown; params?: unknown };
  } catch {
    json(response, { error: { code: -32700, message: "the request is not valid JSON" } });
    return;
  }
  try {
    const method = String(payload.method ?? "");
    const params = (payload.params ?? {}) as Record<string, unknown>;
    const result =
      method === "app.info"
        ? await info()
        : method === "workspace.pick"
          ? { path: null }
          : await bridge.handle(method, params);
    json(response, { result: result ?? null });
  } catch (error) {
    json(response, { error: { code: codeOf(error), message: messageOf(error) } });
  }
}

function events(request: IncomingMessage, response: ServerResponse): void {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  response.write(":connected\n\n");
  const off = bridge.onEvent((event) => response.write(`data: ${JSON.stringify(event)}\n\n`));
  const ping = setInterval(() => response.write(":ping\n\n"), 15_000);
  request.on("close", () => {
    clearInterval(ping);
    off();
  });
}

function middleware(middlewares: Middleware, request: IncomingMessage, response: ServerResponse): Promise<boolean> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (value: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    response.once("finish", () => settle(true));
    middlewares(request, response, (error?: unknown) => {
      if (error) {
        if (!settled) {
          settled = true;
          reject(error);
        }
        return;
      }
      settle(false);
    });
  });
}

async function sendStatic(response: ServerResponse, pathname: string): Promise<void> {
  const rel = decodeURIComponent(pathname).replace(/^\/+/, "");
  const name = rel === "" ? "index.html" : rel;
  if (!name.includes("..")) {
    const body = await readFile(join(DIST, name)).catch(() => null);
    if (body) return write(response, 200, TYPES[extname(name)] ?? "application/octet-stream", body);
  }
  const home = await readFile(join(DIST, "index.html")).catch(() => null);
  if (!home) {
    return write(
      response,
      404,
      "text/plain; charset=utf-8",
      Buffer.from("The interface hasn't been built yet: run `pnpm build`, or open the source code for `config.dev`.\n"),
    );
  }
  write(response, 200, TYPES[".html"] ?? "text/html; charset=utf-8", home);
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function json(response: ServerResponse, payload: unknown): void {
  write(response, 200, "application/json; charset=utf-8", JSON.stringify(payload));
}

function write(response: ServerResponse, status: number, contentType: string, body: Buffer | string): void {
  response.writeHead(status, { "content-type": contentType, "content-length": Buffer.byteLength(body) });
  response.end(body);
}

export const definition: Definition = {
  provides: ["web"],
  hostCalls: ["web"],
  registrations: [],
  injects: [
    { capability: "session" },
    { capability: "agent.loop" },
    { capability: "agent.runner", optional: true },
    { capability: "permission", optional: true },
    { capability: "i18n", optional: true },
    { capability: "settings" },
    { capability: "workspace" },
  ],
  configKeys: ["port", "host", "dev", "open"],

  async setup(wiring) {
    settings = settingsFrom(wiring.config, process.env.NODE_ENV);
    bridge = createBridge(wiring.channel, wiring.capabilities);

    server = createServer((request, response) => {
      void handle(request, response).catch((error: unknown) => {
        if (!response.headersSent) response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
        response.end(messageOf(error));
      });
    });
    server.on("error", (error: Error) => wiring.channel.log("error", `web: ${messageOf(error)}`));

    if (!settings.dev) return;
    try {
      const vite = await import("vite");
      dev = await vite.createServer({ configFile: VITE_CONFIG, server: { middlewareMode: true } });
      wiring.channel.log("info", `web: serving the UI through Vite from ${UI}`);
    } catch (error) {
      dev = null;
      wiring.channel.log("warn", `web: vite did not start (are the apps/web dependencies installed?): ${messageOf(error)}`);
    }
  },

  async start(wiring) {
    capabilities = wiring.capabilities ?? {};
    channel = wiring.channel;
    await bridge.open();
    await new Promise<void>((resolve) => {
      server.once("error", () => resolve());
      server.listen(settings.port, settings.host, resolve);
    });
    if (!server.listening) {
      wiring.channel.log("warn", `web: could not listen on ${settings.host}:${settings.port}`);
      return;
    }
    wiring.channel.log("info", `MaoTa web: ${url()}`);

    const ssh = process.env.SSH_CONNECTION !== undefined || process.env.SSH_TTY !== undefined;
    if (!settings.open || ssh || (dev === null && !existsSync(join(DIST, "index.html")))) return;
    wiring.channel.log("info", "MaoTa web: opening the default browser; set open = true in [plugins.web.config] to keep this on");
    openBrowser(url(), wiring.channel);
  },

  methods: {
    info,
  },

  async close() {
    bridge.close();
    server.closeAllConnections();
    server.close();
    await dev?.close();
  },

  selfCheck() {
    const problems: string[] = [];
    const cases: Array<[Record<string, unknown>, string | undefined, Settings]> = [
      [{}, undefined, { port: 8341, host: "127.0.0.1", dev: true, open: false }],
      [{}, "production", { port: 8341, host: "127.0.0.1", dev: false, open: false }],
      [{ dev: true }, "production", { port: 8341, host: "127.0.0.1", dev: true, open: false }],
      [{ port: 0 }, undefined, { port: 0, host: "127.0.0.1", dev: true, open: false }],
      [{ port: "abc" }, undefined, { port: 8341, host: "127.0.0.1", dev: true, open: false }],
      [{ port: 70000 }, undefined, { port: 8341, host: "127.0.0.1", dev: true, open: false }],
      [{ host: " ", port: 8080 }, undefined, { port: 8080, host: "127.0.0.1", dev: true, open: false }],
      [{ host: "0.0.0.0" }, undefined, { port: 8341, host: "0.0.0.0", dev: true, open: false }],
      [{ open: true }, undefined, { port: 8341, host: "127.0.0.1", dev: true, open: true }],
    ];
    for (const [config, env, want] of cases) {
      const got = settingsFrom(config, env);
      if (JSON.stringify(got) !== JSON.stringify(want)) {
        problems.push(`settingsFrom(${JSON.stringify(config)}, ${env}) = ${JSON.stringify(got)}`);
      }
    }
    if (!/^\d+\.\d+\.\d+/.test(VERSION)) problems.push(`version in package.json is ${JSON.stringify(VERSION)}`);
    return problems;
  },
};

runPlugin(definition);
