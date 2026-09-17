import { createHash } from "node:crypto";

import {
  CHANNELS,
  CLARIFICATION_KINDS,
  EXPERT_STANCES,
  FACT_KINDS,
  REVIEW_DECISIONS,
  REVIEW_TYPES,
  type Channel,
  type ExpertStance,
  type FactKind,
  type ReviewDecision,
  type ReviewType,
} from "./constants.js";
import {
  DomainError,
  conflict,
  notFound,
  validation,
} from "./errors.js";
import type {
  EventData,
  PublishedSnapshotItem,
  StoredEvent,
} from "./events.js";
import { newId } from "./ids.js";
import {
  latestDecision,
  project,
  translationReviews,
  translationStatus,
  versionStatus,
  type Citation,
  type Clarification,
  type Edition,
  type Fact,
  type FactVersion,
  type ProjectionState,
  type Review,
  type Translation,
} from "./projection.js";
import { type Clock, type EventStore, systemClock } from "./store.js";

const LANGUAGE_RE = /^[a-z]{2,3}(-[a-z0-9]+)*$/;

export interface Actor {
  actor: string;
}

function hashContent(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function requireEnum<T extends string>(value: string, allowed: readonly T[], label: string): T {
  if (!allowed.includes(value as T)) {
    validation(`${label} 必须是 ${allowed.join(" / ")} 之一，收到: ${value}`);
  }
  return value as T;
}

function requireNonEmpty(value: string, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    validation(`${label} 不能为空`);
  }
  return value;
}

function parseDate(value: string, label: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) validation(`${label} 不是合法时间: ${value}`);
  return date;
}

export interface RegisterFactInput {
  speciesCode: string;
  speciesName: string;
  exhibitZone: string;
  kind: FactKind;
  currentText: string;
  note?: string;
  /** 事实原文语言（译文的源语言），默认 zh */
  language?: string;
}

export interface ProposeVersionInput {
  text: string;
  rationale: string;
  basedOnVersionId?: string | null;
}

export interface RegisterCitationInput {
  doi?: string | null;
  title: string;
  authors: string[];
  year: number;
  url?: string | null;
}

export interface RecordTranslationInput {
  versionId: string;
  language: string;
  text: string;
  translator: string;
}

export interface EditionItemInput {
  language: string;
  /** 该语言段落使用的译文 id；原文段落留空 */
  translationId?: string | null;
  /** 缺省时由版本原文或当前译文自动填充；提供时必须与源文本一致 */
  text?: string;
}

export interface CreateEditionInput {
  channel: Channel;
  versionId: string;
  items?: EditionItemInput[];
  note?: string;
  requiresLegal?: boolean;
}

export interface UpdateEditionInput {
  editionId: string;
  versionId?: string;
  items?: EditionItemInput[];
  note?: string;
}

/** 事实视图中的版本（含状态、审核结论、引文有效性） */
export interface VersionView {
  id: string;
  sequence: number;
  basedOnVersionId: string | null;
  text: string;
  rationale: string;
  contentHash: string;
  status: string;
  reviews: Review[];
  citations: Array<{
    citationId: string;
    title: string;
    doi: string | null;
    retracted: boolean;
    retraction: Citation["retracted"];
  }>;
  hasRetractedCitation: boolean;
  /** 针对该版本记录的异议专家意见数（争议预警，不阻断但需可见） */
  dissentingOpinionCount: number;
  translations: Array<Translation & { status: string }>;
}

export interface EditionView extends Edition {
  blockedReasons: string[];
}

export interface FactView {
  id: string;
  speciesCode: string;
  speciesName: string;
  exhibitZone: string;
  kind: string;
  language: string;
  currentText: string;
  note: string;
  registeredAt: string;
  revision: number;
  versions: VersionView[];
  opinions: Fact["opinions"];
  editions: EditionView[];
}

export class EditorialService {
  constructor(
    private readonly store: EventStore,
    private readonly clock: Clock = systemClock,
  ) {}

  // ---------- 内部工具 ----------

  private state(): ProjectionState {
    return project(this.store.readAll());
  }

  private fact(state: ProjectionState, factId: string): Fact {
    const fact = state.facts.get(factId);
    if (!fact) notFound("事实", factId);
    return fact;
  }

  private citation(state: ProjectionState, citationId: string): Citation {
    const citation = state.citations.get(citationId);
    if (!citation) notFound("引文", citationId);
    return citation;
  }

  private version(fact: Fact, versionId: string): FactVersion {
    const version = fact.versions.get(versionId);
    if (!version) notFound("候选版本", versionId);
    return version;
  }

  private edition(fact: Fact, editionId: string): Edition {
    const edition = fact.editions.get(editionId);
    if (!edition) notFound("版面", editionId);
    return edition;
  }

  private append(
    streamId: string,
    expectedRevision: number | null,
    events: EventData[],
    actor: string,
  ): StoredEvent[] {
    return this.store.append({ streamId, expectedRevision, events, actor });
  }

  // ---------- 事实与候选更正 ----------

  /** 登记一条科学事实（纸质展签当前在用内容）。新流期望版本号为 0。 */
  registerFact(input: RegisterFactInput, expectedRevision: number | null, actor: string): {
    factId: string;
    revision: number;
  } {
    const speciesCode = requireNonEmpty(input.speciesCode, "物种代码");
    const speciesName = requireNonEmpty(input.speciesName, "物种名称");
    const exhibitZone = requireNonEmpty(input.exhibitZone, "展区");
    const kind = requireEnum(input.kind, FACT_KINDS, "事实类型");
    const currentText = requireNonEmpty(input.currentText, "当前文本");
    const language = input.language ?? "zh";
    if (!LANGUAGE_RE.test(language)) validation(`原文语言代码不合法: ${language}`);

    const factId = newId("fact");
    this.append(factId, expectedRevision, [
      {
        type: "FactRegistered",
        factId,
        speciesCode,
        speciesName,
        exhibitZone,
        kind,
        currentText,
        note: input.note?.trim() ? input.note.trim() : "",
        language,
      },
    ], actor);
    return { factId, revision: this.store.revisionOf(factId) };
  }

  /**
   * 提出带证据的候选更正（新候选版本）。
   * 必须给出依据；与任一既有候选文字完全相同的重复提案将被拒绝。
   * 候选不会直接覆盖当前发布内容——它要先过学科学审（及按需法定审核）。
   */
  proposeVersion(
    factId: string,
    input: ProposeVersionInput,
    expectedRevision: number,
    actor: string,
  ): { versionId: string; revision: number } {
    const state = this.state();
    const fact = this.fact(state, factId);
    const text = requireNonEmpty(input.text, "候选文本");
    const rationale = requireNonEmpty(input.rationale, "更正依据");
    if (input.basedOnVersionId && !fact.versions.has(input.basedOnVersionId)) {
      notFound("所基于的候选版本", input.basedOnVersionId);
    }
    const contentHash = hashContent(text);
    for (const existing of fact.versions.values()) {
      if (existing.contentHash === contentHash) {
        conflict(`候选文本与既有版本 ${existing.id} 完全相同，无需重复提案`, {
          duplicateOf: existing.id,
        });
      }
    }

    const versionId = newId("ver");
    const replacesPublished = [...fact.editions.values()].some((e) => e.status === "published");
    this.append(factId, expectedRevision, [
      {
        type: "FactVersionProposed",
        factId,
        versionId,
        basedOnVersionId: input.basedOnVersionId ?? null,
        proposalId: null,
        text,
        rationale,
        contentHash,
        replacesPublished,
      },
    ], actor);
    return { versionId, revision: this.store.revisionOf(factId) };
  }

  // ---------- 引文（证据）与撤回 ----------

  registerCitation(input: RegisterCitationInput, actor: string): {
    citationId: string;
    revision: number;
  } {
    const title = requireNonEmpty(input.title, "文献标题");
    if (!Array.isArray(input.authors) || input.authors.length === 0) {
      validation("作者列表至少包含一位作者");
    }
    const authors = input.authors.map((a) => requireNonEmpty(a, "作者姓名"));
    const year = input.year;
    if (!Number.isInteger(year) || year < 1500 || year > this.clock().getFullYear() + 1) {
      validation(`出版年份不合法: ${String(year)}`);
    }
    const citationId = newId("cite");
    const streamId = `citation:${citationId}`;
    this.append(streamId, null, [
      {
        type: "CitationRegistered",
        citationId,
        doi: input.doi?.trim() || null,
        title,
        authors,
        year,
        url: input.url?.trim() || null,
      },
    ], actor);
    return { citationId, revision: this.store.revisionOf(streamId) };
  }

  linkCitation(
    factId: string,
    versionId: string,
    citationId: string,
    expectedRevision: number,
    actor: string,
  ): { revision: number } {
    const state = this.state();
    const fact = this.fact(state, factId);
    this.version(fact, versionId);
    this.citation(state, citationId);
    this.append(factId, expectedRevision, [
      { type: "CitationLinked", factId, versionId, citationId },
    ], actor);
    return { revision: this.store.revisionOf(factId) };
  }

  /**
   * 标记来源撤回。只追加撤回事件，不改动任何已发布原文，
   * 也不自动认可任何替代结论；受影响段落由查询/报告标出。
   */
  retractCitation(
    citationId: string,
    input: { reason: string; noticeSource: string; retractedAt?: string },
    expectedRevision: number,
    actor: string,
  ): { revision: number } {
    const state = this.state();
    const citation = this.citation(state, citationId);
    if (citation.retracted) conflict(`引文 ${citationId} 已标记撤回，不能重复标记`);
    const reason = requireNonEmpty(input.reason, "撤回原因");
    const noticeSource = requireNonEmpty(input.noticeSource, "撤回通知来源");
    const retractedAt = (input.retractedAt ?? this.clock().toISOString()).toString();
    parseDate(retractedAt, "撤回时间");

    const streamId = `citation:${citationId}`;
    this.append(streamId, expectedRevision, [
      { type: "CitationRetracted", citationId, retractedAt, reason, noticeSource },
    ], actor);
    return { revision: this.store.revisionOf(streamId) };
  }

  // ---------- 专家意见 ----------

  recordOpinion(
    factId: string,
    input: {
      versionId?: string | null;
      expert: string;
      affiliation: string;
      stance: ExpertStance;
      content: string;
    },
    expectedRevision: number,
    actor: string,
  ): { opinionId: string; revision: number } {
    const state = this.state();
    const fact = this.fact(state, factId);
    if (input.versionId) this.version(fact, input.versionId);
    const stance = requireEnum(input.stance, EXPERT_STANCES, "专家立场");
    const expert = requireNonEmpty(input.expert, "专家姓名");
    const affiliation = requireNonEmpty(input.affiliation, "所属机构");
    const content = requireNonEmpty(input.content, "意见内容");

    const opinionId = newId("opn");
    this.append(factId, expectedRevision, [
      {
        type: "ExpertOpinionRecorded",
        opinionId,
        factId,
        versionId: input.versionId ?? null,
        expert,
        affiliation,
        stance,
        content,
      },
    ], actor);
    return { opinionId, revision: this.store.revisionOf(factId) };
  }

  // ---------- 学科 / 法定审核 ----------

  submitVersionReview(
    factId: string,
    input: {
      versionId: string;
      reviewType: ReviewType;
      decision: ReviewDecision;
      comments?: string;
    },
    expectedRevision: number,
    actor: string,
  ): { reviewId: string; revision: number; round: number } {
    const state = this.state();
    const fact = this.fact(state, factId);
    const version = this.version(fact, input.versionId);
    const reviewType = requireEnum(input.reviewType, REVIEW_TYPES, "审核类型");
    if (reviewType === "language") {
      validation("语言审核针对译文提交，请使用 submitTranslationReview");
    }
    const decision = requireEnum(input.decision, REVIEW_DECISIONS, "审核决定");
    const round = version.reviews.filter(
      (r) => r.targetType === "version" && r.reviewType === reviewType,
    ).length + 1;

    const reviewId = newId("rev");
    this.append(factId, expectedRevision, [
      {
        type: "ReviewSubmitted",
        reviewId,
        factId,
        targetType: "version",
        targetId: input.versionId,
        reviewType,
        reviewer: actor,
        decision,
        comments: input.comments ?? "",
        round,
        targetTextRevision: null,
      },
    ], actor);
    return { reviewId, revision: this.store.revisionOf(factId), round };
  }

  // ---------- 译文（绑定具体源版本） ----------

  recordTranslation(
    factId: string,
    input: RecordTranslationInput,
    expectedRevision: number,
    actor: string,
  ): { translationId: string; revision: number } {
    const state = this.state();
    const fact = this.fact(state, factId);
    this.version(fact, input.versionId);
    if (!LANGUAGE_RE.test(input.language)) validation(`语言代码不合法: ${input.language}`);
    if (input.language === fact.language) {
      validation(`语言 ${input.language} 是原文语言，原文随候选版本进入版面，不需要译文`);
    }
    const text = requireNonEmpty(input.text, "译文文本");
    const translator = requireNonEmpty(input.translator, "译者");
    for (const t of fact.translations.values()) {
      if (t.sourceVersionId === input.versionId && t.language === input.language) {
        conflict(`版本 ${input.versionId} 的 ${input.language} 译文已存在（${t.id}），请改用修订`);
      }
    }

    const translationId = newId("trl");
    this.append(factId, expectedRevision, [
      {
        type: "TranslationRecorded",
        translationId,
        factId,
        sourceVersionId: input.versionId,
        language: input.language,
        text,
        translator,
      },
    ], actor);
    return { translationId, revision: this.store.revisionOf(factId) };
  }

  reviseTranslation(
    factId: string,
    input: { translationId: string; text: string },
    expectedRevision: number,
    actor: string,
  ): { revision: number } {
    const state = this.state();
    const fact = this.fact(state, factId);
    const translation = fact.translations.get(input.translationId);
    if (!translation) notFound("译文", input.translationId);
    const text = requireNonEmpty(input.text, "译文文本");
    if (text === translation.text) conflict("修订文本与当前译文完全相同");

    this.append(factId, expectedRevision, [
      { type: "TranslationRevised", translationId: translation.id, factId, text },
    ], actor);
    return { revision: this.store.revisionOf(factId) };
  }

  /** 语言审核。译文一旦修订，修订前的语言审核自动失效（按时间判定）。 */
  submitTranslationReview(
    factId: string,
    input: { translationId: string; decision: ReviewDecision; comments?: string },
    expectedRevision: number,
    actor: string,
  ): { reviewId: string; revision: number; round: number } {
    const state = this.state();
    const fact = this.fact(state, factId);
    const translation = fact.translations.get(input.translationId);
    if (!translation) notFound("译文", input.translationId);
    const decision = requireEnum(input.decision, REVIEW_DECISIONS, "审核决定");
    const round = translationReviews(fact, translation).length + 1;

    const reviewId = newId("rev");
    this.append(factId, expectedRevision, [
      {
        type: "ReviewSubmitted",
        reviewId,
        factId,
        targetType: "translation",
        targetId: translation.id,
        reviewType: "language",
        reviewer: actor,
        decision,
        comments: input.comments ?? "",
        round,
        targetTextRevision: translation.textRevision,
      },
    ], actor);
    return { reviewId, revision: this.store.revisionOf(factId), round };
  }

  // ---------- 各渠道版面 ----------

  /** 依据版本与译文装配某渠道版面的多语言段落，文字必须与源版本/译文逐字一致 */
  private resolveItems(
    fact: Fact,
    version: FactVersion,
    state: ProjectionState,
    rawItems?: EditionItemInput[],
  ): PublishedSnapshotItem[] {
    const originalLanguage = factLanguage(fact);
    const items: EditionItemInput[] =
      rawItems ?? [{ language: originalLanguage }, ...[...fact.translations.values()]
        .filter((t) => t.sourceVersionId === version.id)
        .map((t) => ({ language: t.language, translationId: t.id }))];

    const seen = new Set<string>();
    return items.map((item) => {
      if (!LANGUAGE_RE.test(item.language)) validation(`语言代码不合法: ${item.language}`);
      if (seen.has(item.language)) conflict(`版面中语言 ${item.language} 出现重复段落`);
      seen.add(item.language);

      if (item.language === originalLanguage) {
        if (item.translationId) validation("原文段落不应绑定译文");
        if (item.text !== undefined && item.text !== version.text) {
          validation("原文段落文字必须与候选版本逐字一致，不能在版面环节改写");
        }
        return { language: item.language, text: version.text, translationId: null, translator: null };
      }

      const translation = item.translationId
        ? fact.translations.get(item.translationId)
        : [...fact.translations.values()].find(
            (t) => t.sourceVersionId === version.id && t.language === item.language,
          );
      if (!translation || translation.sourceVersionId !== version.id) {
        validation(`语言 ${item.language} 缺少绑定到版本 ${version.id} 的译文`);
      }
      if (item.text !== undefined && item.text !== translation.text) {
        validation(`语言 ${item.language} 段落文字必须与当前译文逐字一致`);
      }
      return {
        language: item.language,
        text: translation.text,
        translationId: translation.id,
        translator: translation.translator,
      };
    });
  }

  createEdition(
    factId: string,
    input: CreateEditionInput,
    expectedRevision: number,
    actor: string,
  ): { editionId: string; revision: number } {
    const state = this.state();
    const fact = this.fact(state, factId);
    const channel = requireEnum(input.channel, CHANNELS, "发布渠道");
    const version = this.version(fact, input.versionId);
    const active = [...fact.editions.values()].find(
      (e) => e.channel === channel && (e.status === "draft" || e.status === "scheduled"),
    );
    if (active) conflict(`渠道 ${channel} 已存在未结版面 ${active.id}，请先处理`);
    const items = this.resolveItems(fact, version, state, input.items);

    const editionId = newId("edn");
    this.append(factId, expectedRevision, [
      {
        type: "EditionCreated",
        editionId,
        factId,
        channel,
        versionId: version.id,
        items,
        note: input.note ?? "",
        requiresLegal: input.requiresLegal ?? false,
      },
    ], actor);
    return { editionId, revision: this.store.revisionOf(factId) };
  }

  updateEditionDraft(
    factId: string,
    input: UpdateEditionInput,
    expectedRevision: number,
    actor: string,
  ): { revision: number } {
    const state = this.state();
    const fact = this.fact(state, factId);
    const edition = this.edition(fact, input.editionId);
    if (edition.status !== "draft") conflict("只有草稿版面可以修改");
    const versionId = input.versionId ?? edition.versionId;
    const version = this.version(fact, versionId);
    const items = this.resolveItems(fact, version, state, input.items ?? edition.items);

    this.append(factId, expectedRevision, [
      {
        type: "EditionDraftUpdated",
        editionId: edition.id,
        factId,
        versionId,
        items,
        note: input.note ?? edition.note,
      },
    ], actor);
    return { revision: this.store.revisionOf(factId) };
  }

  /**
   * 排期闸门：学科（+按需法定）审核全部通过、版面内全部译文语言审核通过、
   * 且无已撤回引文。争议未定的结论进不了指定发布日期。
   */
  private scheduleBlockers(
    state: ProjectionState,
    fact: Fact,
    edition: Edition,
  ): string[] {
    const version = this.version(fact, edition.versionId);
    const blockers: string[] = [];
    const status = versionStatus(fact, version, edition.requiresLegal);
    if (status !== "approved") {
      // versionStatus 已驳回时提前给出结论；否则逐项指出缺哪一道审核
      const scientific = latestDecision(version.reviews, "scientific");
      if (!scientific) blockers.push("缺少学科学审");
      else if (scientific.decision !== "approved") blockers.push(`学科学审结论为 ${scientific.decision}`);
      if (edition.requiresLegal) {
        const legal = latestDecision(version.reviews, "legal");
        if (!legal) blockers.push("缺少法定审核");
        else if (legal.decision !== "approved") blockers.push(`法定审核结论为 ${legal.decision}`);
      }
    }
    for (const item of edition.items) {
      if (item.language === fact.language) {
        if (item.text !== version.text) {
          blockers.push(`原文段落文字落后于候选版本，请更新版面草稿（${item.language}）`);
        }
        continue;
      }
      if (!item.translationId) {
        blockers.push(`语言 ${item.language} 缺少绑定的译文`);
        continue;
      }
      const translation = fact.translations.get(item.translationId);
      if (!translation) {
        blockers.push(`语言 ${item.language} 的译文已不存在`);
        continue;
      }
      if (translation.sourceVersionId !== edition.versionId) {
        blockers.push(`语言 ${item.language} 译文绑定的不是版面候选版本`);
      }
      if (item.text !== translation.text) {
        blockers.push(`语言 ${item.language} 段落文字落后于最新译文，请更新版面草稿`);
      }
      if (translationStatus(fact, translation) !== "approved") {
        blockers.push(`语言 ${item.language} 译文尚未通过语言审核`);
      }
    }
    for (const citationId of version.citationIds) {
      const citation = state.citations.get(citationId);
      if (citation?.retracted) blockers.push(`引文 ${citationId}（${citation.title}）已撤回`);
    }
    return blockers;
  }

  scheduleEdition(
    factId: string,
    input: { editionId: string; publishAt: string },
    expectedRevision: number,
    actor: string,
  ): { revision: number } {
    const state = this.state();
    const fact = this.fact(state, factId);
    const edition = this.edition(fact, input.editionId);
    if (edition.status !== "draft" && edition.status !== "scheduled") {
      conflict("只有草稿或已排期版面可以排期");
    }
    const publishAt = parseDate(input.publishAt, "发布时间");
    if (publishAt.getTime() <= this.clock().getTime()) {
      validation("指定发布时间必须晚于当前时间");
    }
    const blockers = this.scheduleBlockers(state, fact, edition);
    if (blockers.length > 0) {
      throw new DomainError("schedule_gate_failed", "版面尚未满足排期条件", { blockers });
    }

    this.append(factId, expectedRevision, [
      {
        type: "EditionScheduled",
        editionId: edition.id,
        factId,
        publishAt: publishAt.toISOString(),
      },
    ], actor);
    return { revision: this.store.revisionOf(factId) };
  }

  /** 到指定发布日期后发布；再次校验闸门并冻结快照，已发布原文此后不可变 */
  publishEdition(
    factId: string,
    input: { editionId: string },
    expectedRevision: number,
    actor: string,
    opts: { force?: boolean } = {},
  ): { revision: number; publishedAt: string } {
    const state = this.state();
    const fact = this.fact(state, factId);
    const edition = this.edition(fact, input.editionId);
    if (edition.status !== "scheduled") conflict("只有已排期版面可以发布");
    if (!opts.force && edition.scheduledAt && new Date(edition.scheduledAt).getTime() > this.clock().getTime()) {
      conflict(`尚未到指定发布时间 ${edition.scheduledAt}`);
    }
    const blockers = this.scheduleBlockers(state, fact, edition);
    if (blockers.length > 0) {
      throw new DomainError("approval_gate_failed", "版面在发布前失去放行条件", { blockers });
    }
    const version = this.version(fact, edition.versionId);

    this.append(factId, expectedRevision, [
      {
        type: "EditionPublished",
        editionId: edition.id,
        factId,
        channel: edition.channel,
        versionId: version.id,
        items: edition.items,
        snapshot: {
          versionText: version.text,
          items: edition.items,
          citations: version.citationIds.map((id) => {
            const c = state.citations.get(id);
            return {
              citationId: id,
              title: c?.title ?? "(已删除引文记录)",
              doi: c?.doi ?? null,
            };
          }),
        },
      },
    ], actor);
    return {
      revision: this.store.revisionOf(factId),
      publishedAt: this.clock().toISOString(),
    };
  }

  cancelEdition(
    factId: string,
    input: { editionId: string; reason: string },
    expectedRevision: number,
    actor: string,
  ): { revision: number } {
    const state = this.state();
    const fact = this.fact(state, factId);
    const edition = this.edition(fact, input.editionId);
    if (edition.status !== "draft" && edition.status !== "scheduled") {
      conflict("只有草稿或已排期版面可以取消");
    }
    this.append(factId, expectedRevision, [
      { type: "EditionCancelled", editionId: edition.id, factId, reason: input.reason },
    ], actor);
    return { revision: this.store.revisionOf(factId) };
  }

  // ---------- 紧急勘误 / 撤回标记：只追加，不改原文 ----------

  appendClarification(
    factId: string,
    input: {
      editionId: string;
      kind: Clarification["kind"];
      text: string;
      marker?: string;
      citationId?: string | null;
    },
    expectedRevision: number,
    actor: string,
  ): { clarificationId: string; revision: number } {
    const state = this.state();
    const fact = this.fact(state, factId);
    const edition = this.edition(fact, input.editionId);
    if (edition.status !== "published") {
      conflict("醒目标记只能追加到已发布版面（原文不可改写，只能附加说明）");
    }
    const text = requireNonEmpty(input.text, "标记内容");
    const defaultMarkers: Record<Clarification["kind"], string> = {
      emergency_correction: "【紧急勘误】",
      retraction_notice: "【来源撤回】",
      editorial_notice: "【编辑部说明】",
    };
    const kind = requireEnum(input.kind, CLARIFICATION_KINDS, "标记类型");
    const citationId = input.citationId ?? null;
    if (kind === "retraction_notice") {
      if (!citationId) validation("撤回标记必须指明引文 id");
      const citation = this.citation(state, citationId);
      if (!citation.retracted) conflict(`引文 ${citationId} 尚未被标记撤回`);
      if (!edition.snapshot?.citations.some((c) => c.citationId === citationId)) {
        conflict(`该版面发布快照中未引用引文 ${citationId}`);
      }
    }
    // 受影响段落：撤回针对的是版本证据，派生的各语言段落全部标出
    const affectedLanguages = edition.snapshot?.items.map((i) => i.language) ?? [];

    const clarificationId = newId("ntc");
    this.append(factId, expectedRevision, [
      {
        type: "ClarificationAppended",
        clarificationId,
        editionId: edition.id,
        factId,
        kind,
        text,
        marker: input.marker ?? defaultMarkers[kind],
        citationId,
        affectedLanguages,
      },
    ], actor);
    return { clarificationId, revision: this.store.revisionOf(factId) };
  }

  // ---------- 查询 ----------

  revisionOf(factId: string): number {
    return this.store.revisionOf(factId);
  }

  getFact(factId: string): FactView {
    const state = this.state();
    const fact = this.fact(state, factId);
    return this.factView(state, fact);
  }

  private factView(state: ProjectionState, fact: Fact): FactView {
    const versions: VersionView[] = [...fact.versionOrder.map((id) => fact.versions.get(id)!)]
      .map((version) => {
        // 版本状态只反映学科学审结论；法定审核是版面级要求（requiresLegal），由闸门把关
        const citations = version.citationIds.map((id) => {
          const c = state.citations.get(id);
          return {
            citationId: id,
            title: c?.title ?? "(引文记录缺失)",
            doi: c?.doi ?? null,
            retracted: Boolean(c?.retracted),
            retraction: c?.retracted ?? null,
          };
        });
        const translations = [...fact.translations.values()]
          .filter((t) => t.sourceVersionId === version.id)
          .map((t) => ({ ...t, status: translationStatus(fact, t) }));
        // 发布状态优先于审核状态：支撑着在发布面 → published；曾发布但全被取代 → superseded
        const backingEditions = [...fact.editions.values()].filter((e) => e.versionId === version.id);
        const gateStatus = versionStatus(fact, version, false);
        const displayStatus = backingEditions.some((e) => e.status === "published")
          ? "published"
          : backingEditions.some((e) => e.status === "superseded")
            ? "superseded"
            : gateStatus;
        return {
          id: version.id,
          sequence: version.sequence,
          basedOnVersionId: version.basedOnVersionId,
          text: version.text,
          rationale: version.rationale,
          contentHash: version.contentHash,
          status: displayStatus,
          reviews: version.reviews,
          citations,
          hasRetractedCitation: citations.some((c) => c.retracted),
          dissentingOpinionCount: fact.opinions.filter(
            (o) => o.stance === "dissenting" && (o.versionId === version.id || o.versionId === null),
          ).length,
          translations,
        };
      });

    const editions: EditionView[] = [...fact.editions.values()].map((edition) => ({
      ...edition,
      blockedReasons:
        edition.status === "draft" || edition.status === "scheduled"
          ? this.scheduleBlockers(state, fact, edition)
          : [],
    }));

    return {
      id: fact.id,
      speciesCode: fact.speciesCode,
      speciesName: fact.speciesName,
      exhibitZone: fact.exhibitZone,
      kind: fact.kind,
      language: factLanguage(fact),
      currentText: fact.currentText,
      note: fact.note,
      registeredAt: fact.registeredAt,
      revision: this.store.revisionOf(fact.id),
      versions,
      opinions: fact.opinions,
      editions,
    };
  }

  listFacts(): Array<{
    factId: string;
    speciesCode: string;
    speciesName: string;
    exhibitZone: string;
    kind: string;
    revision: number;
  }> {
    const state = this.state();
    return [...state.facts.values()].map((fact) => ({
      factId: fact.id,
      speciesCode: fact.speciesCode,
      speciesName: fact.speciesName,
      exhibitZone: fact.exhibitZone,
      kind: fact.kind,
      revision: this.store.revisionOf(fact.id),
    }));
  }

  /**
   * 渠道看板：按物种/展区列出每个渠道的当前发布（含醒目标记）、
   * 待审核差异（候选版本 vs 当前发布文字）、计划发布时间与引文有效性。
   */
  board(filter: { channel?: Channel; speciesCode?: string; exhibitZone?: string } = {}): {
    generatedAt: string;
    facts: Array<{
      factId: string;
      speciesCode: string;
      speciesName: string;
      exhibitZone: string;
      currentPublished: Array<{
        channel: Channel;
        editionId: string;
        versionId: string;
        publishedAt: string | null;
        items: PublishedSnapshotItem[];
        clarifications: Clarification[];
        citationsRetracted: string[];
      }>;
      pendingDiffs: Array<{
        channel: Channel | null;
        editionId: string | null;
        versionId: string;
        status: string;
        scheduledAt: string | null;
        blockedReasons: string[];
        diff: { publishedText: string | null; candidateText: string; changed: boolean };
      }>;
    }>;
  } {
    const state = this.state();
    const views = [...state.facts.values()]
      .filter((f) => (!filter.speciesCode || f.speciesCode === filter.speciesCode))
      .filter((f) => (!filter.exhibitZone || f.exhibitZone === filter.exhibitZone))
      .map((fact) => {
        const view = this.factView(state, fact);
        const currentPublished = view.editions
          .filter((e) => e.status === "published")
          .filter((e) => !filter.channel || e.channel === filter.channel)
          .map((e) => ({
            channel: e.channel,
            editionId: e.id,
            versionId: e.versionId,
            publishedAt: e.publishedAt,
            items: e.snapshot?.items ?? e.items,
            clarifications: e.clarifications,
            citationsRetracted: (e.snapshot?.citations ?? [])
              .map((c) => c.citationId)
              .filter((id) => state.citations.get(id)?.retracted),
          }));

        const publishedByChannel = new Map(
          view.editions.filter((e) => e.status === "published").map((e) => [e.channel, e]),
        );
        type PendingRow = {
          channel: Channel | null;
          editionId: string | null;
          versionId: string;
          status: string;
          scheduledAt: string | null;
          blockedReasons: string[];
          publishedText: string | null;
        };
        const pendingDiffs: PendingRow[] = [];
        for (const v of view.versions.filter((ver) => ver.status !== "rejected")) {
          const related = view.editions.filter(
            (e) => e.versionId === v.id && (e.status === "draft" || e.status === "scheduled"),
          );
          const publishedOnChannels = view.editions
            .filter((e) => e.versionId === v.id && e.status === "published")
            .map((e) => e.channel);
          if (related.length === 0) {
            if (publishedOnChannels.length > 0) {
              // 已在部分渠道发布：为其余没有任何在途版面的渠道补“错峰待发”行；
              // 若该渠道已有别的候选在推进（草稿/排期），不重复列出。
              for (const channel of CHANNELS) {
                if (filter.channel && channel !== filter.channel) continue;
                if (publishedOnChannels.includes(channel)) continue;
                const channelBusy = view.editions.some(
                  (e) =>
                    e.channel === channel &&
                    (e.status === "draft" || e.status === "scheduled"),
                );
                if (channelBusy) continue;
                pendingDiffs.push({
                  channel,
                  editionId: null,
                  versionId: v.id,
                  status: v.status,
                  scheduledAt: null,
                  blockedReasons: [],
                  publishedText: publishedByChannel.get(channel)?.snapshot?.versionText ?? null,
                });
              }
              continue;
            }
            pendingDiffs.push({
              channel: null,
              editionId: null,
              versionId: v.id,
              status: v.status,
              scheduledAt: null,
              blockedReasons: [],
              publishedText: null,
            });
            continue;
          }
          for (const e of related) {
            const published = publishedByChannel.get(e.channel);
            pendingDiffs.push({
              channel: e.channel,
              editionId: e.id,
              versionId: v.id,
              status: e.status,
              scheduledAt: e.scheduledAt,
              blockedReasons: e.blockedReasons,
              publishedText: published?.snapshot?.versionText ?? null,
            });
          }
        }

        return {
          factId: fact.id,
          speciesCode: fact.speciesCode,
          speciesName: fact.speciesName,
          exhibitZone: fact.exhibitZone,
          currentPublished,
          pendingDiffs: pendingDiffs
            .filter((d) => !filter.channel || d.channel === filter.channel || d.channel === null)
            .map((d) => {
              const candidateText = view.versions.find((ver) => ver.id === d.versionId)?.text ?? "";
              return {
                channel: d.channel,
                editionId: d.editionId,
                versionId: d.versionId,
                status: d.status,
                scheduledAt: d.scheduledAt,
                blockedReasons: d.blockedReasons,
                diff: {
                  publishedText: d.publishedText,
                  candidateText,
                  changed: d.publishedText !== null && d.publishedText !== candidateText,
                },
              };
            }),
        };
      });

    return { generatedAt: this.clock().toISOString(), facts: views };
  }

  /** 引文有效性报告：一条引文是否撤回、支撑哪些候选/发布段落 */
  citationReport(citationId?: string): {
    citations: Array<{
      citationId: string;
      title: string;
      doi: string | null;
      retracted: boolean;
      retraction: Citation["retracted"];
      usedBy: Array<{
        factId: string;
        speciesCode: string;
        versionId: string;
        publishedEditions: Array<{ editionId: string; channel: Channel; publishedAt: string | null }>;
      }>;
    }>;
  } {
    const state = this.state();
    const targetIds = citationId ? [citationId] : [...state.citations.keys()];
    const citations = targetIds.map((id) => {
      const citation = this.citation(state, id);
      const usedBy = [...state.facts.values()].flatMap((fact) =>
        [...fact.versions.values()]
          .filter((v) => v.citationIds.includes(id))
          .map((v) => ({
            factId: fact.id,
            speciesCode: fact.speciesCode,
            versionId: v.id,
            publishedEditions: [...fact.editions.values()]
              .filter((e) => e.status === "published" && e.snapshot?.citations.some((c) => c.citationId === id))
              .map((e) => ({ editionId: e.id, channel: e.channel, publishedAt: e.publishedAt })),
          })),
      );
      return {
        citationId: id,
        revision: this.store.revisionOf(`citation:${id}`),
        title: citation.title,
        doi: citation.doi,
        retracted: Boolean(citation.retracted),
        retraction: citation.retracted,
        usedBy,
      };
    });
    return { citations };
  }

  /**
   * 文字溯源：给定文字片段（或版本/译文/版面 id），返回它出现的每一处，
   * 以及该处文字经历的全部学术决定（候选依据、学科学审、法定审核、
   * 语言审核、专家异议、追加标记、引文撤回）。
   */
  trace(input: { text?: string; versionId?: string; translationId?: string; editionId?: string }): {
    matches: Array<{
      factId: string;
      speciesCode: string;
      editionId: string | null;
      channel: Channel | null;
      location: string;
      text: string;
      lineage: Array<Record<string, unknown>>;
    }>;
  } {
    const state = this.state();
    const needle = input.text;
    const matches: ReturnType<EditorialService["trace"]>["matches"] = [];

    for (const fact of state.facts.values()) {
      const view = this.factView(state, fact);

      // 1) 版面（含已发布、已排期、草稿）
      for (const edition of view.editions) {
        const version = view.versions.find((v) => v.id === edition.versionId);
        if (!version) continue;
        const matchedItem = edition.items.find((item) => {
          if (input.editionId && edition.id === input.editionId) return true;
          if (input.versionId && edition.versionId === input.versionId) return true;
          if (input.translationId && item.translationId === input.translationId) return true;
          if (needle && item.text.includes(needle)) return true;
          return false;
        });
        if (input.editionId && edition.id !== input.editionId) continue;
        if (!matchedItem) continue;

        const matchedTranslation = matchedItem.translationId
          ? fact.translations.get(matchedItem.translationId)
          : undefined;
        matches.push({
          factId: fact.id,
          speciesCode: fact.speciesCode,
          editionId: edition.id,
          channel: edition.channel,
          location: `渠道 ${edition.channel} / 语言 ${matchedItem.language}`,
          text: matchedItem.text,
          lineage: this.lineage(
                            state,
                            fact,
                            edition.versionId,
                            edition.id,
                            input.translationId ?? matchedTranslation?.id ?? null,
                          ),
        });
      }

      // 2) 尚未进入任何版面的候选版本与译文
      if (!input.editionId) {
        for (const version of view.versions) {
          const inEdition = view.editions.some((e) => e.versionId === version.id);
          const versionHit =
            (input.versionId && version.id === input.versionId) ||
            (needle && version.text.includes(needle));
          if (versionHit && !inEdition) {
            matches.push({
              factId: fact.id,
              speciesCode: fact.speciesCode,
              editionId: null,
              channel: null,
              location: `候选版本 ${version.id}（尚未进入版面）`,
              text: version.text,
              lineage: this.lineage(state, fact, version.id, null, null),
            });
          }
          for (const translation of version.translations) {
            const translationHit =
              (input.translationId && translation.id === input.translationId) ||
              (needle && translation.text.includes(needle));
            const translationInEdition = view.editions.some((e) =>
              e.items.some((i) => i.translationId === translation.id),
            );
            if (translationHit && !translationInEdition) {
              matches.push({
                factId: fact.id,
                speciesCode: fact.speciesCode,
                editionId: null,
                channel: null,
                location: `译文 ${translation.id}（语言 ${translation.language}，尚未进入版面）`,
                text: translation.text,
                lineage: this.lineage(state, fact, version.id, null, translation.id),
              });
            }
          }
        }
      }
    }
    return { matches };
  }

  /** 构造某版本（在某版面语境下）的学术决定时间线 */
  private lineage(
    state: ProjectionState,
    fact: Fact,
    versionId: string,
    editionId: string | null,
    focusTranslationId: string | null = null,
  ): Array<Record<string, unknown>> {
    const version = this.version(fact, versionId);
    const out: Array<Record<string, unknown>> = [
      { step: "proposal", versionId, basedOn: version.basedOnVersionId, rationale: version.rationale },
    ];
    for (const citationId of version.citationIds) {
      const c = state.citations.get(citationId);
      out.push({
        step: "evidence",
        citationId,
        title: c?.title,
        retracted: Boolean(c?.retracted),
        retraction: c?.retracted ?? null,
      });
    }
    for (const opinion of fact.opinions.filter((o) => o.versionId === versionId || o.versionId === null)) {
      out.push({ step: "expert_opinion", ...opinion });
    }
    for (const review of version.reviews) {
      out.push({ step: "review", ...review });
    }
    for (const t of [...fact.translations.values()].filter((t) => t.sourceVersionId === versionId)) {
      const entry: Record<string, unknown> = {
        step: "translation",
        translationId: t.id,
        language: t.language,
        translator: t.translator,
        textRevision: t.textRevision,
        revisedAt: t.revisedAt,
        status: translationStatus(fact, t),
        focused: t.id === focusTranslationId,
      };
      out.push(entry);
    }
    if (editionId) {
      const edition = this.edition(fact, editionId);
      out.push({
        step: "edition",
        editionId,
        channel: edition.channel,
        status: edition.status,
        scheduledAt: edition.scheduledAt,
        publishedAt: edition.publishedAt,
      });
      for (const c of edition.clarifications) {
        out.push({ step: "clarification", ...c });
      }
    }
    return out;
  }

  /** 原始事件时间线（从任一文字可追溯到的不可改学术决定记录） */
  timeline(factId: string): StoredEvent[] {
    this.fact(this.state(), factId);
    return this.store.readStream(factId);
  }

  /** 到达发布时间的已排期版面（供定时发布器使用） */
  dueEditions(now: Date = this.clock()): Array<{ factId: string; editionId: string; scheduledAt: string }> {
    const state = this.state();
    const due: Array<{ factId: string; editionId: string; scheduledAt: string }> = [];
    for (const fact of state.facts.values()) {
      for (const edition of fact.editions.values()) {
        if (
          edition.status === "scheduled" &&
          edition.scheduledAt &&
          new Date(edition.scheduledAt).getTime() <= now.getTime()
        ) {
          due.push({ factId: fact.id, editionId: edition.id, scheduledAt: edition.scheduledAt });
        }
      }
    }
    return due;
  }
}

/** 事实原文语言 */
function factLanguage(fact: Fact): string {
  return fact.language;
}
