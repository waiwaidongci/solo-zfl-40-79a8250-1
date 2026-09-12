import http from "node:http";
import { StoreError } from "./store.js";
import { page } from "./page.js";

const MAX_BODY = 1024 * 1024; // 1MB

function send(res, status, data, extraHeaders = {}) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...extraHeaders });
  res.end(JSON.stringify(data, null, 2));
}

function sendError(res, error) {
  if (error instanceof StoreError) {
    send(res, error.status, { error: error.code, message: error.message });
  } else {
    send(res, 500, { error: "internal_error", message: error.message });
  }
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new StoreError(413, "payload_too_large", "请求体超过 1MB 限制");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new StoreError(400, "invalid_json", "请求体必须是 JSON 对象");
    }
    return parsed;
  } catch (error) {
    if (error instanceof StoreError) throw error;
    throw new StoreError(400, "invalid_json", "请求体不是合法 JSON");
  }
}

function idemKey(req, input) {
  const key = req.headers["idempotency-key"] || input.requestId || "";
  if (typeof key !== "string" || key.length > 128) {
    throw new StoreError(400, "invalid_input", "幂等键必须是 128 字以内的字符串");
  }
  return key;
}

function decodeRef(raw) {
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new StoreError(400, "invalid_input", "路径参数编码非法");
  }
}

export function createApp(store) {
  const routes = [
    ["GET", /^\/$/, (req, res) => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(page());
    }],
    ["GET", /^\/api\/items$/, (req, res, url) => {
      const filter = {};
      for (const key of ["status", "batch", "box", "defect", "q"]) {
        const v = url.searchParams.get(key);
        if (v) filter[key] = v.trim();
      }
      send(res, 200, store.listItems(filter));
    }],
    ["POST", /^\/api\/batches$/, async (req, res) => {
      const input = await readJson(req);
      const { result, replayed } = await store.createBatch(input, idemKey(req, input));
      send(res, 201, result, replayed ? { "X-Idempotent-Replay": "true" } : {});
    }],
    ["GET", /^\/api\/batches$/, (req, res) => send(res, 200, store.listBatches())],
    ["GET", /^\/api\/stats$/, (req, res) => send(res, 200, store.stats())],
    ["GET", /^\/api\/items\/([^/]+)$/, (req, res, url, m) => send(res, 200, store.getItem(decodeRef(m[1])))],
    ["POST", /^\/api\/items\/([^/]+)\/transition$/, async (req, res, url, m) => {
      const input = await readJson(req);
      const { result, replayed } = await store.transition(decodeRef(m[1]), input, idemKey(req, input));
      send(res, 200, result, replayed ? { "X-Idempotent-Replay": "true" } : {});
    }],
    ["POST", /^\/api\/items\/([^/]+)\/steps$/, async (req, res, url, m) => {
      const input = await readJson(req);
      const { result, replayed } = await store.addStep(decodeRef(m[1]), input, idemKey(req, input));
      send(res, 201, result, replayed ? { "X-Idempotent-Replay": "true" } : {});
    }],
  ];

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
      const pathMatched = routes.filter(([, pattern]) => pattern.test(url.pathname));
      const route = pathMatched.find(([method]) => method === req.method);
      if (!route) {
        if (pathMatched.length) return send(res, 405, { error: "method_not_allowed", message: `${req.method} 不支持该路径` });
        return send(res, 404, { error: "not_found", message: "接口不存在" });
      }
      const match = url.pathname.match(route[1]);
      await route[2](req, res, url, match);
    } catch (error) {
      sendError(res, error);
    }
  });
}
