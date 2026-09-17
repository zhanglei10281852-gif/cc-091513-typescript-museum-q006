import { DomainError } from "./errors.js";
import type { Database } from "./types.js";
import type {
  Channel,
  Citation,
  ContentVersion,
  Correction,
  DecisionEvent,
  Fact,
  Publication,
  Taxon,
  Translation,
  Zone,
} from "./types.js";

export interface CitationView {
  id: string;
  key: string;
  title: string;
  status: "valid" | "retracted";
  retractedAt?: string;
  retractionNote?: string;
  /** 该引文当前被哪些已出版段落使用（含撤回标记状态） */
  usedByPublications: { publicationId: string; channel: Channel; factId: string; noticeAppended: boolean }[];
  /** 该引文被哪些在途候选引用 */
  usedByCorrections: { correctionId: string; state: Correction["state"]; flagged: boolean }[];
}

export interface ChannelSlot {
  channel: Channel;
  publicationId: string;
  contentVersionId: string;
  renderedText: string;
  origin: Publication["origin"];
  publishedAt: string;
  status: Publication["status"];
  errata: Publication["errata"];
  translationIds: string[];
}

export interface PendingReviewView {
  type: Correction["requiredReviews"][number];
  /** 当前冻结版本上是否已有有效同意 */
  satisfied: boolean;
  latestDecision?: string;
  reviewer?: string;
  at?: string;
}

export interface PendingCorrectionView {
  correctionId: string;
  state: Correction["state"];
  channels: Channel[];
  draftRevision: number;
  frozenVersionId?: string;
  /** 相对当前已出版正文的差异，供编辑部预览待审改动 */
  diff: {
    currentText: string | null;
    proposedText: string | null;
    textChanged: boolean;
    citationIdsAdded: string[];
    citationIdsRemoved: string[];
  };
  reviews: PendingReviewView[];
  evidenceFlags: NonNullable<Correction["evidenceFlags"]>;
  scheduledPublishAt?: string;
  scheduledChannels?: Channel[];
  targetLanguages: string[];
  translations: {
    language: string;
    status: Translation["status"];
    stale: boolean;
    contentVersionId: string;
  }[];
}

export interface FactView {
  fact: Pick<Fact, "id" | "kind" | "key">;
  currentVersionId?: string;
  channels: ChannelSlot[];
  pendingCorrections: PendingCorrectionView[];
  /** 该事实各渠道正文所引来源的总体有效性 */
  citationValidity: { citationId: string; key: string; status: Citation["status"] }[];
}

export interface TaxonBoard {
  taxon: Pick<Taxon, "id" | "scientificName">;
  zones: Pick<Zone, "id" | "code" | "name">[];
  facts: FactView[];
}

export interface ProvenanceReport {
  matchedBy: "publication" | "version" | "text";
  factIds: string[];
  /** 版本血缘链：从基底到当前 */
  versionLineage: ContentVersion[];
  publications: Publication[];
  corrections: Correction[];
  translations: Translation[];
  citations: Citation[];
  /** 该段文字经历的全部学术决定，按序号排列 */
  timeline: DecisionEvent[];
}

/** 只读查询模型：馆方看板与文字溯源。 */
export class QueryService {
  constructor(private readonly db: Database) {}

  taxonBoard(taxonId: string): TaxonBoard {
    const taxon = this.db.taxa.find((t) => t.id === taxonId);
    if (!taxon) throw DomainError.notFound("物种", taxonId);
    const zones = this.db.zones.filter((z) => taxon.zoneIds.includes(z.id));
    const facts = this.db.facts.filter((f) => f.taxonId === taxonId).map((f) => this.factView(f));
    return {
      taxon: { id: taxon.id, scientificName: taxon.scientificName },
      zones: zones.map((z) => ({ id: z.id, code: z.code, name: z.name })),
      facts,
    };
  }

  zoneBoard(zoneId: string): { zone: Pick<Zone, "id" | "code" | "name">; taxa: TaxonBoard[] } {
    const zone = this.db.zones.find((z) => z.id === zoneId);
    if (!zone) throw DomainError.notFound("展区", zoneId);
    const taxa = this.db.taxa
      .filter((t) => t.zoneIds.includes(zoneId))
      .map((t) => this.taxonBoard(t.id));
    return { zone: { id: zone.id, code: zone.code, name: zone.name }, taxa };
  }

  citation(id: string): CitationView {
    const citation = this.db.citations.find((c) => c.id === id);
    if (!citation) throw DomainError.notFound("引文", id);
    return this.citationView(citation);
  }

  citations(): CitationView[] {
    return this.db.citations.map((c) => this.citationView(c));
  }

  /**
   * 从任一文字或版本/出版标识追溯它经历的全部学术决定。
   * text 为精确匹配版本正文或出版定格正文。
   */
  provenance(query: { publicationId?: string; contentVersionId?: string; text?: string }): ProvenanceReport {
    let matchedBy: ProvenanceReport["matchedBy"];
    let factIds: string[];

    if (query.publicationId) {
      const pub = this.db.publications.find((p) => p.id === query.publicationId);
      if (!pub) throw DomainError.notFound("出版记录", query.publicationId);
      matchedBy = "publication";
      factIds = [pub.factId];
    } else if (query.contentVersionId) {
      const version = this.db.versions.find((v) => v.id === query.contentVersionId);
      if (!version) throw DomainError.notFound("内容版本", query.contentVersionId);
      matchedBy = "version";
      factIds = [version.factId];
    } else if (query.text !== undefined) {
      matchedBy = "text";
      const versionHits = this.db.versions.filter((v) => v.text === query.text).map((v) => v.factId);
      const pubHits = this.db.publications
        .filter((p) => p.renderedText === query.text)
        .map((p) => p.factId);
      factIds = [...new Set([...versionHits, ...pubHits])];
      if (factIds.length === 0) throw DomainError.notFound("文字", query.text ?? "");
    } else {
      throw DomainError.badRequest("必须提供 publicationId / contentVersionId / text 之一");
    }

    const facts = this.db.facts.filter((f) => factIds.includes(f.id));
    const correctionIds = new Set(
      this.db.corrections.filter((c) => factIds.includes(c.factId)).map((c) => c.id),
    );
    const versionIds = new Set(this.db.versions.filter((v) => factIds.includes(v.factId)).map((v) => v.id));
    const publicationIds = new Set(
      this.db.publications.filter((p) => factIds.includes(p.factId)).map((p) => p.id),
    );
    const citationIds = new Set<string>();
    for (const v of this.db.versions.filter((v) => versionIds.has(v.id))) {
      for (const cid of v.evidence.citationIds) citationIds.add(cid);
    }

    const timeline = this.db.events.filter((e) => {
      if (e.factId && factIds.includes(e.factId)) return true;
      if (e.correctionId && correctionIds.has(e.correctionId)) return true;
      if (e.publicationId && publicationIds.has(e.publicationId)) return true;
      if (e.contentVersionId && versionIds.has(e.contentVersionId)) return true;
      if (e.citationId && citationIds.has(e.citationId)) return true;
      return false;
    });

    // 版本血缘：沿 baseVersionId 上溯，再按修订号正序展示
    const lineage: ContentVersion[] = [];
    for (const fact of facts) {
      let cursor = fact.currentVersionId;
      const seen = new Set<string>();
      while (cursor && !seen.has(cursor)) {
        seen.add(cursor);
        const v = this.db.versions.find((x) => x.id === cursor);
        if (!v) break;
        lineage.push(v);
        cursor = v.baseVersionId;
      }
      // 未进入当前血缘链（被取代方案）的版本也保留，供完整溯源
      for (const v of this.db.versions.filter((x) => x.factId === fact.id && !seen.has(x.id))) {
        lineage.push(v);
      }
    }
    lineage.sort((a, b) => (a.factId === b.factId ? a.revisionNo - b.revisionNo : 0));

    return {
      matchedBy,
      factIds,
      versionLineage: lineage,
      publications: this.db.publications.filter((p) => factIds.includes(p.factId)),
      corrections: this.db.corrections.filter((c) => factIds.includes(c.factId)),
      translations: this.db.translations.filter((t) => correctionIds.has(t.correctionId)),
      citations: this.db.citations.filter((c) => citationIds.has(c.id)),
      timeline,
    };
  }

  // ---------- 内部 ----------

  private factView(fact: Fact): FactView {
    const publications = this.db.publications.filter((p) => p.factId === fact.id);
    const channelSlots: ChannelSlot[] = [];
    for (const channel of ["gallery_label", "audio_guide", "online_catalog", "printed_catalog"] as Channel[]) {
      const current = publications.find((p) => p.channel === channel && p.status === "published");
      if (current) {
        channelSlots.push({
          channel,
          publicationId: current.id,
          contentVersionId: current.contentVersionId,
          renderedText: current.renderedText,
          origin: current.origin,
          publishedAt: current.publishedAt,
          status: current.status,
          errata: current.errata,
          translationIds: current.translationIds,
        });
      }
    }

    const pendingCorrections = this.db.corrections
      .filter((c) => c.factId === fact.id && c.state !== "published")
      .map((c) => this.pendingView(c));

    const currentVersion = fact.currentVersionId
      ? this.db.versions.find((v) => v.id === fact.currentVersionId)
      : undefined;
    const citationIds = new Set<string>();
    for (const pub of publications) {
      const v = this.db.versions.find((x) => x.id === pub.contentVersionId);
      if (v) for (const cid of v.evidence.citationIds) citationIds.add(cid);
    }
    if (currentVersion) for (const cid of currentVersion.evidence.citationIds) citationIds.add(cid);
    const citationValidity = [...citationIds].map((cid) => {
      const citation = this.db.citations.find((c) => c.id === cid);
      return {
        citationId: cid,
        key: citation?.key ?? cid,
        status: (citation?.status ?? "valid") as Citation["status"],
      };
    });

    return {
      fact: { id: fact.id, kind: fact.kind, key: fact.key },
      ...(fact.currentVersionId ? { currentVersionId: fact.currentVersionId } : {}),
      channels: channelSlots,
      pendingCorrections,
      citationValidity,
    };
  }

  private pendingView(c: Correction): PendingCorrectionView {
    const proposedVersion = c.frozenVersionId
      ? this.db.versions.find((v) => v.id === c.frozenVersionId)
      : undefined;
    const proposedText = proposedVersion?.text ?? c.draft.text;
    const proposedCitations = proposedVersion?.evidence.citationIds ?? c.draft.evidence.citationIds;
    const baseVersion = c.baseVersionIdAtCreate
      ? this.db.versions.find((v) => v.id === c.baseVersionIdAtCreate)
      : undefined;
    const currentText = baseVersion?.text ?? null;
    const baseCitations = new Set(baseVersion?.evidence.citationIds ?? []);
    const reviews: PendingReviewView[] = c.requiredReviews.map((type) => {
      const latest = [...c.reviews]
        .reverse()
        .find(
          (r) =>
            r.type === type &&
            proposedVersion !== undefined &&
            r.versionHash === proposedVersion.sourceHash &&
            r.at > (c.lastReturnedAt ?? ""),
        );
      return {
        type,
        satisfied: latest?.decision === "approved",
        ...(latest ? { latestDecision: latest.decision, reviewer: latest.reviewer, at: latest.at } : {}),
      };
    });
    const translations = this.db.translations
      .filter((t) => t.correctionId === c.id)
      .map((t) => ({
        language: t.language,
        status: t.status,
        stale: t.stale,
        contentVersionId: t.contentVersionId,
      }));
    return {
      correctionId: c.id,
      state: c.state,
      channels: c.channels,
      draftRevision: c.draft.revision,
      ...(c.frozenVersionId ? { frozenVersionId: c.frozenVersionId } : {}),
      diff: {
        currentText,
        proposedText,
        textChanged: currentText !== proposedText,
        citationIdsAdded: proposedCitations.filter((id) => !baseCitations.has(id)),
        citationIdsRemoved: [...baseCitations].filter((id) => !proposedCitations.includes(id)),
      },
      reviews,
      evidenceFlags: c.evidenceFlags ?? [],
      ...(c.scheduledPublishAt ? { scheduledPublishAt: c.scheduledPublishAt } : {}),
      ...(c.scheduledChannels ? { scheduledChannels: c.scheduledChannels } : {}),
      targetLanguages: c.targetLanguages,
      translations,
    };
  }

  private citationView(citation: Citation): CitationView {
    return {
      id: citation.id,
      key: citation.key,
      title: citation.title,
      status: citation.status,
      ...(citation.retractedAt ? { retractedAt: citation.retractedAt } : {}),
      ...(citation.retractionNote ? { retractionNote: citation.retractionNote } : {}),
      usedByPublications: this.db.publications
        .filter((p) => {
          const v = this.db.versions.find((x) => x.id === p.contentVersionId);
          return v?.evidence.citationIds.includes(citation.id);
        })
        .map((p) => ({
          publicationId: p.id,
          channel: p.channel,
          factId: p.factId,
          noticeAppended: p.errata.some(
            (e) => e.kind === "retraction_notice" && e.citationId === citation.id,
          ),
        })),
      usedByCorrections: this.db.corrections
        .filter((c) => {
          const inDraft = c.draft.evidence.citationIds.includes(citation.id);
          const inFrozen =
            c.frozenVersionId !== undefined &&
            this.db.versions.find((v) => v.id === c.frozenVersionId)?.evidence.citationIds.includes(citation.id);
          return inDraft || inFrozen;
        })
        .map((c) => ({
          correctionId: c.id,
          state: c.state,
          flagged: (c.evidenceFlags ?? []).some((f) => f.citationId === citation.id),
        })),
    };
  }
}
