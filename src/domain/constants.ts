// 领域枚举。reference/domain.json 中的公开枚举应与本文件保持一致，
// 启动时由 reference.ts 校验，避免代码与参考数据脱节。

export const CONTENT_STATES = [
  "draft",
  "reviewing",
  "approved",
  "scheduled",
  "published",
  "superseded",
] as const;

export const REVIEW_TYPES = ["scientific", "language", "legal"] as const;

export const CHANNELS = [
  "gallery_label",
  "audio_guide",
  "online_catalog",
  "printed_catalog",
] as const;

export const FACT_KINDS = [
  "scientific_name",
  "distribution",
  "morphology",
  "ecology",
  "other",
] as const;

export const REVIEW_DECISIONS = ["approved", "changes_requested", "rejected"] as const;

export const EXPERT_STANCES = ["supporting", "dissenting", "neutral"] as const;

export const CLARIFICATION_KINDS = [
  "emergency_correction",
  "retraction_notice",
  "editorial_notice",
] as const;

export type ContentState = (typeof CONTENT_STATES)[number];
export type ReviewType = (typeof REVIEW_TYPES)[number];
export type Channel = (typeof CHANNELS)[number];
export type FactKind = (typeof FACT_KINDS)[number];
export type ReviewDecision = (typeof REVIEW_DECISIONS)[number];
export type ExpertStance = (typeof EXPERT_STANCES)[number];
export type ClarificationKind = (typeof CLARIFICATION_KINDS)[number];

/** 事实候选版本的生命周期（content_states 的细化用法） */
export type VersionStatus =
  | "candidate"
  | "reviewing"
  | "approved"
  | "rejected"
  | "published"
  | "superseded";

export type TranslationStatus = "pending" | "approved" | "rejected";

export type EditionStatus =
  | "draft"
  | "scheduled"
  | "published"
  | "superseded"
  | "cancelled";
