import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

import { createApiServer } from "./http/api.js";
import { publishDueEditions } from "./domain/publisher.js";
import { loadReferenceEnums } from "./domain/reference.js";
import { EditorialService } from "./domain/service.js";
import { JsonlEventStore } from "./domain/store.js";

const port = Number.parseInt(process.env.PORT ?? "8000", 10);
const host = process.env.HOST ?? "0.0.0.0";
const runtimeDir = process.env.RUNTIME_DIR ?? resolve(".runtime");
const eventLogPath = resolve(runtimeDir, "events.jsonl");
const tickMs = Number.parseInt(process.env.PUBLISH_TICK_MS ?? "1000", 10);

// 启动即校验参考枚举与代码一致，漂移直接失败
loadReferenceEnums(resolve("reference/domain.json"));

mkdirSync(runtimeDir, { recursive: true });
const store = new JsonlEventStore(eventLogPath);
const service = new EditorialService(store);
const server = createApiServer({ service, referencePath: resolve("reference/domain.json") });

// 定时发布：到达指定发布日期的版面自动发布；闸门失败只记录、不强行放行
const ticker = setInterval(() => {
  publishDueEditions(service)
    .then((result) => {
      if (result.published.length > 0 || result.failed.length > 0) {
        process.stdout.write(`[publisher] ${JSON.stringify(result)}\n`);
      }
    })
    .catch((error: unknown) => {
      process.stderr.write(`[publisher] ${error instanceof Error ? error.message : String(error)}\n`);
    });
}, tickMs);
ticker.unref();

server.listen(port, host, () => {
  process.stdout.write(
    `service listening on ${host}:${port}（事件日志 ${eventLogPath}）\n`,
  );
});
