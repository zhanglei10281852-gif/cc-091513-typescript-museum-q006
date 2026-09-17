import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  CHANNELS,
  CLARIFICATION_KINDS,
  CONTENT_STATES,
  EXPERT_STANCES,
  FACT_KINDS,
  REVIEW_DECISIONS,
  REVIEW_TYPES,
} from "./constants.js";

export interface ReferenceEnums {
  content_states: string[];
  review_types: string[];
  channels: string[];
  fact_kinds: string[];
  review_decisions: string[];
  expert_stances: string[];
  clarification_kinds: string[];
}

/**
 * 读取并校验 reference/domain.json。代码常量是运行时事实来源，
 * 参考文件若与代码漂移应在启动时直接失败，而不是把错误枚举带到接口里。
 */
export function loadReferenceEnums(
  filePath = resolve("reference/domain.json"),
): ReferenceEnums {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(
      `无法读取参考枚举 ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const enums = parsed as Partial<ReferenceEnums>;
  const problems: string[] = [];
  for (const [key, expected] of [
    ["content_states", CONTENT_STATES],
    ["review_types", REVIEW_TYPES],
    ["channels", CHANNELS],
    ["fact_kinds", FACT_KINDS],
    ["review_decisions", REVIEW_DECISIONS],
    ["expert_stances", EXPERT_STANCES],
    ["clarification_kinds", CLARIFICATION_KINDS],
  ] as const) {
    const actual = enums[key] as unknown;
    if (!Array.isArray(actual)) {
      problems.push(`${key} 缺失或不是数组`);
      continue;
    }
    const missing = expected.filter((v) => !actual.includes(v));
    if (missing.length > 0) problems.push(`${key} 缺少代码中使用的枚举: ${missing.join(", ")}`);
  }
  if (problems.length > 0) {
    throw new Error(`参考枚举与领域代码不一致：\n- ${problems.join("\n- ")}`);
  }
  return enums as ReferenceEnums;
}
