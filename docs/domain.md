# 领域说明

展签内容由科学事实、文献引文、专家意见和多语言译文组成，不同发布渠道（纸质展签、语音导览、线上图录、印刷图录）可能使用不同版面。核心约束：**科学结论先形成带证据的候选更正，通过相应学科与语言审核后才在指定日期发布；已出版版本永久可引用；紧急勘误只能追加标记，不能悄悄改写原文。**

## 模型与不变量

- **事实（Fact）**：隶属于物种的稳定槽位，例如 `scientific_name/current_name`、`distribution/range`。
- **内容版本（ContentVersion，不可变）**：候选提交审核时冻结，含正文、证据和正文+证据的 SHA-256 哈希，记录 `baseVersionId` 血缘链。审核意见绑定哈希：正文一改，旧批准自动失效。
- **候选更正（Correction）**：持有可编辑草稿（`revision` 乐观锁检测过期草稿）、目标渠道、目标语言、必需审核类型。状态机：
  `draft → reviewing → approved → scheduled → published`；
  `changes_requested`/`rejected`、以及来源撤回，均退回 `draft` 重走流程。
- **审核闸口**：默认必须同时通过 `scientific`（学科）与 `language`（语言），可选 `legal`。意见只对“当前冻结版本哈希且晚于最近退回时间”的最新决定有效。
- **译文（Translation）**：必须在候选首次提交后创建，并绑定**具体冻结版本**（不允许“最新版”这类浮动引用）。候选重新提交产生新版本后，既有译文自动标 `stale`，须对照新源版本修订、重审；排期前每种目标语言都必须有未过期、已通过、绑定当前版本的译文。
- **出版（Publication，不可变）**：出版时定格正文快照。新版出版只把旧版置为 `superseded` 并记录 `supersededByPublicationId`，旧版继续可引用、可追溯。
- **勘误（Erratum，仅追加）**：
  - `emergency_notice`：紧急人工告示；
  - `retraction_notice`：引文撤回时，自动给所有引用该来源的已出版段落（含已被取代的版本）追加醒目标记。
  - 两类标记都不改动 `renderedText`。
- **来源撤回**：已出版内容挂标记；在途候选（审核中/已通过/已排期）在证据上打 `evidenceFlags` 并退回草稿、禁止带撤回证据提交。系统**只标注受影响段落，不生成或自动认可任何替代结论**——更换证据与新结论由编辑另行发起。
- **决定事件（DecisionEvent，仅追加）**：登记、冻结、提交、审核、排期、出版、取代、撤回、勘误等全部学术动作按序号留痕，是文字溯源的依据。

## 查询

- `GET /boards/taxa/:id`：按物种看各渠道当前展示、待审核差异（正文/引文增删）、各类审核满足情况、译文状态、引文总体有效性、计划发布时间。
- `GET /boards/zones/:id`：按展区聚合上述全部物种。
- `GET /citations[?id=...]`：引用有效性，以及被哪些已出版段落、在途候选使用，撤回标记是否已挂。
- `GET /provenance?publicationId=|contentVersionId=|text=`：从任一文字或标识追溯版本血缘、相关候选/译文/引文与完整学术决定时间线（含已取代版本与旧文字）。

## 写接口

| 方法与路径 | 说明 |
| --- | --- |
| `POST /zones` `/taxa` `/citations` `/expert-opinions` `/facts` | 基础资料登记 |
| `POST /baselines` | 登记某渠道现行内容为不可变基线并出版 |
| `POST /corrections` | 创建候选更正（草稿，必须附证据） |
| `POST /corrections/:id/draft` | 改草稿，须带 `expectedRevision`（过期返回 409） |
| `POST /corrections/:id/submit` | 冻结版本并送审 |
| `POST /corrections/:id/reviews` | 学科/语言/法律审核意见 |
| `POST /corrections/:id/schedule` | 指定发布日期与渠道（校验译文闸口） |
| `POST /publications/due` | 出版所有到期候选 |
| `POST /corrections/:id/translations` | 新增绑定冻结版本的译文 |
| `POST /translations/:id/revise` `/review` | 译文修订（过期后重绑新版本）与语言审核 |
| `POST /citations/:id/retract` | 来源撤回：挂标记、退回在途候选 |
| `POST /publications/:id/errata` | 追加紧急勘误，原文不变 |

所有写接口体为 JSON，须带 `actor`（审核/译文接口使用 `reviewer`/`translator`）。错误返回 `{error, message, details?}`，状态码：400 请求格式、404 不存在、409 并发冲突/非法流转、422 领域规则（证据失效、闸口未满足等）。

`reference/domain.json` 保存公开的内容状态、审核类型和发布渠道枚举；运行时数据写入 `DATA_PATH`（默认 `.runtime/db.json`），原子替换落盘。
