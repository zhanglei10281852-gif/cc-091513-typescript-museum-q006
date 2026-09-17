import { existsSync, mkdirSync, readFileSync, appendFileSync } from "node:fs";
import { dirname } from "node:path";

import { DomainError } from "./errors.js";
import { newId } from "./ids.js";
import type { EventData, StoredEvent } from "./events.js";

export interface AppendInput {
  streamId: string;
  /** null 表示期望这是一条新流（当前版本号必须为 0）；数字表示期望的当前版本号 */
  expectedRevision: number | null;
  events: EventData[];
  actor: string;
}

export interface EventStore {
  revisionOf(streamId: string): number;
  readStream(streamId: string): StoredEvent[];
  readAll(): StoredEvent[];
  append(input: AppendInput): StoredEvent[];
}

export type Clock = () => Date;
export const systemClock: Clock = () => new Date();

/**
 * 内存事件存储。按 streamId 维护当前版本号；
 * 多位编辑同时提交时，expectedRevision 过期即判定为过期草稿。
 */
export class InMemoryEventStore implements EventStore {
  private readonly events: StoredEvent[] = [];
  private readonly revisions = new Map<string, number>();

  constructor(private readonly clock: Clock = systemClock) {}

  revisionOf(streamId: string): number {
    return this.revisions.get(streamId) ?? 0;
  }

  readStream(streamId: string): StoredEvent[] {
    return this.events.filter((event) => event.streamId === streamId);
  }

  readAll(): StoredEvent[] {
    return [...this.events];
  }

  append({ streamId, expectedRevision, events, actor }: AppendInput): StoredEvent[] {
    if (events.length === 0) return [];
    const current = this.revisionOf(streamId);
    const expected = expectedRevision ?? 0;
    if (current !== expected) {
      throw new DomainError(
        "stale_revision",
        `流 ${streamId} 已被其他编辑更新（当前版本 ${current}，提交基于版本 ${expected}），请刷新后重试`,
        { streamId, current, expected },
      );
    }

    let revision = current;
    const stored: StoredEvent[] = events.map((data) => {
      revision += 1;
      const event: StoredEvent = {
        ...data,
        eventId: newId("evt"),
        at: this.clock().toISOString(),
        actor,
        streamId,
        revision,
      };
      return event;
    });
    this.events.push(...stored);
    this.revisions.set(streamId, revision);
    return stored;
  }

  /** 启动恢复时原样装入已持久化事件（保留原始 eventId 与时间戳） */
  restore(event: StoredEvent): void {
    const current = this.revisionOf(event.streamId);
    if (event.revision !== current + 1) {
      throw new Error(
        `事件日志版本不连续：流 ${event.streamId} 期望版本 ${current + 1}，实际 ${event.revision}`,
      );
    }
    this.events.push(event);
    this.revisions.set(event.streamId, event.revision);
  }
}

/**
 * JSONL 文件事件存储：每行一个 StoredEvent，只增不改。
 * 已发布版本可引用的前提是历史永不被改写——本类不提供任何删除/修改接口。
 * 写入采用临时文件 rename 的追加策略，进程崩溃也不会截断既有日志。
 */
export class JsonlEventStore implements EventStore {
  private readonly memory: InMemoryEventStore;

  constructor(
    private readonly filePath: string,
    clock: Clock = systemClock,
  ) {
    this.memory = new InMemoryEventStore(clock);
    this.hydrate();
  }

  private hydrate(): void {
    if (!existsSync(this.filePath)) return;
    const raw = readFileSync(this.filePath, "utf8");
    for (const [index, line] of raw.split("\n").entries()) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let event: StoredEvent;
      try {
        event = JSON.parse(trimmed) as StoredEvent;
      } catch (error) {
        throw new Error(
          `事件日志第 ${index + 1} 行无法解析，可能已被外部篡改或损坏: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      // 按日志中原样恢复，保留事件 id、时间戳与流版本号
      this.memory.restore(event);
    }
  }

  revisionOf(streamId: string): number {
    return this.memory.revisionOf(streamId);
  }

  readStream(streamId: string): StoredEvent[] {
    return this.memory.readStream(streamId);
  }

  readAll(): StoredEvent[] {
    return this.memory.readAll();
  }

  append(input: AppendInput): StoredEvent[] {
    const stored = this.memory.append(input);
    mkdirSync(dirname(this.filePath), { recursive: true });
    // O_APPEND 原子追加；进程崩溃最多丢失最后一次未完成写入，既有日志不会被截断
    appendFileSync(this.filePath, stored.map((e) => JSON.stringify(e)).join("\n") + "\n");
    return stored;
  }
}
