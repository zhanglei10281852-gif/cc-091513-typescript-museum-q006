import { createHash, randomBytes } from "node:crypto";

import type { Evidence } from "./types.js";

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

/** 对正文与证据计算稳定哈希，审核意见与译文均绑定该哈希对应的冻结版本。 */
export function contentHash(text: string, evidence: Evidence): string {
  const canonical = JSON.stringify({
    text,
    evidence: {
      citationIds: [...evidence.citationIds].sort(),
      expertOpinionIds: [...evidence.expertOpinionIds].sort(),
    },
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}
