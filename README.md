# 科学展签更正发布台

面向自然博物馆科学事实、译文和多渠道展签发布的 TypeScript 后端服务。

## 解决什么问题

分类学专家通知某种鸟的学名与分布已修订，但馆内纸质展签、语音导览、线上图录用的
不是同一稿。直接全文替换会把仍有争议的结论提前发布。本系统保证：

- 科学修订先成为**带证据的候选更正**，经相应学科与语言审核后才能进入指定发布日期；
- 已出版版本**冻结快照、保持可引用**，紧急勘误/撤回通知**只能追加醒目标记**，不能改原文；
- 译文**绑定具体源版本**；来源撤回**标出受影响段落但不自动认可替代结论**；
- 多位编辑并发修改时以**流版本乐观锁（If-Match / X-Stream-Revision）**检测过期草稿；
- 馆方可按物种/展区在看板看清各渠道当前内容、待审核差异、引文有效性与计划发布时间；
- 从任一文字通过 `/trace` 可追溯它经历的全部学术决定（提案、证据、异议、审核、
  译文修订、排期发布、标记）。

## 运行

需要 Node.js 22 或更高版本。执行 `npm ci`（或 `npm install`）安装依赖，
`npm test` 完成编译与测试，`npm start` 启动已编译服务。事件日志默认写入
`.runtime/events.jsonl`，可用 `RUNTIME_DIR` 环境变量更改。服务默认监听 8000 端口。
也可以使用 `docker compose up --build` 启动容器。

## API 概览

并发约定：命令请求需带 `If-Match: <revision>`（取值来自此前响应的
`X-Stream-Revision` 头或资源中的 `revision` 字段），过期得到 `412`；
操作者通过 `X-Actor` 头标识。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 进程状态 |
| GET | `/reference/enums` | 参考枚举（启动时校验与代码一致） |
| POST | `/facts` | 登记科学事实 |
| GET | `/facts`、`/facts/:id` | 事实列表 / 详情（含版本、译文、版面） |
| GET | `/facts/:id/timeline` | 原始事件流（学术决定的只增日志） |
| POST | `/facts/:id/versions` | 提出带依据的候选更正 |
| POST | `/citations` | 登记文献引文 |
| POST | `/facts/:id/versions/:vid/citations` | 把引文作为证据关联到候选 |
| POST | `/citations/:id/retract` | 标记来源撤回（引文有独立流与版本号） |
| GET | `/reports/citations` | 引文有效性报告 |
| POST | `/facts/:id/opinions` | 记录专家意见（支持/异议/中立） |
| POST | `/facts/:id/reviews/version` | 学科（scientific）或法定（legal）审核 |
| POST | `/facts/:id/reviews/translation` | 语言审核（绑定译文文本修订号） |
| POST | `/facts/:id/translations` | 记录绑定具体源版本的译文 |
| POST | `/facts/:id/translations/:tid/revise` | 修订译文文字（旧语言审核自动作废） |
| POST | `/facts/:id/editions` | 为某渠道创建版面草稿 |
| POST | `/facts/:id/editions/:eid/update` | 修改草稿（只能在草稿态） |
| POST | `/facts/:id/editions/:eid/schedule` | 到指定未来时间排期（过闸门） |
| POST | `/facts/:id/editions/:eid/publish` | 发布（未到时间 409；发布时再过一次闸门） |
| POST | `/facts/:id/editions/:eid/cancel` | 取消草稿/已排期版面 |
| POST | `/facts/:id/editions/:eid/clarifications` | 对已发布版面**追加**醒目标记 |
| GET | `/board` | 馆方看板（按物种/渠道/展区过滤） |
| GET | `/trace` | 文字溯源（参数 text / versionId / translationId / editionId） |
| POST | `/publisher/run-due` | 手动触发到点发布（服务内也有每秒定时扫描） |

错误码：`400 validation_error`、`404 not_found`、`409 conflict`、
`412 stale_revision`、`422 schedule_gate_failed / approval_gate_failed`。

## 架构

```
src/domain/events.ts      领域事件 schema（唯一事实来源）
src/domain/store.ts       只增事件存储：内存版 + JSONL 文件版（流级乐观锁）
src/domain/projection.ts  事件 → 读模型折叠（事实/版本/译文/版面/引文/意见/审核）
src/domain/service.ts     用例与不变量：候选、证据、审核轮次、排期闸门、快照、标记
src/domain/publisher.ts   到点发布器（发布前闸门重校，失败记录不强发）
src/domain/reference.ts   reference/domain.json 一致性校验
src/http/api.ts           HTTP 路由与错误映射
src/index.ts              生产组合根：JsonlEventStore + 服务 + 定时发布
```
