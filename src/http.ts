import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { DomainError } from "./domain/errors.js";
import { EditorialService } from "./domain/service.js";
import { QueryService } from "./domain/queries.js";
import { Store } from "./domain/store.js";
import { serviceName } from "./service-info.js";

interface RouteContext {
  service: EditorialService;
  queries: QueryService;
  id: string;
  body: Record<string, unknown>;
  query: URLSearchParams;
}

interface Route {
  method: string;
  pattern: RegExp;
  paramNames: string[];
  handle: (ctx: RouteContext) => unknown;
}

function route(method: string, path: string, handle: Route["handle"]): Route {
  const names: string[] = [];
  const patternText = path
    .replace(/<([^>]+)>/g, (_, name: string) => {
      names.push(name);
      return "([^/]+)";
    })
    .replace(/\//g, "\\/");
  return { method, pattern: new RegExp(`^${patternText}$`), paramNames: names, handle };
}

const routes: Route[] = [
  // 基础资料
  route("POST", "/zones", (c) => c.service.registerZone(c.body)),
  route("POST", "/taxa", (c) => c.service.registerTaxon(c.body)),
  route("POST", "/citations", (c) => c.service.registerCitation(c.body)),
  route("POST", "/expert-opinions", (c) => c.service.addExpertOpinion(c.body)),
  route("POST", "/facts", (c) => c.service.defineFact(c.body)),
  route("POST", "/baselines", (c) => c.service.publishBaseline(c.body)),

  // 候选更正工作流
  route("POST", "/corrections", (c) => c.service.createCorrection(c.body)),
  route("POST", "/corrections/<id>/draft", (c) => c.service.updateDraft(c.id, c.body)),
  route("POST", "/corrections/<id>/submit", (c) => c.service.submit(c.id, c.body)),
  route("POST", "/corrections/<id>/reviews", (c) => c.service.review(c.id, c.body)),
  route("POST", "/corrections/<id>/schedule", (c) => c.service.schedule(c.id, c.body)),
  route("POST", "/publications/due", (c) => c.service.publishDue(typeof c.body.actor === "string" ? c.body.actor : undefined)),

  // 译文
  route("POST", "/corrections/<id>/translations", (c) => c.service.addTranslation(c.id, c.body)),
  route("POST", "/translations/<id>/revise", (c) => c.service.updateTranslation(c.id, c.body)),
  route("POST", "/translations/<id>/review", (c) => c.service.reviewTranslation(c.id, c.body)),

  // 撤回与紧急勘误
  route("POST", "/citations/<id>/retract", (c) => c.service.markCitationRetracted(c.id, c.body)),
  route("POST", "/publications/<id>/errata", (c) => c.service.appendErratum(c.id, c.body)),

  // 看板与溯源
  route("GET", "/boards/taxa/<id>", (c) => c.queries.taxonBoard(c.id)),
  route("GET", "/boards/zones/<id>", (c) => c.queries.zoneBoard(c.id)),
  route("GET", "/citations", (c) => {
    const id = c.query.get("id");
    return id ? c.queries.citation(id) : c.queries.citations();
  }),
  route("GET", "/provenance", (c) => {
    const publicationId = c.query.get("publicationId");
    const contentVersionId = c.query.get("contentVersionId");
    const text = c.query.get("text");
    return c.queries.provenance({
      ...(publicationId ? { publicationId } : {}),
      ...(contentVersionId ? { contentVersionId } : {}),
      ...(text ? { text } : {}),
    });
  }),
];

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (request.method === "GET") return {};
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw.trim() === "") return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw DomainError.badRequest("请求体必须是 JSON 对象");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw DomainError.badRequest("请求体不是合法 JSON");
  }
}

function send(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

export function createApp(store?: Store): Server {
  const resolved = store ?? Store.open(process.env.DATA_PATH ?? ".runtime/db.json", () => new Date().toISOString());
  const service = new EditorialService(resolved);
  const queries = new QueryService(resolved.data);

  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (request.method === "GET" && url.pathname === "/health") {
        send(response, 200, { status: "ok", service: serviceName });
        return;
      }

      const body = await readJson(request);
      for (const r of routes) {
        if (r.method !== request.method) continue;
        const match = r.pattern.exec(url.pathname);
        if (!match) continue;
        const id = decodeURIComponent(match[1] ?? "");
        const result = r.handle({ service, queries, id, body, query: url.searchParams });
        send(response, 200, result);
        return;
      }

      send(response, 404, { error: "not_found" });
    } catch (error) {
      if (error instanceof DomainError) {
        send(response, error.status, { error: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) });
        return;
      }
      send(response, 500, { error: "internal_error", message: (error as Error).message });
    }
  });
}
