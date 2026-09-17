import assert from "node:assert/strict";
import { test } from "node:test";

import { createApp } from "../src/app.js";
import { Store } from "../src/domain/store.js";

function api(origin: string, method: string, path: string, body?: unknown): ReturnType<typeof fetch> {
  return fetch(`${origin}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function withServer(fn: (origin: string) => Promise<void>): Promise<void> {
  const store = Store.open(undefined, () => new Date().toISOString());
  const server = createApp(store);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    await fn(origin);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

test("健康检查", async () => {
  await withServer(async (origin) => {
    const res = await api(origin, "GET", "/health");
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: "ok", service: "科学展签更正发布台" });
  });
});

test("端到端 HTTP：完整更正流程 + 撤回 + 看板 + 溯源", async () => {
  await withServer(async (origin) => {
    // 基础资料
    const zone = await (await api(origin, "POST", "/zones", { actor: "admin", code: "B", name: "鸟类厅" })).json();
    const taxon = await (await api(origin, "POST", "/taxa", {
      actor: "admin",
      scientificName: "Pica pica",
      zoneIds: [zone.id],
    })).json();
    const oldCit = await (await api(origin, "POST", "/citations", {
      actor: "admin", key: "Chen2019", title: "旧志", authors: "Chen",
    })).json();
    const newCit = await (await api(origin, "POST", "/citations", {
      actor: "admin", key: "Park2026", title: "修订", authors: "Park",
    })).json();
    const opinion = await (await api(origin, "POST", "/expert-opinions", {
      actor: "admin", taxonId: taxon.id, expert: "李分类", discipline: "鸟类学", summary: "学名修订",
    })).json();
    const fact = await (await api(origin, "POST", "/facts", {
      actor: "admin", taxonId: taxon.id, kind: "scientific_name", key: "name",
    })).json();

    const baseline = await (await api(origin, "POST", "/baselines", {
      actor: "admin", factId: fact.id, channel: "gallery_label",
      text: "喜鹊 Pica pica", evidence: { citationIds: [oldCit.id], expertOpinionIds: [] },
    })).json();
    assert.equal(baseline.status, "published");

    // 候选与审核
    const correction = await (await api(origin, "POST", "/corrections", {
      actor: "editor-王", taxonId: taxon.id, factId: fact.id,
      channels: ["gallery_label", "online_catalog"], targetLanguages: ["en"],
      text: "东方喜鹊 Pica serica", rationale: "修订",
      evidence: { citationIds: [newCit.id], expertOpinionIds: [opinion.id] },
    })).json();
    await api(origin, "POST", `/corrections/${correction.id}/submit`, { actor: "editor-王" });

    // 并发冲突：缺 expectedRevision
    let res = await api(origin, "POST", `/corrections/${correction.id}/draft`, { actor: "x", text: "t" });
    assert.equal(res.status, 400);

    const tr = await (await api(origin, "POST", `/corrections/${correction.id}/translations`, {
      actor: "translator", translator: "张译", language: "en", text: "Oriental Magpie Pica serica",
    })).json();
    await api(origin, "POST", `/translations/${tr.id}/review`, {
      actor: "r", reviewer: "语言审校", decision: "approved",
    });
    await api(origin, "POST", `/corrections/${correction.id}/reviews`, {
      actor: "r", type: "scientific", reviewer: "李分类", decision: "approved",
    });
    await api(origin, "POST", `/corrections/${correction.id}/reviews`, {
      actor: "r", type: "language", reviewer: "语言审校", decision: "approved",
    });
    const scheduledAt = new Date(Date.now() - 1000).toISOString();
    await api(origin, "POST", `/corrections/${correction.id}/schedule`, {
      actor: "editor-王", publishAt: scheduledAt,
    });
    const due = await (await api(origin, "POST", "/publications/due", { actor: "system" })).json();
    assert.equal(due.length, 2);

    // 撤回旧文献 -> 已取代的旧基线仍被追加标记
    await api(origin, "POST", `/citations/${oldCit.id}/retract`, { actor: "editor-王", note: "数据问题" });

    // 看板
    const board = await (await api(origin, "GET", `/boards/taxa/${taxon.id}`)).json();
    const factView = board.facts[0];
    assert.equal(factView.channels.length, 2);
    const label = factView.channels.find((c: { channel: string }) => c.channel === "gallery_label");
    assert.equal(label.renderedText, "东方喜鹊 Pica serica");
    const supersededWithNotice = label;
    assert.ok(supersededWithNotice);

    // 溯源：按旧文字
    const provenance = await (
      await api(origin, "GET", `/provenance?text=${encodeURIComponent("喜鹊 Pica pica")}`)
    ).json();
    assert.ok(provenance.timeline.some((e: { type: string }) => e.type === "erratum_appended"));
    assert.ok(provenance.publications.some((p: { status: string; errata: unknown[] }) =>
      p.status === "superseded" && p.errata.length === 1));

    // 未知路由
    res = await api(origin, "GET", "/nope");
    assert.equal(res.status, 404);
  });
});

test("领域违规返回结构化错误", async () => {
  await withServer(async (origin) => {
    const res = await api(origin, "POST", "/corrections", { actor: "x" });
    assert.equal(res.status, 400);
    const payload = await res.json();
    assert.equal(payload.error, "bad_request");
  });
});
