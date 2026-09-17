import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { EditorialService } from "../src/domain/service.js";
import { InMemoryEventStore, JsonlEventStore, type Clock } from "../src/domain/store.js";
import { DomainError } from "../src/domain/errors.js";

/** 可控时钟：测试中自由推进“发布日期” */
function fakeClock(start = "2026-09-01T08:00:00.000Z"): Clock & { advance(ms: number): Date } {
  let now = new Date(start).getTime();
  const clock = (() => new Date(now)) as Clock & { advance(ms: number): Date };
  clock.advance = (ms: number) => {
    now += ms;
    return new Date(now);
  };
  return clock;
}

function catchDomainError(fn: () => unknown): DomainError {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof DomainError, `期望 DomainError，实际: ${String(error)}`);
    return error;
  }
  assert.fail("预期抛出 DomainError 但未抛出");
}

function setup() {
  const clock = fakeClock();
  const service = new EditorialService(new InMemoryEventStore(), clock);

  const { factId } = service.registerFact(
    {
      speciesCode: "AV-001",
      speciesName: "示例雀",
      exhibitZone: "鸟类厅 A 区",
      kind: "scientific_name",
      currentText: "旧学名：Avis vetus",
      note: "纸质展签现状",
    },
    null,
    "curator",
  );

  const registerVersion = (text: string, rationale = "分类学修订") => {
    const rev = service.revisionOf(factId);
    return service
      .proposeVersion(factId, { text, rationale }, rev, "editor-1")
      .versionId;
  };

  const approveScientific = (versionId: string, actor = "reviewer-birds") => {
    service.submitVersionReview(
      factId,
      { versionId, reviewType: "scientific", decision: "approved", comments: "与最新分类一致" },
      service.revisionOf(factId),
      actor,
    );
  };

  const addEnglishTranslation = (versionId: string, text: string) =>
    service.recordTranslation(
      factId,
      { versionId, language: "en", text, translator: "translator-a" },
      service.revisionOf(factId),
      "editor-1",
    ).translationId;

  const approveTranslation = (translationId: string) =>
    service.submitTranslationReview(
      factId,
      { translationId, decision: "approved", comments: "译文准确" },
      service.revisionOf(factId),
      "language-reviewer",
    );

  return { clock, service, factId, registerVersion, approveScientific, addEnglishTranslation, approveTranslation };
}

test("候选更正必须经过学科学审与语言审核后才能排期并在指定日期发布", () => {
  const t = setup();
  const { service, clock, factId } = t;

  const versionId = t.registerVersion("新学名：Avis novus", "IOC 2026 名录修订");
  const citation = service.registerCitation(
    { title: "IOC World Bird List 2026", authors: ["IOC"], year: 2026, doi: "10.0/ioc2026" },
    "editor-1",
  );
  service.linkCitation(factId, versionId, citation.citationId, service.revisionOf(factId), "editor-1");
  const translationId = t.addEnglishTranslation(versionId, "New name: Avis novus");

  const editionId = service.createEdition(
    factId,
    { channel: "gallery_label", versionId },
    service.revisionOf(factId),
    "editor-1",
  ).editionId;

  // 未过任何审核：排期被闸门拒绝
  const blocked = catchDomainError(() => service.scheduleEdition(
        factId,
        { editionId, publishAt: "2026-09-20T00:00:00.000Z" },
        service.revisionOf(factId),
        "editor-1",
      ));
  assert.equal(blocked.code, "schedule_gate_failed");
  assert.deepEqual((blocked.details as { blockers: string[] }).blockers.sort(), [
    "缺少学科学审",
    "语言 en 译文尚未通过语言审核",
  ].sort());

  t.approveScientific(versionId);
  // 只过学科学审仍不够：译文语言审核缺失
  const blocked2 = catchDomainError(() => service.scheduleEdition(
        factId,
        { editionId, publishAt: "2026-09-20T00:00:00.000Z" },
        service.revisionOf(factId),
        "editor-1",
      ));
  assert.ok(
    (blocked2.details as { blockers: string[] }).blockers.some((b) => b.includes("语言 en")),
  );

  t.approveTranslation(translationId);
  service.scheduleEdition(
    factId,
    { editionId, publishAt: "2026-09-20T00:00:00.000Z" },
    service.revisionOf(factId),
    "editor-1",
  );

  // 未到指定发布时间不能发布
  assert.throws(
    () => service.publishEdition(factId, { editionId }, service.revisionOf(factId), "publisher"),
    /尚未到指定发布时间/,
  );

  // 到达发布日期后发布
  clock.advance(20 * 24 * 3600 * 1000);
  service.publishEdition(factId, { editionId }, service.revisionOf(factId), "publisher");

  const view = service.getFact(factId);
  const edition = view.editions.find((e) => e.id === editionId)!;
  assert.equal(edition.status, "published");
  assert.equal(edition.snapshot?.versionText, "新学名：Avis novus");
  assert.deepEqual(edition.snapshot?.items.map((i) => i.language).sort(), ["en", "zh"]);
  assert.equal(edition.snapshot?.citations[0]?.citationId, citation.citationId);
});

test("学科学审驳回后，候选无法排期（仍有争议的结论不能提前发布）", () => {
  const t = setup();
  const { service, factId } = t;
  const versionId = t.registerVersion("新学名：Avis novus", "修订");
  service.submitVersionReview(
    factId,
    { versionId, reviewType: "scientific", decision: "rejected", comments: "证据不足，存在争议" },
    service.revisionOf(factId),
    "reviewer-birds",
  );
  const editionId = service.createEdition(
    factId,
    { channel: "online_catalog", versionId },
    service.revisionOf(factId),
    "editor-1",
  ).editionId;
  const error = catchDomainError(() => service.scheduleEdition(
        factId,
        { editionId, publishAt: "2030-01-01T00:00:00.000Z" },
        service.revisionOf(factId),
        "editor-1",
      ));
  assert.match((error.details as { blockers: string[] }).blockers.join(";"), /rejected/);
  assert.equal(service.getFact(factId).versions.find((v) => v.id === versionId)?.status, "rejected");
});

test("译文修订后，修订前的语言审核自动失效", () => {
  const t = setup();
  const { service, factId } = t;
  const versionId = t.registerVersion("分布：东亚");
  const translationId = t.addEnglishTranslation(versionId, "Range: East Aisa"); // 故意拼错
  t.approveTranslation(translationId);
  assert.equal(
    service.getFact(factId).versions[0]?.translations.find((x) => x.id === translationId)?.status,
    "approved",
  );

  service.reviseTranslation(
    factId,
    { translationId, text: "Range: East Asia" },
    service.revisionOf(factId),
    "translator-a",
  );
  // 修订后审核回到 pending，闸门重新拦截
  assert.equal(
    service.getFact(factId).versions[0]?.translations.find((x) => x.id === translationId)?.status,
    "pending",
  );
  const editionId = service.createEdition(
    factId,
    { channel: "audio_guide", versionId },
    service.revisionOf(factId),
    "editor-1",
  ).editionId;
  const error = catchDomainError(() => service.scheduleEdition(
        factId,
        { editionId, publishAt: "2030-01-01T00:00:00.000Z" },
        service.revisionOf(factId),
        "editor-1",
      ));
  assert.ok((error.details as { blockers: string[] }).blockers.some((b) => b.includes("语言 en")));
});

test("多编辑并发：基于过期版本提交被检测为过期草稿（412 stale_revision）", () => {
  const t = setup();
  const { service, factId } = t;
  const baseRevision = service.revisionOf(factId); // 0：仅登记事实后

  // 编辑 A 先提交候选，流版本推进
  service.proposeVersion(
    factId,
    { text: "候选 A", rationale: "依据 A" },
    baseRevision,
    "editor-a",
  );

  // 编辑 B 仍拿着旧版本号提交
  const error = catchDomainError(() => service.proposeVersion(
        factId,
        { text: "候选 B", rationale: "依据 B" },
        baseRevision,
        "editor-b",
      ));
  assert.equal(error.code, "stale_revision");

  // B 刷新后基于新版本提交成功
  const fresh = service.revisionOf(factId);
  const result = service.proposeVersion(
    factId,
    { text: "候选 B", rationale: "依据 B" },
    fresh,
    "editor-b",
  );
  assert.ok(result.revision > fresh);
});

test("来源撤回：标出受影响段落、阻止新排期，但不自动认可替代结论；已发布版本保持可引用，只能追加醒目标记", () => {
  const t = setup();
  const { service, clock, factId } = t;

  const versionId = t.registerVersion("新学名：Avis novus", "某 2025 论文");
  const citation = service.registerCitation(
    { title: "某分类学期刊论文", authors: ["某学者"], year: 2025 },
    "editor-1",
  );
  service.linkCitation(factId, versionId, citation.citationId, service.revisionOf(factId), "editor-1");
  t.approveScientific(versionId);
  const editionId = service.createEdition(
    factId,
    { channel: "gallery_label", versionId, items: [{ language: "zh" }] },
    service.revisionOf(factId),
    "editor-1",
  ).editionId;
  service.scheduleEdition(
    factId,
    { editionId, publishAt: "2026-09-10T00:00:00.000Z" },
    service.revisionOf(factId),
    "editor-1",
  );
  clock.advance(20 * 24 * 3600 * 1000);
  service.publishEdition(factId, { editionId }, service.revisionOf(factId), "publisher");

  // 来源撤回（引文是独立流，需要它自己的版本号）
  service.retractCitation(
    citation.citationId,
    { reason: "原始观察被证实为鉴定错误", noticeSource: "Retraction Watch 2026-09-15" },
    service.revisionOf(`citation:${citation.citationId}`),
    "librarian",
  );

  // 已发布原文与快照保持不变
  const afterRetraction = service.getFact(factId);
  const published = afterRetraction.editions.find((e) => e.id === editionId)!;
  assert.equal(published.status, "published");
  assert.equal(published.snapshot?.versionText, "新学名：Avis novus");

  // 只能追加醒目标记，不能修改原文
  const noticeId = service.appendClarification(
    factId,
    {
      editionId,
      kind: "retraction_notice",
      text: "本展签引用的来源已于 2026-09-15 撤回，结论待定；本标记不构成替代结论。",
      citationId: citation.citationId,
    },
    service.revisionOf(factId),
    "chief-editor",
  ).clarificationId;
  const marked = service.getFact(factId).editions.find((e) => e.id === editionId)!;
  assert.equal(marked.clarifications[0]?.id, noticeId);
  assert.equal(marked.clarifications[0]?.marker, "【来源撤回】");
  assert.deepEqual(marked.clarifications[0]?.affectedLanguages, ["zh"]);
  assert.equal(marked.snapshot?.versionText, "新学名：Avis novus"); // 原文纹丝不动

  // 草稿/已排期版面引用撤回证据时无法排期
  const v2 = service.proposeVersion(
    factId,
    { text: "另一候选学名：Avis alter", rationale: "另一篇论文" },
    service.revisionOf(factId),
    "editor-1",
  ).versionId;
  service.linkCitation(factId, v2, citation.citationId, service.revisionOf(factId), "editor-1");
  service.submitVersionReview(
    factId,
    { versionId: v2, reviewType: "scientific", decision: "approved" },
    service.revisionOf(factId),
    "reviewer-birds",
  );
  const edn2 = service.createEdition(
    factId,
    { channel: "online_catalog", versionId: v2, items: [{ language: "zh" }] },
    service.revisionOf(factId),
    "editor-1",
  ).editionId;
  const blocked = catchDomainError(() => service.scheduleEdition(
        factId,
        { editionId: edn2, publishAt: "2030-01-01T00:00:00.000Z" },
        service.revisionOf(factId),
        "editor-1",
      ));
  assert.ok((blocked.details as { blockers: string[] }).blockers.some((b) => b.includes("已撤回")));
});

test("紧急勘误只追加不改原文，且重复候选被拒绝", () => {
  const t = setup();
  const { service, clock, factId } = t;
  const versionId = t.registerVersion("分布：中国南方");
  t.approveScientific(versionId);
  const editionId = service.createEdition(
    factId,
    { channel: "printed_catalog", versionId, items: [{ language: "zh" }] },
    service.revisionOf(factId),
    "editor-1",
  ).editionId;
  service.scheduleEdition(
    factId,
    { editionId, publishAt: "2026-09-05T00:00:00.000Z" },
    service.revisionOf(factId),
    "editor-1",
  );
  clock.advance(10 * 24 * 3600 * 1000);
  service.publishEdition(factId, { editionId }, service.revisionOf(factId), "publisher");

  service.appendClarification(
    factId,
    { editionId, kind: "emergency_correction", text: "分布地“海南”应为“湖南”，下一版正式更正" },
    service.revisionOf(factId),
    "chief-editor",
  );
  const edition = service.getFact(factId).editions.find((e) => e.id === editionId)!;
  assert.equal(edition.clarifications[0]?.marker, "【紧急勘误】");
  assert.equal(edition.snapshot?.versionText, "分布：中国南方");

  // 逐字相同的候选不允许重复提案
  assert.throws(
    () =>
      service.proposeVersion(
        factId,
        { text: "分布：中国南方", rationale: "重复" },
        service.revisionOf(factId),
        "editor-2",
      ),
    /完全相同/,
  );
});

test("同渠道新版本发布后，旧版本进入 superseded 但快照仍可引用", () => {
  const t = setup();
  const { service, clock, factId } = t;

  const publishOne = (text: string) => {
    const versionId = t.registerVersion(text);
    t.approveScientific(versionId);
    const editionId = service.createEdition(
      factId,
      { channel: "gallery_label", versionId, items: [{ language: "zh" }] },
      service.revisionOf(factId),
      "editor-1",
    ).editionId;
    service.scheduleEdition(
      factId,
      { editionId, publishAt: new Date(clock().getTime() + 1000).toISOString() },
      service.revisionOf(factId),
      "editor-1",
    );
    clock.advance(2000);
    service.publishEdition(factId, { editionId }, service.revisionOf(factId), "publisher");
    return { versionId, editionId };
  };

  const first = publishOne("学名第一版");
  const second = publishOne("学名第二版");

  const view = service.getFact(factId);
  assert.equal(view.editions.find((e) => e.id === first.editionId)?.status, "superseded");
  assert.equal(view.editions.find((e) => e.id === second.editionId)?.status, "published");
  // 旧版快照仍在，仍可被引用
  assert.equal(
    view.editions.find((e) => e.id === first.editionId)?.snapshot?.versionText,
    "学名第一版",
  );
});

test("看板按物种/渠道显示当前发布、待审核差异、引文有效性与计划发布时间", () => {
  const t = setup();
  const { service, factId } = t;
  const versionId = t.registerVersion("新学名：Avis novus");

  const board = service.board({ speciesCode: "AV-001" });
  const row = board.facts.find((f) => f.factId === factId)!;
  assert.equal(row.currentPublished.length, 0);
  const pending = row.pendingDiffs.find((d) => d.versionId === versionId)!;
  assert.equal(pending.status, "candidate");
  assert.equal(pending.channel, null); // 尚未进入任何渠道版面
  assert.equal(pending.diff.publishedText, null);

  // 引文报告显示证据与撤回状态
  const citation = service.registerCitation(
    { title: "证据文献", authors: ["X"], year: 2024 },
    "editor-1",
  );
  service.linkCitation(factId, versionId, citation.citationId, service.revisionOf(factId), "editor-1");
  const report = service.citationReport(citation.citationId);
  assert.equal(report.citations[0]?.retracted, false);
  assert.equal(report.citations[0]?.usedBy[0]?.versionId, versionId);
});

test("文字溯源：从任一面板文字可追溯它经历的全部学术决定", () => {
  const t = setup();
  const { service, clock, factId } = t;
  const versionId = t.registerVersion("新学名：Avis novus", "IOC 2026");
  const citation = service.registerCitation(
    { title: "IOC 2026", authors: ["IOC"], year: 2026 },
    "editor-1",
  );
  service.linkCitation(factId, versionId, citation.citationId, service.revisionOf(factId), "editor-1");
  service.recordOpinion(
    factId,
    {
      versionId,
      expert: "异议学者",
      affiliation: "某大学",
      stance: "dissenting",
      content: "该修订在东亚种群上仍有争议",
    },
    service.revisionOf(factId),
    "editor-1",
  );
  t.approveScientific(versionId);
  const translationId = t.addEnglishTranslation(versionId, "New name: Avis novus");
  t.approveTranslation(translationId);
  const editionId = service.createEdition(
    factId,
    { channel: "online_catalog", versionId },
    service.revisionOf(factId),
    "editor-1",
  ).editionId;
  service.scheduleEdition(
    factId,
    { editionId, publishAt: new Date(clock().getTime() + 1000).toISOString() },
    service.revisionOf(factId),
    "editor-1",
  );
  clock.advance(2000);
  service.publishEdition(factId, { editionId }, service.revisionOf(factId), "publisher");
  service.appendClarification(
    factId,
    { editionId, kind: "editorial_notice", text: "命名人拼写以本版为准" },
    service.revisionOf(factId),
    "chief-editor",
  );

  const traced = service.trace({ text: "Avis novus" });
  const match = traced.matches.find((m) => m.editionId === editionId)!;
  const kinds = match.lineage.map((l) => l.step as string);
  assert.ok(kinds.includes("proposal"));
  assert.ok(kinds.includes("evidence"));
  assert.ok(kinds.includes("expert_opinion")); // 异议意见保留在溯源链上
  assert.ok(kinds.includes("review"));
  assert.ok(kinds.includes("translation"));
  assert.ok(kinds.includes("edition"));
  assert.ok(kinds.includes("clarification"));

  // 按译文 id 也可溯源
  const byTranslation = service.trace({ translationId });
  assert.ok(byTranslation.matches.some((m) => m.editionId === editionId));
});

test("JSONL 事件日志：重启后状态完整恢复（已发布版本与溯源不丢）", () => {
  const dir = mkdtempSync(join(tmpdir(), "label-events-"));
  try {
    const file = join(dir, "events.jsonl");
    const clock = fakeClock();
    const store1 = new JsonlEventStore(file, clock);
    const service1 = new EditorialService(store1, clock);
    const { factId } = service1.registerFact(
      {
        speciesCode: "AV-002",
        speciesName: "复原雀",
        exhibitZone: "鸟类厅 B 区",
        kind: "distribution",
        currentText: "旧分布",
      },
      null,
      "curator",
    );
    const { versionId } = service1.proposeVersion(
      factId,
      { text: "新分布", rationale: "新调查" },
      service1.revisionOf(factId),
      "editor-1",
    );
    service1.submitVersionReview(
      factId,
      { versionId, reviewType: "scientific", decision: "approved" },
      service1.revisionOf(factId),
      "reviewer",
    );
    const editionId = service1.createEdition(
      factId,
      { channel: "gallery_label", versionId, items: [{ language: "zh" }] },
      service1.revisionOf(factId),
      "editor-1",
    ).editionId;
    service1.scheduleEdition(
      factId,
      { editionId, publishAt: new Date(clock().getTime() + 1000).toISOString() },
      service1.revisionOf(factId),
      "editor-1",
    );
    clock.advance(2000);
    service1.publishEdition(factId, { editionId }, service1.revisionOf(factId), "publisher");
    assert.ok(existsSync(file));

    // 重启：新存储实例从日志水合
    const service2 = new EditorialService(new JsonlEventStore(file, clock), clock);
    const view = service2.getFact(factId);
    assert.equal(view.speciesName, "复原雀");
    assert.equal(view.editions[0]?.status, "published");
    assert.equal(view.editions[0]?.snapshot?.versionText, "新分布");
    assert.equal(service2.revisionOf(factId), service1.revisionOf(factId));

    // 水合后乐观锁仍然有效：旧版本号提交失败
    assert.throws(
      () =>
        service2.proposeVersion(
          factId,
          { text: "第三版", rationale: "x" },
          0,
          "editor-late",
        ),
      (e: unknown) => e instanceof DomainError && e.code === "stale_revision",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
