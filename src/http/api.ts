import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { DomainError } from "../domain/errors.js";
import { publishDueEditions } from "../domain/publisher.js";
import { loadReferenceEnums } from "../domain/reference.js";
import type {
  CreateEditionInput,
  EditorialService,
  ProposeVersionInput,
  RecordTranslationInput,
  RegisterCitationInput,
  RegisterFactInput,
} from "../domain/service.js";
import { CHANNELS, type Channel, type ClarificationKind, type ExpertStance, type ReviewDecision, type ReviewType } from "../domain/constants.js";

interface Route {
  method: string;
  pattern: RegExp;
  handler: (params: Record<string, string>, request: IncomingMessage, response: ServerResponse) => Promise<void>;
}

const jsonHeaders = { "content-type": "application/json; charset=utf-8" };

export interface ApiDeps {
  service: EditorialService;
  referencePath?: string;
}

export function createApiServer({ service, referencePath }: ApiDeps): Server {
  const routes: Route[] = [
    { method: "GET", pattern: /^\/health$/, handler: async (_p, _rq, rs) => {
        rs.writeHead(200, jsonHeaders);
        rs.end(JSON.stringify({ status: "ok", service: "科学展签更正发布台" }));
      } },

    { method: "GET", pattern: /^\/reference\/enums$/, handler: async (_p, _rq, rs) => {
        ok(rs, loadReferenceEnums(referencePath));
      } },

    // ---------- 事实 ----------
    { method: "POST", pattern: /^\/facts$/, handler: async (_p, rq, rs) => {
        const body = await readBody<RegisterFactInput>(rq);
        const result = service.registerFact(body, revisionOf(rq, null), actor(rq));
        created(rs, result, service.revisionOf(result.factId));
      } },
    { method: "GET", pattern: /^\/facts$/, handler: async (_p, _rq, rs) => {
        ok(rs, { facts: service.listFacts() });
      } },
    { method: "GET", pattern: /^\/facts\/(?<id>[^/]+)$/, handler: async (p, _rq, rs) => {
        ok(rs, service.getFact(p.id!), service.revisionOf(p.id!));
      } },
    { method: "GET", pattern: /^\/facts\/(?<id>[^/]+)\/timeline$/, handler: async (p, _rq, rs) => {
        ok(rs, { streamId: p.id, revision: service.revisionOf(p.id!), events: service.timeline(p.id!) });
      } },

    // ---------- 候选更正 ----------
    { method: "POST", pattern: /^\/facts\/(?<id>[^/]+)\/versions$/, handler: async (p, rq, rs) => {
        const body = await readBody<ProposeVersionInput>(rq);
        const result = service.proposeVersion(p.id!, body, requireRevision(rq), actor(rq));
        created(rs, result, result.revision);
      } },

    // ---------- 引文 ----------
    { method: "POST", pattern: /^\/citations$/, handler: async (_p, rq, rs) => {
        const body = await readBody<RegisterCitationInput>(rq);
        const result = service.registerCitation(body, actor(rq));
        created(rs, result, result.revision);
      } },
    { method: "POST", pattern: /^\/citations\/(?<id>[^/]+)\/retract$/, handler: async (p, rq, rs) => {
        const body = await readBody<{ reason: string; noticeSource: string; retractedAt?: string }>(rq);
        const result = service.retractCitation(p.id!, body, requireRevision(rq), actor(rq));
        ok(rs, result, result.revision);
      } },
    { method: "GET", pattern: /^\/reports\/citations$/, handler: async (_p, rq, rs) => {
        const url = new URL(rq.url ?? "/", "http://localhost");
        ok(rs, service.citationReport(url.searchParams.get("citationId") ?? undefined));
      } },
    { method: "POST", pattern: /^\/facts\/(?<id>[^/]+)\/versions\/(?<vid>[^/]+)\/citations$/, handler: async (p, rq, rs) => {
        const body = await readBody<{ citationId: string }>(rq);
        requireString(body.citationId, "citationId");
        const result = service.linkCitation(p.id!, p.vid!, body.citationId, requireRevision(rq), actor(rq));
        ok(rs, result, result.revision);
      } },

    // ---------- 专家意见 ----------
    { method: "POST", pattern: /^\/facts\/(?<id>[^/]+)\/opinions$/, handler: async (p, rq, rs) => {
        const body = await readBody<{
          versionId?: string | null;
          expert: string;
          affiliation: string;
          stance: ExpertStance;
          content: string;
        }>(rq);
        const result = service.recordOpinion(p.id!, body, requireRevision(rq), actor(rq));
        created(rs, result, result.revision);
      } },

    // ---------- 审核 ----------
    { method: "POST", pattern: /^\/facts\/(?<id>[^/]+)\/reviews\/version$/, handler: async (p, rq, rs) => {
        const body = await readBody<{ versionId: string; reviewType: ReviewType; decision: ReviewDecision; comments?: string }>(rq);
        const result = service.submitVersionReview(p.id!, body, requireRevision(rq), actor(rq));
        created(rs, result, result.revision);
      } },
    { method: "POST", pattern: /^\/facts\/(?<id>[^/]+)\/reviews\/translation$/, handler: async (p, rq, rs) => {
        const body = await readBody<{ translationId: string; decision: ReviewDecision; comments?: string }>(rq);
        const result = service.submitTranslationReview(p.id!, body, requireRevision(rq), actor(rq));
        created(rs, result, result.revision);
      } },

    // ---------- 译文 ----------
    { method: "POST", pattern: /^\/facts\/(?<id>[^/]+)\/translations$/, handler: async (p, rq, rs) => {
        const body = await readBody<RecordTranslationInput>(rq);
        const result = service.recordTranslation(p.id!, body, requireRevision(rq), actor(rq));
        created(rs, result, result.revision);
      } },
    { method: "POST", pattern: /^\/facts\/(?<id>[^/]+)\/translations\/(?<tid>[^/]+)\/revise$/, handler: async (p, rq, rs) => {
        const body = await readBody(rq);
        const result = service.reviseTranslation(
          p.id!,
          { translationId: p.tid!, text: requireString(body.text, "text") },
          requireRevision(rq),
          actor(rq),
        );
        ok(rs, result, result.revision);
      } },

    // ---------- 版面 ----------
    { method: "POST", pattern: /^\/facts\/(?<id>[^/]+)\/editions$/, handler: async (p, rq, rs) => {
        const body = await readBody<CreateEditionInput>(rq);
        const result = service.createEdition(p.id!, body, requireRevision(rq), actor(rq));
        created(rs, result, result.revision);
      } },
    { method: "POST", pattern: /^\/facts\/(?<id>[^/]+)\/editions\/(?<eid>[^/]+)\/update$/, handler: async (p, rq, rs) => {
        const body = await readBody<{
          versionId?: string;
          items?: CreateEditionInput["items"];
          note?: string;
        }>(rq);
        const result = service.updateEditionDraft(
          p.id!,
          {
            editionId: p.eid!,
            ...(body.versionId !== undefined ? { versionId: body.versionId } : {}),
            ...(body.items !== undefined ? { items: body.items } : {}),
            ...(body.note !== undefined ? { note: body.note } : {}),
          },
          requireRevision(rq),
          actor(rq),
        );
        ok(rs, result, result.revision);
      } },
    { method: "POST", pattern: /^\/facts\/(?<id>[^/]+)\/editions\/(?<eid>[^/]+)\/schedule$/, handler: async (p, rq, rs) => {
        const body = await readBody(rq);
        const result = service.scheduleEdition(
          p.id!,
          { editionId: p.eid!, publishAt: requireString(body.publishAt, "publishAt") },
          requireRevision(rq),
          actor(rq),
        );
        ok(rs, result, result.revision);
      } },
    { method: "POST", pattern: /^\/facts\/(?<id>[^/]+)\/editions\/(?<eid>[^/]+)\/publish$/, handler: async (p, rq, rs) => {
        const body = await readBody(rq);
        const result = service.publishEdition(
          p.id!,
          { editionId: p.eid! },
          requireRevision(rq),
          actor(rq),
          { force: body.force === true },
        );
        ok(rs, result, result.revision);
      } },
    { method: "POST", pattern: /^\/facts\/(?<id>[^/]+)\/editions\/(?<eid>[^/]+)\/cancel$/, handler: async (p, rq, rs) => {
        const body = await readBody(rq);
        const result = service.cancelEdition(
          p.id!,
          { editionId: p.eid!, reason: requireString(body.reason, "reason") },
          requireRevision(rq),
          actor(rq),
        );
        ok(rs, result, result.revision);
      } },
    { method: "POST", pattern: /^\/facts\/(?<id>[^/]+)\/editions\/(?<eid>[^/]+)\/clarifications$/, handler: async (p, rq, rs) => {
        const body = await readBody<{
          kind: ClarificationKind;
          text: string;
          marker?: string;
          citationId?: string | null;
        }>(rq);
        const result = service.appendClarification(
          p.id!,
          {
            editionId: p.eid!,
            kind: body.kind,
            text: body.text,
            ...(body.marker !== undefined ? { marker: body.marker } : {}),
            citationId: body.citationId ?? null,
          },
          requireRevision(rq),
          actor(rq),
        );
        created(rs, result, result.revision);
      } },

    // ---------- 看板 / 溯源 ----------
    { method: "GET", pattern: /^\/board$/, handler: async (_p, rq, rs) => {
        const url = new URL(rq.url ?? "/", "http://localhost");
        const channelParam = url.searchParams.get("channel");
        ok(rs, service.board({
          ...(channelParam ? { channel: requireEnumParam(channelParam, CHANNELS, "channel") } : {}),
          ...(url.searchParams.get("speciesCode") ? { speciesCode: url.searchParams.get("speciesCode")! } : {}),
          ...(url.searchParams.get("exhibitZone") ? { exhibitZone: url.searchParams.get("exhibitZone")! } : {}),
        }));
      } },
    { method: "GET", pattern: /^\/trace$/, handler: async (_p, rq, rs) => {
        const url = new URL(rq.url ?? "/", "http://localhost");
        const pick = (key: string) => url.searchParams.get(key);
        ok(rs, service.trace({
          ...(pick("text") !== null ? { text: pick("text") as string } : {}),
          ...(pick("versionId") !== null ? { versionId: pick("versionId") as string } : {}),
          ...(pick("translationId") !== null ? { translationId: pick("translationId") as string } : {}),
          ...(pick("editionId") !== null ? { editionId: pick("editionId") as string } : {}),
        }));
      } },

    // ---------- 定时发布（也可由内部定时器触发） ----------
    { method: "POST", pattern: /^\/publisher\/run-due$/, handler: async (_p, rq, rs) => {
        ok(rs, await publishDueEditions(service, actor(rq)));
      } },
  ];

  return createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
      for (const route of routes) {
        if (request.method !== route.method) continue;
        const match = route.pattern.exec(pathname);
        if (!match) continue;
        await route.handler(match.groups ?? {}, request, response);
        return;
      }
      response.writeHead(404, jsonHeaders);
      response.end(JSON.stringify({ error: "not_found", path: pathname }));
    } catch (error) {
      sendError(response, error);
    }
  });
}

// ---------- HTTP 辅助 ----------

const MAX_BODY_BYTES = 2 * 1024 * 1024;

async function readBody<T = Record<string, unknown>>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw new DomainError("validation_error", "请求体超过 2MB 限制");
    }
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {} as T;
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("JSON 顶层必须是对象");
    }
    return parsed as T;
  } catch (error) {
    throw new DomainError(
      "validation_error",
      `请求体不是合法 JSON 对象: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function requireEnumParam<T extends string>(
  value: string,
  allowed: readonly T[],
  label: string,
): T {
  if (!allowed.includes(value as T)) {
    throw new DomainError("validation_error", `${label} 必须是 ${allowed.join(" / ")} 之一`);
  }
  return value as T;
}

function actor(request: IncomingMessage): string {
  return (request.headers["x-actor"] as string | undefined)?.trim() || "anonymous";
}

/** 命令必须携带所基于的流版本（If-Match），用于过期草稿检测 */
function requireRevision(request: IncomingMessage): number {
  const header = request.headers["if-match"];
  const raw = Array.isArray(header) ? header[0] : header;
  const revision = Number.parseInt(raw ?? "", 10);
  if (!Number.isInteger(revision) || revision < 0) {
    throw new DomainError(
      "stale_revision",
      "命令缺少基准版本号：请通过 If-Match: <revision> 头携带 GET 时返回的 X-Stream-Revision",
    );
  }
  return revision;
}

function revisionOf(request: IncomingMessage, fallback: number | null): number | null {
  const header = request.headers["if-match"];
  const fromHeader = Array.isArray(header) ? header[0] : header;
  if (fromHeader === undefined || fromHeader === "") return fallback;
  const revision = Number.parseInt(fromHeader, 10);
  if (!Number.isInteger(revision) || revision < 0) {
    throw new DomainError("stale_revision", `If-Match 版本号不合法: ${fromHeader}`);
  }
  return revision;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new DomainError("validation_error", `${label} 必须是非空字符串`);
  }
  return value;
}

function statusFor(code: DomainError["code"]): number {
  switch (code) {
    case "not_found": return 404;
    case "conflict": return 409;
    case "stale_revision": return 412;
    case "validation_error": return 400;
    case "approval_gate_failed":
    case "schedule_gate_failed": return 422;
  }
}

function sendError(response: ServerResponse, error: unknown): void {
  if (error instanceof DomainError) {
    response.writeHead(statusFor(error.code), jsonHeaders);
    response.end(JSON.stringify({ error: error.code, message: error.message, details: error.details ?? null }));
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  response.writeHead(500, jsonHeaders);
  response.end(JSON.stringify({ error: "internal_error", message }));
}

function ok(response: ServerResponse, payload: unknown, revision?: number): void {
  response.writeHead(200, revisionHeaders(revision));
  response.end(JSON.stringify(payload));
}

function created(response: ServerResponse, payload: unknown, revision?: number): void {
  response.writeHead(201, revisionHeaders(revision));
  response.end(JSON.stringify(payload));
}

function revisionHeaders(revision?: number): Record<string, string> {
  const headers: Record<string, string> = { ...jsonHeaders };
  if (revision !== undefined) headers["x-stream-revision"] = String(revision);
  return headers;
}
