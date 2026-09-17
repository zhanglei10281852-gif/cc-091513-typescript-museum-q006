import { contentHash, newId } from "./hash.js";
import { DomainError } from "./errors.js";
import { Store, Transaction } from "./store.js";
import { CHANNELS, REVIEW_TYPES } from "./types.js";
import type {
  Channel,
  Citation,
  ContentVersion,
  Correction,
  DraftBody,
  Evidence,
  Erratum,
  ExpertOpinion,
  Fact,
  FactKind,
  Publication,
  ReviewDecision,
  ReviewRecord,
  ReviewType,
  Taxon,
  Translation,
  Zone,
} from "./types.js";

type Tx = Transaction;

const asArray = (v: unknown): string[] =>
  Array.isArray(v) ? (v as unknown[]).filter((x): x is string => typeof x === "string") : [];

const unique = (values: string[]): string[] => [...new Set(values)];

function requireStr(body: Record<string, unknown>, key: string): string {
  const v = body[key];
  if (typeof v !== "string" || v.trim() === "") {
    throw DomainError.badRequest(`字段 ${key} 必须是非空字符串`);
  }
  return v;
}

function actorOf(body: Record<string, unknown>): string {
  const v = body.actor;
  if (typeof v !== "string" || v.trim() === "") {
    throw DomainError.badRequest("字段 actor 必须是非空字符串");
  }
  return v;
}

function optStr(body: Record<string, unknown>, key: string): string | undefined {
  const v = body[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw DomainError.badRequest(`字段 ${key} 必须是字符串`);
  return v;
}

function requireChannels(body: Record<string, unknown>, key = "channels"): Channel[] {
  const list = asArray(body[key]);
  if (list.length === 0) throw DomainError.badRequest("至少指定一个发布渠道");
  for (const c of list) {
    if (!CHANNELS.includes(c as Channel)) throw DomainError.badRequest(`未知发布渠道: ${c}`);
  }
  return unique(list) as Channel[];
}

/**
 * 编辑部落库：所有产生学术后果的动作都在这里实现，并逐条记录不可变决定事件。
 */
export class EditorialService {
  constructor(private readonly store: Store) {}

  // ---------- 基础资料 ----------

  registerZone(body: Record<string, unknown>): Zone {
    const code = requireStr(body, "code");
    const name = requireStr(body, "name");
    return this.store.mutate((tx) => {
      if (tx.db.zones.some((z) => z.code === code)) {
        throw DomainError.conflict(`展区编号已存在: ${code}`);
      }
      const zone: Zone = { id: newId("zone"), code, name, createdAt: tx.now() };
      tx.db.zones.push(zone);
      tx.record("zone_registered", { actor: actorOf(body), detail: { zoneId: zone.id, code, name } });
      return zone;
    });
  }

  registerTaxon(body: Record<string, unknown>): Taxon {
    const scientificName = requireStr(body, "scientificName");
    const zoneIds = unique(asArray(body.zoneIds));
    return this.store.mutate((tx) => {
      for (const zid of zoneIds) this.mustZone(tx, zid);
      if (tx.db.taxa.some((t) => t.scientificName === scientificName)) {
        throw DomainError.conflict(`学名已登记: ${scientificName}`);
      }
      const taxon: Taxon = {
        id: newId("taxon"),
        scientificName,
        zoneIds,
        createdAt: tx.now(),
      };
      tx.db.taxa.push(taxon);
      tx.record("taxon_registered", {
        actor: actorOf(body),
        detail: { taxonId: taxon.id, scientificName, zoneIds },
      });
      return taxon;
    });
  }

  registerCitation(body: Record<string, unknown>): Citation {
    const key = requireStr(body, "key");
    const title = requireStr(body, "title");
    const authors = requireStr(body, "authors");
    const year = optStr(body, "year");
    const doi = optStr(body, "doi");
    return this.store.mutate((tx) => {
      if (tx.db.citations.some((c) => c.key === key)) {
        throw DomainError.conflict(`引用标识已存在: ${key}`);
      }
      const citation: Citation = {
        id: newId("cit"),
        key,
        title,
        authors,
        status: "valid",
        createdAt: tx.now(),
        ...(year ? { year } : {}),
        ...(doi ? { doi } : {}),
      };
      tx.db.citations.push(citation);
      tx.record("citation_registered", {
        actor: actorOf(body),
        citationId: citation.id,
        detail: { key, title },
      });
      return citation;
    });
  }

  addExpertOpinion(body: Record<string, unknown>): ExpertOpinion {
    const taxonId = requireStr(body, "taxonId");
    const expert = requireStr(body, "expert");
    const discipline = requireStr(body, "discipline");
    const summary = requireStr(body, "summary");
    const documentRef = optStr(body, "documentRef");
    return this.store.mutate((tx) => {
      this.mustTaxon(tx, taxonId);
      const opinion: ExpertOpinion = {
        id: newId("opn"),
        taxonId,
        expert,
        discipline,
        summary,
        receivedAt: tx.now(),
        ...(documentRef ? { documentRef } : {}),
      };
      tx.db.opinions.push(opinion);
      tx.record("expert_opinion_added", {
        actor: actorOf(body),
        detail: { opinionId: opinion.id, taxonId, expert, discipline },
      });
      return opinion;
    });
  }

  defineFact(body: Record<string, unknown>): Fact {
    const taxonId = requireStr(body, "taxonId");
    const kind = requireStr(body, "kind") as FactKind;
    const key = requireStr(body, "key");
    if (kind !== "scientific_name" && kind !== "distribution" && kind !== "other") {
      throw DomainError.badRequest(`未知事实类型: ${kind}`);
    }
    return this.store.mutate((tx) => {
      this.mustTaxon(tx, taxonId);
      if (tx.db.facts.some((f) => f.taxonId === taxonId && f.key === key)) {
        throw DomainError.conflict(`该物种下事实槽位已存在: ${key}`);
      }
      const fact: Fact = { id: newId("fact"), taxonId, kind, key, createdAt: tx.now() };
      tx.db.facts.push(fact);
      tx.record("fact_defined", {
        actor: actorOf(body),
        factId: fact.id,
        detail: { taxonId, kind, key },
      });
      return fact;
    });
  }

  /** 登记某渠道现行的纸质或线上内容，作为不可变基线出版版本。 */
  publishBaseline(body: Record<string, unknown>): Publication {
    const factId = requireStr(body, "factId");
    const channel = requireStr(body, "channel") as Channel;
    if (!CHANNELS.includes(channel)) throw DomainError.badRequest(`未知发布渠道: ${channel}`);
    const text = requireStr(body, "text");
    const evidence = this.parseEvidence(body);
    return this.store.mutate((tx) => {
      const fact = this.mustFact(tx, factId);
      // 历史基线可能引用后来才撤回的旧文献，登记时不阻断；撤回会另行追加标记
      this.checkEvidenceRefs(tx, evidence, fact.taxonId, { allowRetracted: true });
      const version = this.freezeVersion(tx, fact, "baseline", text, evidence, undefined, actorOf(body));
      const publication = this.publishOnChannel(tx, fact, channel, version, [], actorOf(body));
      tx.record("baseline_published", {
        actor: actorOf(body),
        factId: fact.id,
        publicationId: publication.id,
        contentVersionId: version.id,
        detail: { channel },
      });
      return publication;
    });
  }

  // ---------- 候选更正 ----------

  createCorrection(body: Record<string, unknown>): Correction {
    const taxonId = requireStr(body, "taxonId");
    const factId = requireStr(body, "factId");
    const channels = requireChannels(body);
    const targetLanguages = unique(asArray(body.targetLanguages));
    const draft = this.parseDraft(body);
    const requiredReviews =
      body.requiredReviews === undefined
        ? (["scientific", "language"] as ReviewType[])
        : (unique(asArray(body.requiredReviews)) as ReviewType[]);
    for (const r of requiredReviews) {
      if (!REVIEW_TYPES.includes(r)) throw DomainError.badRequest(`未知审核类型: ${r}`);
    }
    if (!requiredReviews.includes("scientific") || !requiredReviews.includes("language")) {
      throw DomainError.badRequest("候选更正必须经过学科(scientific)与语言(language)审核");
    }
    return this.store.mutate((tx) => {
      const taxon = this.mustTaxon(tx, taxonId);
      const fact = this.mustFact(tx, factId);
      if (fact.taxonId !== taxon.id) throw DomainError.unprocessable("事实不属于该物种");
      this.checkEvidenceRefs(tx, draft.evidence, taxonId, { allowRetracted: true });
      const now = tx.now();
      const correction: Correction = {
        id: newId("cor"),
        taxonId,
        factId,
        channels,
        targetLanguages,
        requiredReviews,
        state: "draft",
        draft: {
          ...draft,
          evidence: this.cloneEvidence(draft.evidence),
          revision: 1,
          updatedBy: actorOf(body),
          updatedAt: now,
        },
        frozenRevisionNo: 0,
        reviews: [],
        ...(fact.currentVersionId ? { baseVersionIdAtCreate: fact.currentVersionId } : {}),
        createdBy: actorOf(body),
        createdAt: now,
      };
      tx.db.corrections.push(correction);
      tx.record("correction_created", {
        actor: actorOf(body),
        factId: fact.id,
        correctionId: correction.id,
        detail: {
          channels,
          targetLanguages,
          requiredReviews,
          baseVersionId: fact.currentVersionId ?? null,
        },
      });
      return correction;
    });
  }

  /** 修改草稿；expectedRevision 用于检测多位编辑同时修改导致的过期草稿。 */
  updateDraft(id: string, body: Record<string, unknown>): Correction {
    const expectedRevision = body.expectedRevision;
    if (typeof expectedRevision !== "number") {
      throw DomainError.badRequest("必须提供 expectedRevision 数字以检测过期草稿");
    }
    return this.store.mutate((tx) => {
      const c = this.mustCorrection(tx, id);
      if (c.state !== "draft") {
        throw DomainError.conflict(`当前状态 ${c.state} 不允许编辑草稿，需先被退回草稿态`);
      }
      if (c.draft.revision !== expectedRevision) {
        throw DomainError.conflict("草稿已过期：他人已更新，请基于最新修订号重新编辑", {
          currentRevision: c.draft.revision,
          submittedRevision: expectedRevision,
        });
      }
      const changes: Partial<DraftBody> = {};
      if (body.text !== undefined) changes.text = requireStr(body, "text");
      if (body.rationale !== undefined) changes.rationale = requireStr(body, "rationale");
      if (body.evidence !== undefined) changes.evidence = this.parseEvidence(body);
      this.checkEvidenceRefs(tx, changes.evidence ?? c.draft.evidence, c.taxonId, {
        allowRetracted: true,
      });
      Object.assign(c.draft, changes);
      c.draft.revision += 1;
      c.draft.updatedBy = actorOf(body);
      c.draft.updatedAt = tx.now();
      tx.record("draft_updated", {
        actor: actorOf(body),
        correctionId: c.id,
        factId: c.factId,
        detail: { revision: c.draft.revision, changedFields: Object.keys(changes) },
      });
      return c;
    });
  }

  /** 提交审核：把当下草稿冻结成带哈希的不可变版本，审核意见绑定该哈希。 */
  submit(id: string, body: Record<string, unknown>): Correction {
    return this.store.mutate((tx) => {
      const c = this.mustCorrection(tx, id);
      if (c.state !== "draft") {
        throw DomainError.conflict(`只有草稿态可以提交审核，当前为 ${c.state}`);
      }
      const fact = this.mustFact(tx, c.factId);
      // 证据里仍含已撤回来源则不能提交；换掉证据即可继续，不强制接受任何替代结论
      this.checkEvidenceRefs(tx, c.draft.evidence, c.taxonId, { allowRetracted: false });
      const version = this.freezeVersion(
        tx,
        fact,
        "correction",
        c.draft.text,
        c.draft.evidence,
        c.id,
        actorOf(body),
      );
      c.frozenVersionId = version.id;
      c.frozenRevisionNo = version.revisionNo;
      c.state = "reviewing";
      c.evidenceFlags = [];
      // 源版本变了：既有译文一律标过期，需对照新源版本重新翻译/复核
      const affectedTranslations = tx.db.translations.filter((t) => t.correctionId === c.id);
      for (const t of affectedTranslations) t.stale = true;
      tx.record("correction_submitted", {
        actor: actorOf(body),
        correctionId: c.id,
        factId: c.factId,
        contentVersionId: version.id,
        detail: {
          revisionNo: version.revisionNo,
          translationIdsMarkedStale: affectedTranslations.map((t) => t.id),
        },
      });
      return c;
    });
  }

  review(id: string, body: Record<string, unknown>): Correction {
    const type = requireStr(body, "type") as ReviewType;
    if (!REVIEW_TYPES.includes(type)) throw DomainError.badRequest(`未知审核类型: ${type}`);
    const reviewer = requireStr(body, "reviewer");
    const decision = requireStr(body, "decision") as ReviewDecision;
    if (decision !== "approved" && decision !== "changes_requested" && decision !== "rejected") {
      throw DomainError.badRequest("decision 必须是 approved/changes_requested/rejected");
    }
    const comment = optStr(body, "comment");
    return this.store.mutate((tx) => {
      const c = this.mustCorrection(tx, id);
      if (c.state !== "reviewing") {
        throw DomainError.conflict(`候选不在审核中，当前为 ${c.state}`);
      }
      if (!c.requiredReviews.includes(type)) {
        throw DomainError.unprocessable(`该候选不要求 ${type} 审核`);
      }
      const frozen = this.mustFrozen(tx, c);
      if (decision === "approved") {
        // 审核期间证据可能被撤回：不允许带着失效证据通过
        this.checkEvidenceRefs(tx, frozen.evidence, c.taxonId, { allowRetracted: false });
      }
      const record: ReviewRecord = {
        id: newId("rev"),
        type,
        reviewer,
        decision,
        versionHash: frozen.sourceHash,
        at: tx.now(),
        ...(comment ? { comment } : {}),
      };
      c.reviews.push(record);

      if (decision === "approved") {
        if (this.allRequiredApprovals(c, frozen.sourceHash)) c.state = "approved";
      } else {
        // 退回或拒绝：回到草稿态。重新提交会产生新冻结版本，
        // 旧批准因哈希不同（或晚于 lastReturnedAt 判定）自动失效。
        c.state = "draft";
        c.lastReturnedAt = tx.now();
      }

      tx.record("review_recorded", {
        actor: reviewer,
        correctionId: c.id,
        factId: c.factId,
        contentVersionId: frozen.id,
        detail: {
          type,
          decision,
          versionHash: frozen.sourceHash,
          resultingState: c.state,
          ...(comment ? { comment } : {}),
        },
      });
      return c;
    });
  }

  schedule(id: string, body: Record<string, unknown>): Correction {
    const publishAt = requireStr(body, "publishAt");
    const when = Date.parse(publishAt);
    if (Number.isNaN(when)) throw DomainError.badRequest("publishAt 不是合法时间");
    const channels = body.channels === undefined ? undefined : requireChannels(body);
    return this.store.mutate((tx) => {
      const c = this.mustCorrection(tx, id);
      if (c.state !== "approved") {
        throw DomainError.conflict(`只有审核通过的候选可以排期，当前为 ${c.state}`);
      }
      const targetChannels = channels ?? c.channels;
      for (const ch of targetChannels) {
        if (!c.channels.includes(ch)) {
          throw DomainError.unprocessable(`渠道 ${ch} 不在候选声明范围内`);
        }
      }
      // 译文闸口：每种目标语言都要有绑定当前冻结版本、审核通过且未过期的译文
      const missing: string[] = [];
      for (const lang of c.targetLanguages) {
        const t = tx.db.translations.find(
          (x) => x.correctionId === c.id && x.language === lang,
        );
        if (!t || t.status !== "approved" || t.stale || t.contentVersionId !== c.frozenVersionId) {
          missing.push(lang);
        }
      }
      if (missing.length > 0) {
        throw DomainError.unprocessable("存在缺失或未通过语言审核的译文", {
          missingLanguages: missing,
        });
      }
      c.state = "scheduled";
      c.scheduledPublishAt = new Date(when).toISOString();
      c.scheduledChannels = targetChannels;
      tx.record("publication_scheduled", {
        actor: actorOf(body),
        correctionId: c.id,
        factId: c.factId,
        detail: { publishAt: c.scheduledPublishAt, channels: targetChannels },
      });
      return c;
    });
  }

  /** 出版所有到期候选。返回本次实际出版的渠道记录。 */
  publishDue(actor = "system"): Publication[] {
    return this.store.mutate((tx) => {
      const nowMs = Date.parse(tx.now());
      const due = tx.db.corrections.filter(
        (c) =>
          c.state === "scheduled" &&
          c.scheduledPublishAt !== undefined &&
          Date.parse(c.scheduledPublishAt) <= nowMs,
      );
      const out: Publication[] = [];
      for (const c of due) out.push(...this.publishCorrectionTx(tx, c, actor));
      return out;
    });
  }

  // ---------- 译文 ----------

  addTranslation(correctionId: string, body: Record<string, unknown>): Translation {
    const language = requireStr(body, "language");
    const text = requireStr(body, "text");
    const translator = requireStr(body, "translator");
    return this.store.mutate((tx) => {
      const c = this.mustCorrection(tx, correctionId);
      if (!c.frozenVersionId) {
        throw DomainError.conflict("候选尚未提交审核：译文必须绑定冻结的源版本");
      }
      if (!c.targetLanguages.includes(language)) {
        throw DomainError.unprocessable(`语言 ${language} 不在候选目标语言内`);
      }
      if (tx.db.translations.some((t) => t.correctionId === c.id && t.language === language)) {
        throw DomainError.conflict(`该候选的 ${language} 译文已存在，请修改既有译文`);
      }
      const translation: Translation = {
        id: newId("trl"),
        correctionId: c.id,
        contentVersionId: c.frozenVersionId,
        language,
        text,
        translator,
        status: "draft",
        stale: false,
        createdAt: tx.now(),
      };
      tx.db.translations.push(translation);
      tx.record("translation_added", {
        actor: translator,
        correctionId: c.id,
        translationId: translation.id,
        contentVersionId: translation.contentVersionId,
        detail: { language },
      });
      return translation;
    });
  }

  updateTranslation(translationId: string, body: Record<string, unknown>): Translation {
    return this.store.mutate((tx) => {
      const t = this.mustTranslation(tx, translationId);
      const c = this.mustCorrection(tx, t.correctionId);
      if (t.status === "approved" && !t.stale) {
        throw DomainError.conflict("已通过审核的译文不可直接改写");
      }
      t.text = requireStr(body, "text");
      if (c.frozenVersionId) t.contentVersionId = c.frozenVersionId;
      t.stale = false;
      t.status = "draft";
      delete t.review;
      tx.record("translation_revised", {
        actor: actorOf(body),
        correctionId: c.id,
        translationId: t.id,
        contentVersionId: t.contentVersionId,
      });
      return t;
    });
  }

  reviewTranslation(translationId: string, body: Record<string, unknown>): Translation {
    const reviewer = requireStr(body, "reviewer");
    const decision = requireStr(body, "decision");
    if (decision !== "approved" && decision !== "rejected") {
      throw DomainError.badRequest("decision 必须是 approved/rejected");
    }
    return this.store.mutate((tx) => {
      const t = this.mustTranslation(tx, translationId);
      if (t.status !== "draft") {
        throw DomainError.conflict(`只有待审译文可以审核，当前为 ${t.status}`);
      }
      if (t.stale) {
        throw DomainError.conflict("译文绑定的源版本已更新，请先按新源版本修订译文");
      }
      t.status = decision;
      const comment = optStr(body, "comment");
      t.review = { reviewer, at: tx.now(), ...(comment ? { comment } : {}) };
      tx.record("translation_reviewed", {
        actor: reviewer,
        correctionId: t.correctionId,
        translationId: t.id,
        contentVersionId: t.contentVersionId,
        detail: { decision, language: t.language },
      });
      return t;
    });
  }

  // ---------- 撤回与勘误 ----------

  markCitationRetracted(citationId: string, body: Record<string, unknown>): Citation {
    const note = optStr(body, "note");
    return this.store.mutate((tx) => {
      const citation = this.mustCitation(tx, citationId);
      if (citation.status === "retracted") {
        throw DomainError.conflict("该引用已标记撤回");
      }
      citation.status = "retracted";
      citation.retractedAt = tx.now();
      if (note) citation.retractionNote = note;
      tx.record("citation_retracted", {
        actor: actorOf(body),
        citationId: citation.id,
        detail: { key: citation.key, note: note ?? null },
      });

      // 已出版：给所有引用该来源的出版段落追加醒目标记，绝不改正文
      for (const pub of tx.db.publications) {
        const version = tx.db.versions.find((v) => v.id === pub.contentVersionId);
        if (!version || !version.evidence.citationIds.includes(citation.id)) continue;
        const already = pub.errata.some(
          (e) => e.kind === "retraction_notice" && e.citationId === citation.id,
        );
        if (already) continue;
        const erratum: Erratum = {
          id: newId("err"),
          kind: "retraction_notice",
          citationId: citation.id,
          message:
            note ??
            `本段引用的来源 ${citation.key}（${citation.title}）已被撤回，内容请谨慎采信；替代结论以馆方后续审核为准。`,
          createdBy: actorOf(body),
          createdAt: tx.now(),
        };
        pub.errata.push(erratum);
        tx.record("erratum_appended", {
          actor: actorOf(body),
          factId: pub.factId,
          publicationId: pub.id,
          citationId: citation.id,
          detail: { kind: "retraction_notice", erratumId: erratum.id },
        });
      }

      // 在途候选：标出受影响段落并阻断其继续流转；不自动生成或认可任何替代结论
      for (const c of tx.db.corrections) {
        if (c.state === "published") continue;
        const usesCitation =
          c.draft.evidence.citationIds.includes(citation.id) ||
          (c.frozenVersionId !== undefined &&
            this.mustVersion(tx, c.frozenVersionId).evidence.citationIds.includes(citation.id));
        if (!usesCitation) continue;
        c.evidenceFlags ??= [];
        if (!c.evidenceFlags.some((f) => f.citationId === citation.id)) {
          c.evidenceFlags.push({ citationId: citation.id, at: tx.now() });
        }
        // 审核中/已通过/已排期的候选一律退回草稿，重走全流程
        if (c.state === "reviewing" || c.state === "approved" || c.state === "scheduled") {
          c.state = "draft";
          delete c.scheduledPublishAt;
          delete c.scheduledChannels;
          c.lastReturnedAt = tx.now();
        }
        tx.record("correction_flagged_retracted_source", {
          actor: actorOf(body),
          correctionId: c.id,
          factId: c.factId,
          citationId: citation.id,
          detail: { resultingState: c.state },
        });
      }
      return citation;
    });
  }

  /** 紧急勘误：只在已出版记录上追加醒目标记，原文定格不变。 */
  appendErratum(publicationId: string, body: Record<string, unknown>): Erratum {
    const message = requireStr(body, "message");
    return this.store.mutate((tx) => {
      const pub = tx.db.publications.find((p) => p.id === publicationId);
      if (!pub) throw DomainError.notFound("出版记录", publicationId);
      const erratum: Erratum = {
        id: newId("err"),
        kind: "emergency_notice",
        message,
        createdBy: actorOf(body),
        createdAt: tx.now(),
      };
      pub.errata.push(erratum);
      tx.record("erratum_appended", {
        actor: actorOf(body),
        factId: pub.factId,
        publicationId: pub.id,
        detail: { kind: "emergency_notice", erratumId: erratum.id, message },
      });
      return erratum;
    });
  }

  // ---------- 内部实现 ----------

  private publishCorrectionTx(tx: Tx, c: Correction, actor: string): Publication[] {
    const frozen = this.mustFrozen(tx, c);
    this.checkEvidenceRefs(tx, frozen.evidence, c.taxonId, { allowRetracted: false });
    const fact = this.mustFact(tx, c.factId);
    const channels = c.scheduledChannels ?? c.channels;
    const translationIds = tx.db.translations
      .filter(
        (t) =>
          t.correctionId === c.id &&
          t.status === "approved" &&
          !t.stale &&
          t.contentVersionId === frozen.id,
      )
      .map((t) => t.id);

    const pubs: Publication[] = [];
    for (const channel of channels) {
      const pub = this.publishOnChannel(tx, fact, channel, frozen, translationIds, actor, c.id);
      pubs.push(pub);
      tx.record("correction_published", {
        actor,
        factId: fact.id,
        correctionId: c.id,
        publicationId: pub.id,
        contentVersionId: frozen.id,
        detail: { channel },
      });
    }
    c.state = "published";
    c.publishedAt = tx.now();
    return pubs;
  }

  private publishOnChannel(
    tx: Tx,
    fact: Fact,
    channel: Channel,
    version: ContentVersion,
    translationIds: string[],
    actor: string,
    correctionId?: string,
  ): Publication {
    const previous = tx.db.publications.find(
      (p) => p.factId === fact.id && p.channel === channel && p.status === "published",
    );
    const pub: Publication = {
      id: newId("pub"),
      factId: fact.id,
      taxonId: fact.taxonId,
      channel,
      contentVersionId: version.id,
      translationIds,
      // 出版时定格正文快照；之后只能追加勘误，不能改写
      renderedText: version.text,
      origin: version.origin,
      status: "published",
      publishedAt: tx.now(),
      publishedBy: actor,
      errata: [],
      ...(correctionId ? { correctionId } : {}),
    };
    if (previous) {
      previous.status = "superseded";
      previous.supersededAt = tx.now();
      previous.supersededByPublicationId = pub.id;
      tx.record("publication_superseded", {
        actor,
        factId: fact.id,
        publicationId: previous.id,
        contentVersionId: previous.contentVersionId,
        detail: { channel, supersedingPublicationId: pub.id },
      });
    }
    tx.db.publications.push(pub);
    fact.currentVersionId = version.id;
    return pub;
  }

  private freezeVersion(
    tx: Tx,
    fact: Fact,
    origin: ContentVersion["origin"],
    text: string,
    evidence: Evidence,
    correctionId: string | undefined,
    actor: string,
  ): ContentVersion {
    const prior = tx.db.versions.filter((v) => v.factId === fact.id);
    const revisionNo = prior.length === 0 ? 1 : Math.max(...prior.map((v) => v.revisionNo)) + 1;
    const version: ContentVersion = {
      id: newId("ver"),
      factId: fact.id,
      origin,
      revisionNo,
      text,
      evidence: this.cloneEvidence(evidence),
      sourceHash: contentHash(text, evidence),
      createdBy: actor,
      createdAt: tx.now(),
      ...(fact.currentVersionId ? { baseVersionId: fact.currentVersionId } : {}),
      ...(correctionId ? { correctionId } : {}),
    };
    tx.db.versions.push(version);
    tx.record("content_version_frozen", {
      actor,
      factId: fact.id,
      contentVersionId: version.id,
      detail: {
        origin,
        revisionNo,
        baseVersionId: version.baseVersionId ?? null,
        sourceHash: version.sourceHash,
        correctionId: correctionId ?? null,
      },
    });
    return version;
  }

  /**
   * 每类必需审核都有效“同意”才算通过：
   * 意见必须针对当前冻结版本哈希，且晚于最近一次退回（退回后的旧同意不算数）。
   */
  private allRequiredApprovals(c: Correction, frozenHash: string): boolean {
    return c.requiredReviews.every((type) => {
      const matching = c.reviews.filter(
        (r) => r.type === type && r.versionHash === frozenHash && r.at > (c.lastReturnedAt ?? ""),
      );
      const latest = matching[matching.length - 1];
      return latest?.decision === "approved";
    });
  }

  private parseDraft(body: Record<string, unknown>): DraftBody {
    return {
      text: requireStr(body, "text"),
      rationale: requireStr(body, "rationale"),
      evidence: this.parseEvidence(body),
    };
  }

  private parseEvidence(body: Record<string, unknown>): Evidence {
    const ev = body.evidence;
    if (typeof ev !== "object" || ev === null) {
      throw DomainError.badRequest("必须提供 evidence {citationIds, expertOpinionIds}");
    }
    const e = ev as Record<string, unknown>;
    return {
      citationIds: unique(asArray(e.citationIds)),
      expertOpinionIds: unique(asArray(e.expertOpinionIds)),
    };
  }

  private cloneEvidence(e: Evidence): Evidence {
    return { citationIds: [...e.citationIds], expertOpinionIds: [...e.expertOpinionIds] };
  }

  private checkEvidenceRefs(
    tx: Tx,
    evidence: Evidence,
    taxonId: string,
    opts: { allowRetracted: boolean },
  ): void {
    if (evidence.citationIds.length === 0 && evidence.expertOpinionIds.length === 0) {
      throw DomainError.unprocessable("候选内容必须附证据：至少一条引文或一份专家意见");
    }
    for (const cid of evidence.citationIds) {
      const citation = tx.db.citations.find((x) => x.id === cid);
      if (!citation) throw DomainError.unprocessable(`引文不存在: ${cid}`);
      if (!opts.allowRetracted && citation.status === "retracted") {
        throw DomainError.unprocessable(`引文已撤回，不能作为候选证据: ${citation.key}`, {
          citationId: cid,
        });
      }
    }
    for (const oid of evidence.expertOpinionIds) {
      const opinion = tx.db.opinions.find((x) => x.id === oid);
      if (!opinion) throw DomainError.unprocessable(`专家意见不存在: ${oid}`);
      if (opinion.taxonId !== taxonId) {
        throw DomainError.unprocessable(`专家意见不属于该物种: ${oid}`);
      }
    }
  }

  private mustZone(tx: Tx, id: string): Zone {
    const z = tx.db.zones.find((x) => x.id === id);
    if (!z) throw DomainError.notFound("展区", id);
    return z;
  }

  private mustTaxon(tx: Tx, id: string): Taxon {
    const taxon = tx.db.taxa.find((t) => t.id === id);
    if (!taxon) throw DomainError.notFound("物种", id);
    return taxon;
  }

  private mustFact(tx: Tx, id: string): Fact {
    const fact = tx.db.facts.find((f) => f.id === id);
    if (!fact) throw DomainError.notFound("事实", id);
    return fact;
  }

  private mustCitation(tx: Tx, id: string): Citation {
    const citation = tx.db.citations.find((x) => x.id === id);
    if (!citation) throw DomainError.notFound("引文", id);
    return citation;
  }

  private mustCorrection(tx: Tx, id: string): Correction {
    const c = tx.db.corrections.find((x) => x.id === id);
    if (!c) throw DomainError.notFound("候选更正", id);
    return c;
  }

  private mustTranslation(tx: Tx, id: string): Translation {
    const t = tx.db.translations.find((x) => x.id === id);
    if (!t) throw DomainError.notFound("译文", id);
    return t;
  }

  private mustVersion(tx: Tx, id: string): ContentVersion {
    const v = tx.db.versions.find((x) => x.id === id);
    if (!v) throw DomainError.notFound("内容版本", id);
    return v;
  }

  private mustFrozen(tx: Tx, c: Correction): ContentVersion {
    if (!c.frozenVersionId) throw DomainError.conflict("候选尚未冻结版本");
    return this.mustVersion(tx, c.frozenVersionId);
  }
}
