import type { EditorialService } from "./service.js";
import type { Clock } from "./store.js";

export interface PublishResult {
  factId: string;
  editionId: string;
  publishedAt: string;
}

export interface PublishFailure extends PublishResult {
  error: string;
  blockers?: string[];
}

export interface DuePublishingResult {
  published: PublishResult[];
  failed: PublishFailure[];
}

/**
 * 发布器：扫描到达指定发布时间的已排期版面并发布。
 * 发布前闸门会再次校验（证据可能在等待期间被撤回、审核可能变化）。
 * 系统发布身份固定为 publisher，与人工编辑区分。
 */
export async function publishDueEditions(
  service: EditorialService,
  actor = "publisher",
  clock: Clock = () => new Date(),
): Promise<DuePublishingResult> {
  const published: PublishResult[] = [];
  const failed: PublishFailure[] = [];

  for (const due of service.dueEditions(clock())) {
    const revision = service.revisionOf(due.factId);
    try {
      const result = service.publishEdition(
        due.factId,
        { editionId: due.editionId },
        revision,
        actor,
      );
      published.push({ factId: due.factId, editionId: due.editionId, publishedAt: result.publishedAt });
    } catch (error) {
      failed.push({
        factId: due.factId,
        editionId: due.editionId,
        publishedAt: clock().toISOString(),
        error: error instanceof Error ? error.message : String(error),
        blockers:
          error && typeof error === "object" && "details" in error
            ? ((error as { details?: { blockers?: string[] } }).details?.blockers ?? [])
            : [],
      });
    }
  }
  return { published, failed };
}
