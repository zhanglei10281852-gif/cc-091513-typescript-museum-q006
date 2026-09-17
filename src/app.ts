import { createApiServer } from "../src/http/api.js";
import { EditorialService } from "../src/domain/service.js";
import { InMemoryEventStore, type Clock } from "../src/domain/store.js";
import type { Server } from "node:http";

export const serviceName = "科学展签更正发布台";

export function healthPayload(): { status: "ok"; service: string } {
  return { status: "ok", service: serviceName };
}

/**
 * 进程内应用（健康检查/测试用）。生产组合根见 src/index.ts，
 * 它使用 .runtime/events.jsonl 持久化事件日志。
 */
export function createApp(options: { clock?: Clock } = {}): Server {
  const store = new InMemoryEventStore(options.clock);
  const service = new EditorialService(store, options.clock);
  return createApiServer({ service });
}
