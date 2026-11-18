import { randomBytes, timingSafeEqual } from "node:crypto";
import { watch } from "node:fs";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  computeGdiBreakdown,
  countEvents,
  getAssetRelationships,
  loadStore,
  manageAsset,
  readRecentEvents,
  resolveSyncRepoPath,
  runAssetValidation,
  syncRepoPull,
  syncRepoPush,
} from "./store.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const UI_ROOT = join(__dirname, "canvas-ui");
const CONTENT_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
]);

function setSecurityHeaders(res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
}

function sendJson(res, status, data) {
  const body = Buffer.from(JSON.stringify(data));
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Length", body.length);
  setSecurityHeaders(res);
  res.end(body);
}

async function readJsonBody(req) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 512 * 1024) throw new Error("Request body too large.");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function safeUiFilePath(pathname) {
  const clean = decodeURIComponent(pathname) === "/" ? "index.html" : decodeURIComponent(pathname).replace(/^\/+/, "");
  const candidate = resolve(UI_ROOT, clean);
  const rel = relative(UI_ROOT, candidate);
  if (rel === ".." || rel.startsWith(`..${sep}`) || resolve(candidate) === resolve(UI_ROOT)) {
    throw new Error("Invalid UI asset path.");
  }
  return candidate;
}

export function createEvoCanvasServer({
  evoHome,
  getCurrentRepo = () => "",
  getWorkingDirectory = () => process.cwd(),
  onRefineRequest = null,
}) {
  const canvasToken = randomBytes(32).toString("hex");
  const sseClients = new Set();
  const activeInstances = new Set();
  let viewState = { tab: "assets", filter: "all", assetId: "" };
  let serverInfo = null;
  let serverPromise = null;
  let fsWatcher = null;
  let watchTimer = null;

  function buildSnapshot() {
    const store = loadStore(evoHome);
    const events = readRecentEvents(evoHome, 60);
    const allAssets = [...store.rules, ...store.fixes];
    const nowMs = Date.now();
    const enrich = (item) => {
      const gdi = computeGdiBreakdown(item, allAssets, nowMs);
      return {
        ...item,
        repoScope: item.repoScope || "*",
        gdiScore: gdi.score,
        gdiBreakdown: gdi,
        relationships: getAssetRelationships(item, allAssets),
      };
    };
    const rules = store.rules.map(enrich).sort((a, b) => b.gdiScore - a.gdiScore);
    const fixes = store.fixes.map(enrich).sort((a, b) => b.gdiScore - a.gdiScore);

    return {
      evoHome,
      currentRepo: getCurrentRepo(),
      syncRepoPath: resolveSyncRepoPath(evoHome),
      config: store.config,
      rules,
      fixes,
      events,
      counts: {
        rules: store.rules.length,
        fixes: store.fixes.length,
        teamAssets:
          store.rules.filter((r) => r.scope === "team").length +
          store.fixes.filter((f) => f.scope === "team").length,
        events: countEvents(evoHome),
      },
      viewState,
    };
  }

  function broadcastUpdate(reason = "store-updated") {
    const payload = `event: update\ndata: ${JSON.stringify({ reason, viewState })}\n\n`;
    for (const res of sseClients) {
      try {
        res.write(payload);
      } catch {
        sseClients.delete(res);
      }
    }
  }

  function isValidToken(req) {
    const token = req.headers["x-evo-token"];
    if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token)) return false;
    return timingSafeEqual(Buffer.from(token), Buffer.from(canvasToken));
  }

  async function handleRequest(req, res) {
    const port = req.socket.localPort;
    const expectedHost = `127.0.0.1:${port}`;
    const expectedOrigin = `http://${expectedHost}`;
    const reqUrl = new URL(req.url || "/", expectedOrigin);

    if (
      req.headers.host !== expectedHost ||
      (req.headers.origin && req.headers.origin !== expectedOrigin) ||
      (req.headers["sec-fetch-site"] === "cross-site" && reqUrl.pathname !== "/")
    ) {
      sendJson(res, 403, { error: "Forbidden origin." });
      return;
    }

    if (reqUrl.pathname === "/api/config") {
      sendJson(res, 200, { canvasToken });
      return;
    }

    if (reqUrl.pathname === "/api/state" && req.method === "GET") {
      sendJson(res, 200, buildSnapshot());
      return;
    }

    if (reqUrl.pathname === "/api/events" && req.method === "GET") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store",
        Connection: "keep-alive",
      });
      res.write(`event: ready\ndata: ${JSON.stringify({ ok: true })}\n\n`);
      sseClients.add(res);
      req.on("close", () => sseClients.delete(res));
      return;
    }

    if (reqUrl.pathname.startsWith("/api/") && req.method === "POST") {
      if (!isValidToken(req)) {
        sendJson(res, 403, { ok: false, error: "Invalid canvas token." });
        return;
      }
      const body = await readJsonBody(req);
      let result;
      if (reqUrl.pathname === "/api/assets/promote-team") {
        result = manageAsset("promote_team", body.id, { evoHome });
        if (result?.ok && body.push !== false && resolveSyncRepoPath(evoHome)) {
          try {
            const pushRes = await syncRepoPush(evoHome);
            result = {
              ...result,
              pushed: Boolean(pushRes?.pushed),
              syncError: pushRes?.ok ? "" : pushRes?.error || "Sync failed",
            };
          } catch (err) {
            result = { ...result, pushed: false, syncError: err.message };
          }
        }
      } else if (reqUrl.pathname === "/api/assets/feedback") {
        const action = ["pin", "unpin", "upvote", "downvote"].includes(body.action) ? body.action : "";
        result = action ? manageAsset(action, body.id, { evoHome }) : { ok: false, error: "Invalid feedback action." };
      } else if (reqUrl.pathname === "/api/assets/refine") {
        const feedback = String(body.feedback || "").trim();
        const store = loadStore(evoHome);
        const asset = [...store.rules, ...store.fixes].find((a) => a.id === body.id);
        if (!asset) {
          result = { ok: false, error: `Experience not found: ${body.id}` };
        } else if (!feedback) {
          result = { ok: false, error: "Please enter refinement instructions." };
        } else if (typeof onRefineRequest !== "function") {
          result = { ok: false, error: "Copilot session bridge is unavailable." };
        } else {
          await onRefineRequest({ asset, feedback });
          result = { ok: true, id: asset.id };
        }
      } else if (reqUrl.pathname === "/api/arena/validate") {
        result = await runAssetValidation(evoHome, body.id, getWorkingDirectory());
      } else if (reqUrl.pathname === "/api/assets/delete") {
        result = manageAsset("delete", body.id, { evoHome });
      } else if (reqUrl.pathname === "/api/sync/pull") {
        result = await syncRepoPull(evoHome);
      } else if (reqUrl.pathname === "/api/sync/push") {
        result = await syncRepoPush(evoHome, { commitMessage: body.commitMessage });
      } else {
        sendJson(res, 404, { ok: false, error: "Unknown endpoint." });
        return;
      }
      if (result?.ok) broadcastUpdate("mutation");
      sendJson(res, result?.ok ? 200 : 400, result);
      return;
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      sendJson(res, 405, { error: "Method not allowed." });
      return;
    }

    try {
      const filePath = safeUiFilePath(reqUrl.pathname);
      const body = await readFile(filePath);
      res.statusCode = 200;
      res.setHeader("Content-Type", CONTENT_TYPES.get(extname(filePath).toLowerCase()) || "application/octet-stream");
      res.setHeader("Content-Length", body.length);
      res.setHeader(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'"
      );
      setSecurityHeaders(res);
      res.end(req.method === "HEAD" ? undefined : body);
    } catch {
      sendJson(res, 404, { error: "Not found." });
    }
  }

  async function ensureStarted() {
    if (serverInfo) return serverInfo;
    if (!serverPromise) {
      serverPromise = (async () => {
        const server = createServer((req, res) => {
          handleRequest(req, res).catch((err) => {
            if (!res.headersSent) {
              sendJson(res, 500, { ok: false, error: err.message });
            } else {
              res.destroy(err);
            }
          });
        });
        await new Promise((resolveListen, rejectListen) => {
          server.once("error", rejectListen);
          server.listen(0, "127.0.0.1", () => {
            server.off("error", rejectListen);
            resolveListen();
          });
        });
        const { port } = server.address();
        serverInfo = { server, url: `http://127.0.0.1:${port}/` };
        // Watch evoHome so writes from other parallel Copilot sessions live-refresh the canvas.
        try {
          fsWatcher = watch(evoHome, { persistent: false }, (_eventType, filename) => {
            if (filename && !/\.(?:json|jsonl)$/i.test(String(filename))) return;
            if (watchTimer) clearTimeout(watchTimer);
            watchTimer = setTimeout(() => broadcastUpdate("external_change"), 200);
          });
        } catch {
          // Ignore fs.watch failures on unsupported filesystems.
        }
        return serverInfo;
      })().catch((err) => {
        serverPromise = null;
        throw err;
      });
    }
    return serverPromise;
  }

  async function openInstance(ctx) {
    activeInstances.add(ctx.instanceId);
    if (ctx.input && typeof ctx.input === "object") {
      viewState = {
        tab: ctx.input.tab || viewState.tab,
        filter: ctx.input.filter || viewState.filter,
        assetId: ctx.input.assetId ?? viewState.assetId,
      };
    }
    const entry = await ensureStarted();
    broadcastUpdate("open");
    return {
      title: "Copilot Evo",
      status: `${loadStore(evoHome).rules.length} Rules · ${loadStore(evoHome).fixes.length} Fixes`,
      url: `${entry.url}?open=${randomBytes(6).toString("hex")}`,
    };
  }

  async function closeInstance(ctx) {
    activeInstances.delete(ctx.instanceId);
    if (activeInstances.size === 0 && serverInfo) {
      if (watchTimer) clearTimeout(watchTimer);
      watchTimer = null;
      if (fsWatcher) {
        fsWatcher.close();
        fsWatcher = null;
      }
      for (const res of sseClients) res.end();
      sseClients.clear();
      const { server } = serverInfo;
      serverInfo = null;
      serverPromise = null;
      await new Promise((r) => server.close(() => r()));
    }
  }

  function setViewState(patch) {
    viewState = { ...viewState, ...patch };
    broadcastUpdate("action");
    return viewState;
  }

  return {
    openInstance,
    closeInstance,
    broadcastUpdate,
    setViewState,
    buildSnapshot,
  };
}
