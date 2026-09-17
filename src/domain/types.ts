/**
 * 领域类型定义。
 *
 * 内容状态、审核类型与渠道枚举与 reference/domain.json 保持一致。
 */

export const CONTENT_STATES = [
  "draft",
  "reviewing",
  "approved",
  "scheduled",
  "published",
  "superseded",
] as const;
export type ContentState = (typeof CONTENT_STATES)[number];

export const REVIEW_TYPES = ["scientific", "language", "legal"] as const;
export type ReviewType = (typeof REVIEW_TYPES)[number];

export const CHANNELS = [
  "gallery_label",
  "audio_guide",
  "online_catalog",
  "printed_catalog",
] as const;
export type Channel = (typeof CHANNELS)[number];

export const FACT_KINDS = ["scientific_name", "distribution", "other"] as const;
export type FactKind = (typeof FACT_KINDS)[number];

export type ReviewDecision = "approved" | "changes_requested" | "rejected";

export type CitationStatus = "valid" | "retracted";

export type Clock = () => string;

export interface Zone {
  id: string;
  code: string;
  name: string;
  createdAt: string;
}

export interface Taxon {
  id: string;
  scientificName: string;
  zoneIds: string[];
  createdAt: string;
}

export interface Citation {
  id: string;
  /** 短引用标识，例如 Wang2023 */
  key: string;
  title: string;
  authors: string;
  year?: string;
  doi?: string;
  status: CitationStatus;
  retractedAt?: string;
  retractionNote?: string;
  createdAt: string;
}

export interface ExpertOpinion {
  id: string;
  taxonId: string;
  expert: string;
  discipline: string;
  summary: string;
  documentRef?: string;
  receivedAt: string;
}

export interface Evidence {
  citationIds: string[];
  expertOpinionIds: string[];
}

export interface Fact {
  id: string;
  taxonId: string;
  kind: FactKind;
  /** 同一物种下同类事实的稳定槽位，例如 current_scientific_name */
  key: string;
  /** 当前已出版版本；尚无出版内容时为空 */
  currentVersionId?: string;
  createdAt: string;
}

/**
 * 不可变内容版本：候选更正提交时冻结，出版的是版本快照而非可变草稿。
 * baseVersionId 记录从上一版正文分叉，构成文字血缘链。
 */
export interface ContentVersion {
  id: string;
  factId: string;
  origin: "baseline" | "correction";
  revisionNo: number;
  baseVersionId?: string;
  text: string;
  evidence: Evidence;
  /** 正文与证据的哈希，审核意见绑定该哈希；正文一改，旧批准自动失效 */
  sourceHash: string;
  correctionId?: string;
  createdBy: string;
  createdAt: string;
}

export interface DraftBody {
  text: string;
  rationale: string;
  evidence: Evidence;
}

export interface Correction {
  id: string;
  taxonId: string;
  factId: string;
  channels: Channel[];
  targetLanguages: string[];
  requiredReviews: ReviewType[];
  state: ContentState;
  draft: DraftBody & { revision: number; updatedBy: string; updatedAt: string };
  /** 当前冻结版本；重新提交会生成新冻结版本 */
  frozenVersionId?: string;
  frozenRevisionNo: number;
  reviews: ReviewRecord[];
  /** 最近一次被退回草稿的时间；该时间之前的“同意”不再计入有效审核 */
  lastReturnedAt?: string;
  /** 证据中已撤回的引文；标注受影响段落，但系统不自动认可替代结论 */
  evidenceFlags?: { citationId: string; at: string }[];
  scheduledPublishAt?: string;
  scheduledChannels?: Channel[];
  publishedAt?: string;
  baseVersionIdAtCreate?: string;
  createdBy: string;
  createdAt: string;
}

export interface ReviewRecord {
  id: string;
  type: ReviewType;
  reviewer: string;
  decision: ReviewDecision;
  comment?: string;
  /** 该意见针对的冻结版本哈希 */
  versionHash: string;
  at: string;
}

export interface Translation {
  id: string;
  correctionId: string;
  /** 译文绑定的具体源版本，而不是“最新版”这类浮动引用 */
  contentVersionId: string;
  language: string;
  text: string;
  translator: string;
  status: "draft" | "approved" | "rejected";
  review?: { reviewer: string; comment?: string; at: string };
  /** 源候选重新提交产生新冻结版本后，旧译文标记过期 */
  stale: boolean;
  createdAt: string;
}

export type ErratumKind = "emergency_notice" | "retraction_notice";

export interface Erratum {
  id: string;
  kind: ErratumKind;
  message: string;
  citationId?: string;
  createdBy: string;
  createdAt: string;
}

export interface Publication {
  id: string;
  factId: string;
  taxonId: string;
  channel: Channel;
  contentVersionId: string;
  /** 出版时随附的译文快照引用 */
  translationIds: string[];
  /** 出版时定格的正文，之后永不改写 */
  renderedText: string;
  origin: "baseline" | "correction";
  correctionId?: string;
  status: "published" | "superseded";
  publishedAt: string;
  publishedBy: string;
  supersededAt?: string;
  supersededByPublicationId?: string;
  /** 追加式勘误标记，原始正文不受影响 */
  errata: Erratum[];
}

/** 追加式学术决定日志，是文字溯源的依据 */
export interface DecisionEvent {
  seq: number;
  at: string;
  type: string;
  actor?: string;
  factId?: string;
  correctionId?: string;
  publicationId?: string;
  contentVersionId?: string;
  citationId?: string;
  translationId?: string;
  detail?: Record<string, unknown>;
}

export interface Database {
  zones: Zone[];
  taxa: Taxon[];
  citations: Citation[];
  opinions: ExpertOpinion[];
  facts: Fact[];
  versions: ContentVersion[];
  corrections: Correction[];
  translations: Translation[];
  publications: Publication[];
  events: DecisionEvent[];
}
