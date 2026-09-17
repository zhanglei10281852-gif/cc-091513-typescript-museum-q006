import assert from "node:assert/strict";
import { test } from "node:test";
import type { Server } from "node:http";

import { createApp } from "../src/app.js";

interface RunningServer {
  base: string;
  close: () => Promise<void>;
}

async function start(): Promise<RunningServer> {
  const server = createApp();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  return {
    base,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function jsonRequest(
  base: string,
  path: string,
  init: { method?: string; body?: unknown; ifMatch?: string | null; actor?: string } = {},
): Promise<{ status: number; body: any; revision: string | null }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (init.actor) headers["x-actor"] = init.actor;
  if (init.ifMatch !== undefined && init.ifMatch !== null) headers["if-match"] = init.ifMatch;
  const response = await fetch(`${base}${path}`, {
    method: init.method ?? "GET",
    headers,
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) : null,
    revision: response.headers.get("x-stream-revision"),
  };
}

test("HTTP 全流程：候选 → 证据 → 学科/语言审核 → 排期 → 定时发布", async () => {
  const running = await start();
  try {
    const { base } = running;

    // 登记事实
    const created = await jsonRequest(base, "/facts", {
      method: "POST",
      actor: "curator",
      body: {
        speciesCode: "AV-009",
        speciesName: "网络雀",
        exhibitZone: "鸟类厅 C 区",
        kind: "distribution",
        currentText: "旧分布",
      },
    });
    assert.equal(created.status, 201);
    const factId = created.body.factId as string;
    assert.equal(created.revision, "1");

    // 过期草稿：不带 If-Match 直接提候选（登记后流版本为 1，新建流的 null 预期失败）
    const noRevision = await jsonRequest(base, `/facts/${factId}/versions`, {
      method: "POST",
      body: { text: "新分布", rationale: "新调查" },
    });
    assert.equal(noRevision.status, 412);
    assert.equal(noRevision.body.error, "stale_revision");

    // 正确版本号提交候选
    const proposed = await jsonRequest(base, `/facts/${factId}/versions`, {
      method: "POST",
      ifMatch: "1",
      actor: "editor-1",
      body: { text: "新分布", rationale: "新调查" },
    });
    assert.equal(proposed.status, 201);
    const versionId = proposed.body.versionId as string;

    // 并发：第二个编辑仍用版本 1 → 412
    const stale = await jsonRequest(base, `/facts/${factId}/versions`, {
      method: "POST",
      ifMatch: "1",
      actor: "editor-2",
      body: { text: "另一种说法", rationale: "另一依据" },
    });
    assert.equal(stale.status, 412);
    assert.equal(stale.body.error, "stale_revision");

    // 引文登记 + 关联
    const citation = await jsonRequest(base, "/citations", {
      method: "POST",
      actor: "editor-1",
      body: { title: "2026 鸟类调查", authors: ["调查组"], year: 2026 },
    });
    assert.equal(citation.status, 201);
    const citationId = citation.body.citationId as string;

    const linked = await jsonRequest(
      base,
      `/facts/${factId}/versions/${versionId}/citations`,
      {
        method: "POST",
        ifMatch: proposed.revision,
        actor: "editor-1",
        body: { citationId },
      },
    );
    assert.equal(linked.status, 200);

    // 学科学审
    const reviewed = await jsonRequest(base, `/facts/${factId}/reviews/version`, {
      method: "POST",
      ifMatch: linked.revision,
      actor: "reviewer-birds",
      body: { versionId, reviewType: "scientific", decision: "approved" },
    });
    assert.equal(reviewed.status, 201);

    // 译文 + 语言审核
    const translated = await jsonRequest(base, `/facts/${factId}/translations`, {
      method: "POST",
      ifMatch: reviewed.revision,
      actor: "editor-1",
      body: { versionId, language: "en", text: "New range", translator: "tr-a" },
    });
    assert.equal(translated.status, 201);
    const translationId = translated.body.translationId as string;

    const langReviewed = await jsonRequest(base, `/facts/${factId}/reviews/translation`, {
      method: "POST",
      ifMatch: translated.revision,
      actor: "language-reviewer",
      body: { translationId, decision: "approved" },
    });
    assert.equal(langReviewed.status, 201);

    // 创建版面
    const edition = await jsonRequest(base, `/facts/${factId}/editions`, {
      method: "POST",
      ifMatch: langReviewed.revision,
      actor: "editor-1",
      body: { channel: "online_catalog", versionId },
    });
    assert.equal(edition.status, 201);
    const editionId = edition.body.editionId as string;

    // 排期 200ms 后
    const scheduled = await jsonRequest(
      base,
      `/facts/${factId}/editions/${editionId}/schedule`,
      {
        method: "POST",
        ifMatch: edition.revision,
        actor: "editor-1",
        body: { publishAt: new Date(Date.now() + 200).toISOString() },
      },
    );
    assert.equal(scheduled.status, 200);

    // 未到时间：run-due 无发布
    const tooEarly = await jsonRequest(base, "/publisher/run-due", { method: "POST" });
    assert.equal(tooEarly.status, 200);
    assert.deepEqual(tooEarly.body.published, []);

    await sleep(300);
    const due = await jsonRequest(base, "/publisher/run-due", { method: "POST" });
    assert.equal(due.status, 200);
    assert.equal(due.body.published[0]?.editionId, editionId);

    // 看板可见当前发布
    const board = await jsonRequest(base, `/board?speciesCode=AV-009`);
    assert.equal(board.status, 200);
    const row = board.body.facts.find((f: any) => f.factId === factId);
    assert.equal(row.currentPublished[0]?.channel, "online_catalog");
    assert.equal(row.currentPublished[0]?.items[0]?.text, "新分布");

    // 溯源
    const traced = await jsonRequest(base, `/trace?text=${encodeURIComponent("新分布")}`);
    assert.equal(traced.status, 200);
    assert.ok(traced.body.matches.some((m: any) => m.editionId === editionId));
  } finally {
    await running.close();
  }
});

test("HTTP 错误语义：未知资源 404、非法枚举 400、撤回后排期 422、紧急标记 201", async () => {
  const running = await start();
  try {
    const { base } = running;
    assert.equal((await jsonRequest(base, "/facts/fact_nope")).status, 404);

    const bad = await jsonRequest(base, "/facts", {
      method: "POST",
      body: {
        speciesCode: "X",
        speciesName: "X",
        exhibitZone: "X",
        kind: "not_a_kind",
        currentText: "x",
      },
    });
    assert.equal(bad.status, 400);

    // 非法 JSON
    const response = await fetch(`${base}/facts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not-json",
    });
    assert.equal(response.status, 400);
  } finally {
    await running.close();
  }
});
