# 科学展签更正发布台

面向自然博物馆科学事实、引文、专家意见、多语言译文和多渠道展签发布的 TypeScript 后端服务。

科学结论以**带证据的候选更正**进入流程，经学科与语言审核后按指定日期发布；已出版版本永久可引用，紧急勘误与来源撤回只追加醒目标记、不改写原文；译文绑定具体源版本；任何文字都可追溯其经历的全部学术决定。详见 [`docs/domain.md`](docs/domain.md)。

## 运行

需要 Node.js 22 或更高版本。

```bash
npm ci          # 安装依赖
npm test        # 类型检查 + 全部测试（node:test）
npm start       # 启动已编译服务，默认 0.0.0.0:8000
```

- `GET /health`：进程健康检查。
- 数据文件位置由 `DATA_PATH` 控制（默认 `.runtime/db.json`，JSON 原子落盘）；留空则为纯内存库，多用于测试。
- 到期候选不会自动出版，由调度方或人工调用 `POST /publications/due` 触发。
- 也可以使用 `docker compose up --build` 启动容器（构建阶段会运行测试）。

## 快速示例

```bash
curl -XPOST localhost:8000/zones -H 'content-type: application/json' \
  -d '{"actor":"admin","code":"BIRD","name":"鸟类厅"}'
curl localhost:8000/boards/zones/<zoneId>
curl "localhost:8000/provenance?text=$(python3 -c 'import urllib.parse;print(urllib.parse.quote("喜鹊 Pica pica"))')"
```

## 代码结构

- `src/domain/types.ts`：领域模型与枚举（与 `reference/domain.json` 一致）。
- `src/domain/service.ts`：命令侧——工作流、审核闸口、出版、撤回、勘误，逐条记录决定事件。
- `src/domain/queries.ts`：查询侧——物种/展区看板、引用有效性、文字溯源。
- `src/domain/store.ts`：JSON 仓储（原子写）与追加式事件。
- `src/http.ts`：HTTP 路由与结构化错误。
- `tests/`：领域规则测试与 HTTP 端到端测试。
