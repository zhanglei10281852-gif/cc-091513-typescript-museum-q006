import type {
  Channel,
  ExpertStance,
  FactKind,
  ReviewDecision,
  ReviewType,
} from "./constants.js";

/**
 * 领域事件：系统的唯一事实来源是只增不改的事件日志。
 * 已发布内容、审核状态、撤回标记全部由投影重放得到，
 * 因此任何文字都可以沿事件链回溯其经历的学术决定。
 *
 * streamId：并发控制单元。同一事实（含其候选版本、译文、版面）
 * 的事件 streamId 均为该事实 id；引文登记使用 citation:<id>。
 * revision：该流追加本事件后的序号，乐观锁据此检测过期草稿。
 */
export interface EventMeta {
  eventId: string;
  type: string;
  at: string;
  actor: string;
  streamId: string;
  revision: number;
}

export interface PublishedSnapshotItem {
  language: string;
  text: string;
  /** null 表示原文（事实语言），否则为译文 id */
  translationId: string | null;
  translator: string | null;
}

export interface PublishedCitationRef {
  citationId: string;
  title: string;
  doi: string | null;
}

export type EventData =
  | {
      type: "FactRegistered";
      factId: string;
      speciesCode: string;
      speciesName: string;
      exhibitZone: string;
      kind: FactKind;
      currentText: string;
      note: string;
      /** 事实原文语言，译文均以它为源语言 */
      language: string;
    }
  | {
      type: "FactVersionProposed";
      factId: string;
      versionId: string;
      /** 本候选所基于的候选版本（同一事实上的新版本链），首个候选为 null */
      basedOnVersionId: string | null;
      /** 若候选由某个更正提案产生，记录其关联 */
      proposalId: string | null;
      text: string;
      rationale: string;
      contentHash: string;
      replacesPublished: boolean;
    }
  | {
      type: "CitationRegistered";
      citationId: string;
      doi: string | null;
      title: string;
      authors: string[];
      year: number;
      url: string | null;
    }
  | {
      type: "CitationLinked";
      factId: string;
      versionId: string;
      citationId: string;
    }
  | {
      type: "CitationRetracted";
      citationId: string;
      retractedAt: string;
      reason: string;
      noticeSource: string;
    }
  | {
      type: "ExpertOpinionRecorded";
      opinionId: string;
      factId: string;
      /** 针对具体候选版本的意见；针对事实层面争议的意见为 null */
      versionId: string | null;
      expert: string;
      affiliation: string;
      stance: ExpertStance;
      content: string;
    }
  | {
      type: "ReviewSubmitted";
      reviewId: string;
      factId: string;
      targetType: "version" | "translation";
      targetId: string;
      reviewType: ReviewType;
      reviewer: string;
      decision: ReviewDecision;
      comments: string;
      round: number;
      /** 语言审核针对的译文文本修订号；译文修订后旧号上的审核自动失效 */
      targetTextRevision: number | null;
    }
  | {
      type: "TranslationRecorded";
      translationId: string;
      factId: string;
      sourceVersionId: string;
      language: string;
      text: string;
      translator: string;
    }
  | {
      type: "TranslationRevised";
      translationId: string;
      factId: string;
      text: string;
      /** 译文可迭代文字，但源版本绑定不可变；修订后原语言审核作废 */
    }
  | {
      type: "EditionCreated";
      editionId: string;
      factId: string;
      channel: Channel;
      versionId: string;
      items: PublishedSnapshotItem[];
      note: string;
      /** 该版面是否需要法定（如版权/合规）审核，创建时确定 */
      requiresLegal: boolean;
    }
  | {
      type: "EditionDraftUpdated";
      editionId: string;
      factId: string;
      versionId: string;
      items: PublishedSnapshotItem[];
      note: string;
    }
  | {
      type: "EditionScheduled";
      editionId: string;
      factId: string;
      publishAt: string;
    }
  | {
      type: "EditionPublished";
      editionId: string;
      factId: string;
      channel: Channel;
      versionId: string;
      items: PublishedSnapshotItem[];
      /** 发布瞬间冻结的快照（含引文清单），此后原文永不被悄悄修改 */
      snapshot: {
        versionText: string;
        items: PublishedSnapshotItem[];
        citations: PublishedCitationRef[];
      };
    }
  | {
      type: "EditionCancelled";
      editionId: string;
      factId: string;
      reason: string;
    }
  | {
      type: "ClarificationAppended";
      clarificationId: string;
      editionId: string;
      factId: string;
      kind: "emergency_correction" | "retraction_notice" | "editorial_notice";
      text: string;
      /** 渠道上展示的醒目标记文案，如【紧急勘误】 */
      marker: string;
      /** 撤回通知关联的引文 id；其他类型为 null */
      citationId: string | null;
      /** 追加时冻结的受影响语言段落（原文/各译文），只标出不替换 */
      affectedLanguages: string[];
    };

export type StoredEvent = EventData & EventMeta;
