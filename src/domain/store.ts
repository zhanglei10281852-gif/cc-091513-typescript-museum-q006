import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { Clock, Database, DecisionEvent } from "./types.js";

export function emptyDatabase(): Database {
  return {
    zones: [],
    taxa: [],
    citations: [],
    opinions: [],
    facts: [],
    versions: [],
    corrections: [],
    translations: [],
    publications: [],
    events: [],
  };
}

/**
 * 文件型仓储。整个服务以单进程串行方式处理变更，因此写时整体落盘即可；
 * 事件流是追加式的，快照文件只是当前物化状态，溯源以 events 为准。
 */
export class Store {
  private db: Database;

  private constructor(
    private readonly path: string | undefined,
    db: Database,
    private readonly clock: Clock,
  ) {
    this.db = db;
  }

  static open(path: string | undefined, clock: Clock): Store {
    let db = emptyDatabase();
    if (path) {
      try {
        const raw = readFileSync(path, "utf8");
        db = { ...emptyDatabase(), ...(JSON.parse(raw) as Database) };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return new Store(path, db, clock);
  }

  get data(): Database {
    return this.db;
  }

  /** 在一次变更回调内执行并整体落盘；回调返回的结果透传给调用方。 */
  mutate<T>(fn: (tx: Transaction) => T): T {
    const tx = new Transaction(this.db, this.clock);
    const result = fn(tx);
    this.flush();
    return result;
  }

  flush(): void {
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.db), "utf8");
    // rename 是原子的：进程中途崩溃不会留下半截 JSON
    renameSync(tmp, this.path);
  }
}

/**
 * 事务句柄：所有写操作必须经过它，保证每个学术动作都留下追加式事件。
 * 读取也走事务，便于在同一快照上完成校验。
 */
export class Transaction {
  constructor(
    readonly db: Database,
    private readonly clock: Clock,
  ) {}

  now(): string {
    return this.clock();
  }

  record(type: string, detail?: Record<string, unknown>): DecisionEvent {
    const last = this.db.events[this.db.events.length - 1];
    const event: DecisionEvent = {
      seq: last ? last.seq + 1 : 1,
      at: this.now(),
      type,
      ...(detail ?? {}),
    };
    this.db.events.push(event);
    return event;
  }
}
