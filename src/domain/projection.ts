import type {
  Channel,
  EditionStatus,
  ExpertStance,
  ReviewDecision,
  ReviewType,
  TranslationStatus,
  VersionStatus,
} from "./constants.js";
import type {
  PublishedSnapshotItem,
  StoredEvent,
} from "./events.js";

export interface Citation {
  id: string;
  doi: string | null;
  title: string;
  authors: string[];
  year: number;
  url: string | null;
  retracted: { at: string; reason: string; noticeSource: string } | null;
}

export interface Opinion {
  id: string;
  versionId: string | null;
  expert: string;
  affiliation: string;
  stance: ExpertStance;
  content: string;
  at: string;
}

export interface Review {
  id: string;
  targetType: "version" | "translation";
  targetId: string;
  reviewType: ReviewType;
  reviewer: string;
  decision: ReviewDecision;
  comments: string;
  round: number;
  targetTextRevision: number | null;
  at: string;
}

export interface FactVersion {
  id: string;
  basedOnVersionId: string | null;
  proposalId: string | null;
  sequence: number;
  text: string;
  rationale: string;
  contentHash: string;
  replacesPublished: boolean;
  reviews: Review[];
  citationIds: string[];
}

export interface Translation {
  id: string;
  sourceVersionId: string;
  language: string;
  text: string;
  translator: string;
  /** 文本修订号：每次 revise 递增，语言审核绑定具体修订号 */
  textRevision: number;
  createdAt: string;
  revisedAt: string;
}

export interface Clarification {
  id: string;
  kind: "emergency_correction" | "retraction_notice" | "editorial_notice";
  text: string;
  marker: string;
  citationId: string | null;
  affectedLanguages: string[];
  at: string;
  actor: string;
}

export interface Edition {
  id: string;
  channel: Channel;
  versionId: string;
  items: PublishedSnapshotItem[];
  note: string;
  status: EditionStatus;
  requiresLegal: boolean;
  createdAt: string;
  updatedAt: string;
  scheduledAt: string | null;
  publishedAt: string | null;
  clarifications: Clarification[];
  /** 发布瞬间冻结的快照；未发布为 null */
  snapshot: {
    versionText: string;
    items: PublishedSnapshotItem[];
    citations: { citationId: string; title: string; doi: string | null }[];
    publishedAt: string;
  } | null;
}

export interface Fact {
  id: string;
  speciesCode: string;
  speciesName: string;
  exhibitZone: string;
  kind: string;
  language: string;
  currentText: string;
  note: string;
  registeredAt: string;
  versions: Map<string, FactVersion>;
  versionOrder: string[];
  translations: Map<string, Translation>;
  editions: Map<string, Edition>;
  opinions: Opinion[];
}

export interface ProjectionState {
  facts: Map<string, Fact>;
  citations: Map<string, Citation>;
}

export function emptyState(): ProjectionState {
  return { facts: new Map(), citations: new Map() };
}

export function fold(state: ProjectionState, event: StoredEvent): ProjectionState {
  switch (event.type) {
    case "FactRegistered": {
      state.facts.set(event.factId, {
        id: event.factId,
        speciesCode: event.speciesCode,
        speciesName: event.speciesName,
        exhibitZone: event.exhibitZone,
        kind: event.kind,
        language: event.language,
        currentText: event.currentText,
        note: event.note,
        registeredAt: event.at,
        versions: new Map(),
        versionOrder: [],
        translations: new Map(),
        editions: new Map(),
        opinions: [],
      });
      break;
    }

    case "FactVersionProposed": {
      const fact = state.facts.get(event.factId);
      if (!fact) break;
      fact.versionOrder.push(event.versionId);
      fact.versions.set(event.versionId, {
        id: event.versionId,
        basedOnVersionId: event.basedOnVersionId,
        proposalId: event.proposalId,
        sequence: fact.versionOrder.length,
        text: event.text,
        rationale: event.rationale,
        contentHash: event.contentHash,
        replacesPublished: event.replacesPublished,
        reviews: [],
        citationIds: [],
      });
      break;
    }

    case "CitationRegistered": {
      state.citations.set(event.citationId, {
        id: event.citationId,
        doi: event.doi,
        title: event.title,
        authors: event.authors,
        year: event.year,
        url: event.url,
        retracted: null,
      });
      break;
    }

    case "CitationLinked": {
      const version = state.facts.get(event.factId)?.versions.get(event.versionId);
      if (version && !version.citationIds.includes(event.citationId)) {
        version.citationIds.push(event.citationId);
      }
      break;
    }

    case "CitationRetracted": {
      const citation = state.citations.get(event.citationId);
      if (citation && !citation.retracted) {
        citation.retracted = {
          at: event.retractedAt,
          reason: event.reason,
          noticeSource: event.noticeSource,
        };
      }
      break;
    }

    case "ExpertOpinionRecorded": {
      const fact = state.facts.get(event.factId);
      if (fact) {
        fact.opinions.push({
          id: event.opinionId,
          versionId: event.versionId,
          expert: event.expert,
          affiliation: event.affiliation,
          stance: event.stance,
          content: event.content,
          at: event.at,
        });
      }
      break;
    }

    case "ReviewSubmitted": {
      const review: Review = {
        id: event.reviewId,
        targetType: event.targetType,
        targetId: event.targetId,
        reviewType: event.reviewType,
        reviewer: event.reviewer,
        decision: event.decision,
        comments: event.comments,
        round: event.round,
        targetTextRevision: event.targetTextRevision,
        at: event.at,
      };
      const fact = state.facts.get(event.factId);
      if (!fact) break;
      if (event.targetType === "version") {
        // 学科学审 / 法定审核直接挂在候选版本上
        fact.versions.get(event.targetId)?.reviews.push(review);
      } else {
        // 语言审核挂在“译文所绑定的源版本”上，保证按版本追溯时审核决定不丢失；
        // 是否仍有效由 translationReviews 按译文最后修订时间判定（修订即作废旧审核）
        reviewTranslation(fact, event.targetId, review);
      }
      break;
    }

    case "TranslationRecorded": {
      const fact = state.facts.get(event.factId);
      if (fact) {
        fact.translations.set(event.translationId, {
          id: event.translationId,
          sourceVersionId: event.sourceVersionId,
          language: event.language,
          text: event.text,
          translator: event.translator,
          textRevision: 1,
          createdAt: event.at,
          revisedAt: event.at,
        });
      }
      break;
    }

    case "TranslationRevised": {
      const translation = state.facts.get(event.factId)?.translations.get(event.translationId);
      if (translation) {
        translation.text = event.text;
        translation.textRevision += 1;
        translation.revisedAt = event.at;
      }
      break;
    }

    case "EditionCreated": {
      const fact = state.facts.get(event.factId);
      if (fact) {
        fact.editions.set(event.editionId, {
          id: event.editionId,
          channel: event.channel,
          versionId: event.versionId,
          items: event.items,
          note: event.note,
          status: "draft",
          requiresLegal: event.requiresLegal ?? false,
          createdAt: event.at,
          updatedAt: event.at,
          scheduledAt: null,
          publishedAt: null,
          clarifications: [],
          snapshot: null,
        });
      }
      break;
    }

    case "EditionDraftUpdated": {
      const edition = state.facts.get(event.factId)?.editions.get(event.editionId);
      if (edition && edition.status === "draft") {
        edition.versionId = event.versionId;
        edition.items = event.items;
        edition.note = event.note;
        edition.updatedAt = event.at;
      }
      break;
    }

    case "EditionScheduled": {
      const edition = state.facts.get(event.factId)?.editions.get(event.editionId);
      if (edition && (edition.status === "draft" || edition.status === "scheduled")) {
        edition.status = "scheduled";
        edition.scheduledAt = event.publishAt;
        edition.updatedAt = event.at;
      }
      break;
    }

    case "EditionPublished": {
      const fact = state.facts.get(event.factId);
      const edition = fact?.editions.get(event.editionId);
      if (fact && edition) {
        // 同渠道先前已发布版面进入 superseded，但快照保留、仍可引用
        for (const prior of fact.editions.values()) {
          if (prior.channel === event.channel && prior.id !== event.editionId && prior.status === "published") {
            prior.status = "superseded";
          }
        }
        edition.status = "published";
        edition.publishedAt = event.at;
        edition.scheduledAt = null;
        edition.updatedAt = event.at;
        edition.snapshot = {
          versionText: event.snapshot.versionText,
          items: event.snapshot.items,
          citations: event.snapshot.citations,
          publishedAt: event.at,
        };
      }
      break;
    }

    case "EditionCancelled": {
      const edition = state.facts.get(event.factId)?.editions.get(event.editionId);
      if (edition && (edition.status === "draft" || edition.status === "scheduled")) {
        edition.status = "cancelled";
        edition.scheduledAt = null;
        edition.updatedAt = event.at;
      }
      break;
    }

    case "ClarificationAppended": {
      const edition = state.facts.get(event.factId)?.editions.get(event.editionId);
      if (edition) {
        edition.clarifications.push({
          id: event.clarificationId,
          kind: event.kind,
          text: event.text,
          marker: event.marker,
          citationId: event.citationId ?? null,
          affectedLanguages: event.affectedLanguages ?? [],
          at: event.at,
          actor: event.actor,
        });
      }
      break;
    }
  }
  return state;
}

function reviewTranslation(
  fact: Fact,
  translationId: string,
  review: Review,
): void {
  // 语言审核挂在“该译文所绑定的源版本”上，保证按版本追溯时审核决定不丢失
  const translation = fact.translations.get(translationId);
  if (!translation) return;
  fact.versions.get(translation.sourceVersionId)?.reviews.push(review);
}

/** 某译文在当前文本修订号上收到的语言审核（旧稿审核不参与放行） */
export function translationReviews(fact: Fact, translation: Translation): Review[] {
  const version = fact.versions.get(translation.sourceVersionId);
  if (!version) return [];
  return version.reviews
    .filter((r) => r.targetType === "translation" && r.targetId === translation.id)
    .filter((r) => r.targetTextRevision === translation.textRevision);
}

export function latestDecision(
  reviews: Review[],
  reviewType: ReviewType,
): Review | undefined {
  return reviews
    .filter((r) => r.targetType === "version" && r.reviewType === reviewType)
    .sort((a, b) => (a.round === b.round ? a.at.localeCompare(b.at) : a.round - b.round))
    .at(-1);
}

/**
 * 候选版本状态：
 * 任一学科学审/法定审核最终决定为 rejected → rejected；
 * 必需审核全部 approved → approved；存在审核但未定谳 → reviewing；否则 candidate。
 */
export function versionStatus(
  fact: Fact,
  version: FactVersion,
  legalRequired: boolean,
): VersionStatus {
  void fact;
  const types: ReviewType[] = legalRequired ? ["scientific", "legal"] : ["scientific"];
  const decisions = types.map((t) => latestDecision(version.reviews, t));
  if (decisions.some((d) => d?.decision === "rejected")) return "rejected";
  if (decisions.every((d) => d?.decision === "approved")) return "approved";
  if (version.reviews.some((r) => r.targetType === "version")) return "reviewing";
  return "candidate";
}

export function translationStatus(fact: Fact, translation: Translation): TranslationStatus {
  const latest = translationReviews(fact, translation)
    .sort((a, b) => a.at.localeCompare(b.at))
    .at(-1);
  if (latest?.decision === "approved") return "approved";
  if (latest?.decision === "rejected") return "rejected";
  return "pending";
}

export function project(events: StoredEvent[]): ProjectionState {
  return events.reduce((state, event) => fold(state, event), emptyState());
}
