import assert from "node:assert/strict";
import { test } from "node:test";

import { DomainError } from "../src/domain/errors.js";
import { EditorialService } from "../src/domain/service.js";
import { QueryService } from "../src/domain/queries.js";
import { Store } from "../src/domain/store.js";

function harness(): {
  store: Store;
  service: EditorialService;
  queries: QueryService;
  advance: (s: number) => void;
  now: () => string;
} {
  const base = Date.parse("2026-09-01T00:00:00Z");
  let offsetSec = 0;
  let calls = 0;
  const clock = () => new Date(base + (offsetSec + calls++) * 1000).toISOString();
  const store = Store.open(undefined, clock);
  const service = new EditorialService(store);
  const queries = new QueryService(store.data);
  return {
    store,
    service,
    queries,
    advance: (s: number) => {
      offsetSec += s;
    },
    now: clock,
  };
}

/** 登记展区/物种/两条引文/专家意见/两个事实，并在纸质展签和语音导览出版基线。 */
function seed(h: ReturnType<typeof harness>) {
  const { service } = h;
  service.registerZone({ actor: "admin", code: "A", name: "鸟类厅" });
  const zone = h.store.data.zones[0]!;
  service.registerTaxon({ actor: "admin", scientificName: "Pica pica", zoneIds: [zone.id] });
  const taxon = h.store.data.taxa[0]!;
  service.registerCitation({
    actor: "admin",
    key: "Chen2019",
    title: "中国喜鹊分布旧志",
    authors: "Chen",
    year: "2019",
  });
  service.registerCitation({
    actor: "admin",
    key: "Park2026",
    title: "喜鹊分类修订",
    authors: "Park",
    year: "2026",
  });
  const [oldCit, newCit] = h.store.data.citations;
  service.addExpertOpinion({
    actor: "editor",
    taxonId: taxon.id,
    expert: "李分类",
    discipline: "鸟类学",
    summary: "建议采用新学名与新分布，但部分同行仍有保留",
  });
  const opinion = h.store.data.opinions[0]!;
  service.defineFact({ actor: "admin", taxonId: taxon.id, kind: "scientific_name", key: "current_name" });
  service.defineFact({ actor: "admin", taxonId: taxon.id, kind: "distribution", key: "range" });
  const [nameFact, rangeFact] = h.store.data.facts;

  service.publishBaseline({
    actor: "admin",
    factId: nameFact!.id,
    channel: "gallery_label",
    text: "喜鹊 Pica pica",
    evidence: { citationIds: [oldCit!.id], expertOpinionIds: [] },
  });
  service.publishBaseline({
    actor: "admin",
    factId: rangeFact!.id,
    channel: "audio_guide",
    text: "分布于中国东部",
    evidence: { citationIds: [oldCit!.id], expertOpinionIds: [] },
  });
  return { zone, taxon, oldCit: oldCit!, newCit: newCit!, opinion, nameFact: nameFact!, rangeFact: rangeFact! };
}

test("完整工作流：候选更正→双学科审核→译文绑定版本→排期→到期出版，旧版可引用", () => {
  const h = harness();
  const s = seed(h);
  const { service, queries, advance } = h;

  const correction = service.createCorrection({
    actor: "editor-王",
    taxonId: s.taxon.id,
    factId: s.nameFact.id,
    channels: ["gallery_label", "online_catalog"],
    targetLanguages: ["en"],
    text: "东方喜鹊 Pica serica",
    rationale: "分类学专家通知学名修订",
    evidence: { citationIds: [s.newCit.id], expertOpinionIds: [s.opinion.id] },
  });
  assert.equal(correction.state, "draft");
  assert.equal(correction.draft.revision, 1);

  // 提交即冻结不可变版本，带内容哈希
  const submitted = service.submit(correction.id, { actor: "editor-王" });
  assert.equal(submitted.state, "reviewing");
  const frozenV1 = h.store.data.versions.find((v) => v.id === submitted.frozenVersionId)!;
  assert.ok(frozenV1.sourceHash.length === 64);

  // 只有学科同意还不够，状态仍为审核中
  let c = service.review(correction.id, {
    actor: "reviewer",
    type: "scientific",
    reviewer: "李分类",
    decision: "approved",
  });
  assert.equal(c.state, "reviewing");

  // 译文绑定具体冻结版本
  const tr = service.addTranslation(correction.id, {
    actor: "translator",
    translator: "张译",
    language: "en",
    text: "Oriental Magpie Pica serica",
  });
  assert.equal(tr.contentVersionId, frozenV1.id);
  assert.equal(tr.stale, false);
  service.reviewTranslation(tr.id, { actor: "reviewer", reviewer: "语言审校", decision: "approved" });

  c = service.review(correction.id, {
    actor: "reviewer",
    type: "language",
    reviewer: "语言审校",
    decision: "approved",
  });
  assert.equal(c.state, "approved");

  // 排期到未来时间（相对假时钟）
  const future = new Date(Date.parse(h.now()) + 60_000).toISOString();
  const scheduled = service.schedule(correction.id, { actor: "editor-王", publishAt: future });
  assert.equal(scheduled.state, "scheduled");
  assert.equal(scheduled.scheduledChannels?.length, 2);

  // 未到期不出版
  assert.deepEqual(service.publishDue("system"), []);
  // 看板能看到待审/待发差异与计划时间
  const board = queries.taxonBoard(s.taxon.id);
  const factView = board.facts.find((f) => f.fact.id === s.nameFact.id)!;
  assert.equal(factView.pendingCorrections[0]!.state, "scheduled");
  assert.equal(factView.pendingCorrections[0]!.scheduledPublishAt, future);
  assert.ok(factView.pendingCorrections[0]!.diff.textChanged);
  assert.deepEqual(factView.channels.map((x) => x.channel), ["gallery_label"]);

  // 到期出版：纸质展签旧版被取代但仍可引用，线上图录首次出版
  h.advance(61);
  const pubs = service.publishDue("system");
  assert.equal(pubs.length, 2);
  const labelPub = pubs.find((p) => p.channel === "gallery_label")!;
  assert.equal(labelPub.renderedText, "东方喜鹊 Pica serica");
  assert.equal(labelPub.origin, "correction");
  assert.ok(labelPub.translationIds.includes(tr.id));

  const oldLabel = h.store.data.publications.find(
    (p) => p.factId === s.nameFact.id && p.channel === "gallery_label" && p.status === "superseded",
  )!;
  assert.equal(oldLabel.renderedText, "喜鹊 Pica pica");
  assert.equal(oldLabel.supersededByPublicationId, labelPub.id);
});

test("退回修改后重新提交：旧批准失效、译文标过期，须重走审核", () => {
  const h = harness();
  const s = seed(h);
  const { service } = h;

  const correction = service.createCorrection({
    actor: "editor-王",
    taxonId: s.taxon.id,
    factId: s.nameFact.id,
    channels: ["gallery_label"],
    targetLanguages: ["en"],
    text: "东方喜鹊 Pica serica（暂定）",
    rationale: "学名修订，结论尚有争议",
    evidence: { citationIds: [s.newCit.id], expertOpinionIds: [s.opinion.id] },
  });
  service.submit(correction.id, { actor: "editor-王" });
  const tr = service.addTranslation(correction.id, {
    actor: "translator",
    translator: "张译",
    language: "en",
    text: "Oriental Magpie Pica serica (tentative)",
  });
  service.reviewTranslation(tr.id, { actor: "reviewer", reviewer: "语言审校", decision: "approved" });

  service.review(correction.id, {
    actor: "reviewer",
    type: "scientific",
    reviewer: "李分类",
    decision: "approved",
  });
  // 语言审校认为仍有争议，要求修改
  service.review(correction.id, {
    actor: "reviewer",
    type: "language",
    reviewer: "语言审校",
    decision: "changes_requested",
    comment: "争议结论措辞需弱化",
  });
  assert.equal(h.store.data.corrections[0]!.state, "draft");

  // 重新编辑（修订号 +1）并重新提交：新冻结版本哈希不同
  const updated = service.updateDraft(correction.id, {
    actor: "editor-王",
    expectedRevision: 1,
    text: "东方喜鹊 Pica serica（部分学者仍归入 Pica pica）",
  });
  assert.equal(updated.draft.revision, 2);
  service.submit(correction.id, { actor: "editor-王" });

  // 旧译文已过期，不能直接审核
  const staleTr = h.store.data.translations[0]!;
  assert.equal(staleTr.stale, true);
  assert.throws(
    () => service.reviewTranslation(staleTr.id, { actor: "r", reviewer: "x", decision: "approved" }),
    (e: Error) => e instanceof DomainError && e.code === "conflict",
  );
  // 修订译文后绑定到新源版本
  service.updateTranslation(staleTr.id, {
    actor: "translator",
    text: "Oriental Magpie Pica serica (some authorities retain Pica pica)",
  });
  service.reviewTranslation(staleTr.id, { actor: "reviewer", reviewer: "语言审校", decision: "approved" });

  // 旧的学科“同意”针对旧哈希，不再满足闸口：只补语言同意不会通过
  let c = service.review(correction.id, {
    actor: "reviewer",
    type: "language",
    reviewer: "语言审校",
    decision: "approved",
  });
  assert.equal(c.state, "reviewing");
  c = service.review(correction.id, {
    actor: "reviewer",
    type: "scientific",
    reviewer: "李分类",
    decision: "approved",
  });
  assert.equal(c.state, "approved");
});

test("过期草稿检测：多位编辑并发修改时后提交者收到 409", () => {
  const h = harness();
  const s = seed(h);
  const { service } = h;
  const correction = service.createCorrection({
    actor: "editor-王",
    taxonId: s.taxon.id,
    factId: s.nameFact.id,
    channels: ["gallery_label"],
    targetLanguages: [],
    text: "新文本",
    rationale: "r",
    evidence: { citationIds: [s.newCit.id], expertOpinionIds: [] },
  });
  service.updateDraft(correction.id, { actor: "editor-王", expectedRevision: 1, text: "编辑甲的版本" });
  assert.throws(
    () =>
      service.updateDraft(correction.id, {
        actor: "editor-赵",
        expectedRevision: 1,
        text: "编辑乙基于旧稿的版本",
      }),
    (e: Error) => e instanceof DomainError && e.status === 409,
  );
  // 乙基于最新修订号重试成功
  const ok = service.updateDraft(correction.id, {
    actor: "editor-赵",
    expectedRevision: 2,
    text: "编辑乙基于新稿的版本",
  });
  assert.equal(ok.draft.revision, 3);
});

test("来源撤回：已出版段落追加醒目标记且原文不变；在途候选被标红退回；不自动认可替代结论", () => {
  const h = harness();
  const s = seed(h);
  const { service, queries } = h;

  const correction = service.createCorrection({
    actor: "editor-王",
    taxonId: s.taxon.id,
    factId: s.nameFact.id,
    channels: ["gallery_label"],
    targetLanguages: [],
    text: "新学名说法",
    rationale: "依据旧文献的进一步整理",
    evidence: { citationIds: [s.oldCit.id], expertOpinionIds: [] },
  });
  service.submit(correction.id, { actor: "editor-王" });
  service.review(correction.id, { actor: "r", type: "scientific", reviewer: "李分类", decision: "approved" });

  const beforeText = h.store.data.publications[0]!.renderedText;
  service.markCitationRetracted(s.oldCit.id, { actor: "editor-王", note: "该志数据造假已撤回" });

  // 已出版：原文定格，只多了撤回标记
  const oldPub = h.store.data.publications[0]!;
  assert.equal(oldPub.renderedText, beforeText);
  assert.equal(oldPub.errata.length, 1);
  assert.equal(oldPub.errata[0]!.kind, "retraction_notice");
  assert.equal(oldPub.errata[0]!.citationId, s.oldCit.id);

  // 语音导览基线同样引用旧文献，也被追加标记
  const audioPub = h.store.data.publications.find((p) => p.channel === "audio_guide")!;
  assert.equal(audioPub.errata.length, 1);

  // 在途候选：退回草稿、标出受影响证据，但系统不生成替代文本
  const c = h.store.data.corrections[0]!;
  assert.equal(c.state, "draft");
  assert.deepEqual(c.evidenceFlags?.map((f) => f.citationId), [s.oldCit.id]);
  assert.equal(c.draft.text, "新学名说法");

  // 引文视图反映引用有效性：两处已出版段落都已挂撤回标记，在途候选被标红
  const view = queries.citation(s.oldCit.id);
  assert.equal(view.status, "retracted");
  assert.equal(view.usedByPublications.length, 2);
  assert.ok(view.usedByPublications.every((u) => u.noticeAppended));
  assert.equal(view.usedByCorrections.length, 1);
  assert.equal(view.usedByCorrections[0]!.flagged, true);

  // 带着撤回证据不能提交
  assert.throws(
    () => service.submit(correction.id, { actor: "editor-王" }),
    (e: Error) => e instanceof DomainError && e.code === "unprocessable",
  );
  // 编辑自主更换证据（而非系统塞结论）后才能继续
  service.updateDraft(correction.id, {
    actor: "editor-王",
    expectedRevision: 1,
    evidence: { citationIds: [s.newCit.id], expertOpinionIds: [] },
  });
  service.submit(correction.id, { actor: "editor-王" });
});

test("紧急勘误只能追加标记，不能改写已出版原文", () => {
  const h = harness();
  const s = seed(h);
  const { service } = h;
  const pub = h.store.data.publications[0]!;
  const erratum = service.appendErratum(pub.id, {
    actor: "duty-editor",
    message: "紧急：本展签命名信息将于本周更换，临时以本告示为准",
  });
  assert.equal(erratum.kind, "emergency_notice");
  const reloaded = h.store.data.publications.find((p) => p.id === pub.id)!;
  assert.equal(reloaded.renderedText, "喜鹊 Pica pica");
  assert.equal(reloaded.errata.length, 1);
  assert.equal(reloaded.errata[0]!.message, erratum.message);
});

test("译文闸口：目标语言缺少已审译文时不允许排期", () => {
  const h = harness();
  const s = seed(h);
  const { service } = h;
  const correction = service.createCorrection({
    actor: "editor-王",
    taxonId: s.taxon.id,
    factId: s.nameFact.id,
    channels: ["online_catalog"],
    targetLanguages: ["en", "ja"],
    text: "新文本",
    rationale: "r",
    evidence: { citationIds: [s.newCit.id], expertOpinionIds: [] },
  });
  service.submit(correction.id, { actor: "editor-王" });
  service.review(correction.id, { actor: "r", type: "scientific", reviewer: "李分类", decision: "approved" });
  service.review(correction.id, { actor: "r", type: "language", reviewer: "语言审校", decision: "approved" });
  assert.throws(
    () => service.schedule(correction.id, { actor: "editor-王", publishAt: new Date().toISOString() }),
    (e: Error) => e instanceof DomainError && e.status === 422,
  );
});

test("文字溯源：从任一出版文字可追溯全部学术决定与版本血缘", () => {
  const h = harness();
  const s = seed(h);
  const { service, queries, advance } = h;

  const correction = service.createCorrection({
    actor: "editor-王",
    taxonId: s.taxon.id,
    factId: s.nameFact.id,
    channels: ["gallery_label"],
    targetLanguages: [],
    text: "东方喜鹊 Pica serica",
    rationale: "修订",
    evidence: { citationIds: [s.newCit.id], expertOpinionIds: [] },
  });
  service.submit(correction.id, { actor: "editor-王" });
  service.review(correction.id, { actor: "r", type: "scientific", reviewer: "李分类", decision: "approved" });
  service.review(correction.id, { actor: "r", type: "language", reviewer: "语言审校", decision: "approved" });
  // 排期到“当前时刻之前”，立即可出版
  service.schedule(correction.id, {
    actor: "editor-王",
    publishAt: h.now(),
  });
  service.publishDue("system");

  // 用当前文字反查
  const report = queries.provenance({ text: "东方喜鹊 Pica serica" });
  assert.equal(report.matchedBy, "text");
  const types = report.timeline.map((e) => e.type);
  for (const expected of [
    "fact_defined",
    "correction_created",
    "content_version_frozen",
    "correction_submitted",
    "review_recorded",
    "publication_scheduled",
    "correction_published",
    "publication_superseded",
  ]) {
    assert.ok(types.includes(expected), `时间线缺少 ${expected}`);
  }
  // 血缘：基线版本与更正版本都在，且更正版本基底指向基线
  assert.ok(report.versionLineage.length >= 2);
  const correctionVersion = report.versionLineage.find((v) => v.origin === "correction")!;
  assert.ok(correctionVersion.baseVersionId);
  assert.equal(report.citations.some((c) => c.key === "Chen2019"), true);

  // 旧文字（已被取代）同样可追溯
  const oldReport = queries.provenance({ text: "喜鹊 Pica pica" });
  assert.ok(oldReport.publications.some((p) => p.status === "superseded"));
});

test("展区看板聚合物种、各渠道内容、待审差异、引用有效性与计划时间", () => {
  const h = harness();
  const s = seed(h);
  const { service, queries } = h;
  const correction = service.createCorrection({
    actor: "editor-王",
    taxonId: s.taxon.id,
    factId: s.rangeFact.id,
    channels: ["audio_guide"],
    targetLanguages: [],
    text: "分布于东亚",
    rationale: "分布修订",
    evidence: { citationIds: [s.newCit.id], expertOpinionIds: [] },
  });
  service.submit(correction.id, { actor: "editor-王" });

  const board = queries.zoneBoard(s.zone.id);
  assert.equal(board.taxa.length, 1);
  const rangeView = board.taxa[0]!.facts.find((f) => f.fact.id === s.rangeFact.id)!;
  assert.equal(rangeView.channels[0]!.channel, "audio_guide");
  assert.equal(rangeView.channels[0]!.errata.length, 0);
  assert.equal(rangeView.pendingCorrections[0]!.state, "reviewing");
  assert.equal(rangeView.pendingCorrections[0]!.reviews.find((r) => r.type === "scientific")!.satisfied, false);
  assert.ok(rangeView.citationValidity.some((c) => c.key === "Chen2019" && c.status === "valid"));
});

test("无证据的候选不能创建或提交", () => {
  const h = harness();
  const s = seed(h);
  const { service } = h;
  assert.throws(
    () =>
      service.createCorrection({
        actor: "editor-王",
        taxonId: s.taxon.id,
        factId: s.nameFact.id,
        channels: ["gallery_label"],
        targetLanguages: [],
        text: "x",
        rationale: "r",
        evidence: { citationIds: [], expertOpinionIds: [] },
      }),
    (e: Error) => e instanceof DomainError && e.code === "unprocessable",
  );
});
