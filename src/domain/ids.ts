import { randomUUID } from "node:crypto";

/** 生成带前缀的稳定标识，便于在事件流与接口中辨认类型 */
export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}
