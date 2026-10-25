# API 说明（第二阶段）

## 通用约定

所有业务路径以 /api 开头，使用 JSON 请求与响应。成功响应为 { code: 0, message: "ok", data: ... }；失败响应的 code 为字符串错误码。登录状态由签名的 HTTP-only Cookie 维护。除注册、登录、退出外，下列接口均要求登录；写问卷、查问卷统计、管理题库与查题库统计还要通过所有者校验。

问卷 ID、题库 ID、逻辑题 ID 和版本 ID 是不同的 MongoDB 标识。公开填写链接使用 publicId；问卷内 qid 只在本卷内定位题目。创建成功通常返回 HTTP 201，同一提交键的幂等重试返回 200。

## 账号与问卷

| 方法与路径 | 请求或行为 |
|---|---|
| POST /auth/register；POST /auth/login | { username, password }；注册成功直接建立会话 |
| POST /auth/logout；GET /auth/me | 退出；读取当前登录用户 |
| POST /surveys | { title, description?, allowAnonymous?, allowMultiple?, deadline? }；deadline 是带时区的 ISO 时间或 null |
| GET /surveys/mine；GET /surveys/:id | 我的问卷列表；读取本人一份问卷 |
| GET /surveys/:id/draft | 草稿直接返回；已发布问卷首次调用时由当前发布快照建立编辑草稿，重复调用不覆盖已有编辑 |
| PATCH /surveys/:id | 修改本人可编辑问卷的元数据 |
| POST /surveys/:id/questions | 添加题目；不能在此手工指定题库来源 |
| PUT /surveys/:id/questions | 以完整 questions 数组覆盖编辑草稿，供删除或重排后统一保存 |
| PATCH /surveys/:id/questions/:qid；DELETE /surveys/:id/questions/:qid | 修改或删除可编辑草稿中的一题 |
| POST /surveys/:id/publish | 校验题目与跳转图，通过后新增发布快照，返回 { versionId, version } |
| POST /surveys/:id/close | 主动关闭已发布问卷；旧快照、答卷和统计保留 |
| GET /surveys/:id/versions | 返回问卷各发布版本的 ID、版本号及发布时间 |

可编辑状态指草稿，或已发布问卷已通过 /draft 打开当前版本的编辑草稿。关闭问卷不能再编辑或接受新填写。

## 填写与单卷统计

| 方法与路径 | 请求或行为 |
|---|---|
| GET /public/surveys/:publicId | 登录填写者取得当前发布问卷、questions 和 versionId；已关闭问卷拒绝读取 |
| POST /public/surveys/:publicId/next | { versionId, currentQid, answers }；检查已到达路径并返回 { nextQid }，顺序结束为 null |
| POST /public/surveys/:publicId/submit | { versionId, clientSubmissionId, anonymous, answers }；重放路径并保存答卷，成功返回答卷 ID、版本 ID、路径和提交时间 |
| GET /surveys/:id/statistics?versionId=... | 创建者查询整卷；省略 versionId 时默认当前发布版本 |
| GET /surveys/:id/statistics/:qid?versionId=... | 创建者查询某一题在指定问卷版本中的结果 |

答案元素为 { qid, type, value }。单选 value 为选项 ID，多选为选项 ID 数组，文本为字符串，数字和评分为数值。单卷统计有 totalResponses；选择题的 counts 元素为 { optionId, text, count }，单选另有本题回答数；文本返回填写值，数字和评分返回回答数、平均值、最小值与最大值。统计不返回答卷内部身份键，当前没有创建者读取单份答卷详情的接口。

## 题库、分享与版本

| 方法与路径 | 请求或行为 |
|---|---|
| POST /question-banks；GET /question-banks | { name } 创建命名题库；列出自己的命名题库。默认题库无需创建 |
| PATCH /question-banks/:bankId；DELETE /question-banks/:bankId | 重命名；只能删除没有关联题目的空题库 |
| POST /question-banks/:bankId/questions | { surveyId, qid } 存入自己问卷的题，或 { question } 直接创建题库题 |
| POST /library-questions | 同上，但进入默认题库（bankId=null） |
| GET /question-banks/:bankId/questions；GET /library-questions | 列出本人指定题库或全部未归档题目，包含默认版本内容 |
| POST /library-questions/batch | { ids, action: "move", bankId } 批量移动；bankId=null 表示默认题库。{ ids, action: "archive" } 批量归档 |
| GET /library-questions/:questionId/versions | 查询本题各内容版本及来源版本 |
| POST /library-questions/:questionId/versions | { question, sourceVersionId? } 创建新版本并设为默认；不修改已有问卷 |
| PUT /library-questions/:questionId/versions/:versionId | { question } 明确覆盖指定版本；返回内容修订号和受影响问卷数 |
| POST /library-questions/:questionId/versions/:versionId/restore | 将选中版本设为默认，返回 { versionId, version }；不产生新版本 |
| POST /library-questions/:questionId/share-link；DELETE /library-questions/:questionId/share-link | 生成新令牌或撤销当前链接；新令牌使旧链接失效 |
| POST /library-questions/import | { token }；接收者导入独立副本到自己默认题库，多人可分别导入 |
| POST /surveys/:id/questions/from-library | { questionVersionId, qid }；从本人题库复制指定版本到问卷草稿，旧 jumpRules 不复制 |
| POST /surveys/:id/questions/from-library/batch | { questionVersionIds: [...] }；按数组顺序批量复制并自动生成本卷题号 |
| GET /library-questions/:questionId/usage | 返回本人问卷草稿和发布快照中的引用位置，包含可确认的母本 |
| GET /library-questions/:questionId/statistics?versionId=... | 汇总本人问卷中的该逻辑题；可按题目版本 ID 过滤，返回每版或每次内容修订的回答与纳入快照数 |

分享链接由前端使用令牌组成带 import 参数的网页地址；导入必须登录。导入者得到自己的逻辑题与 v1，不获取原所有者的修改权限，也不与原所有者合并统计。归档只是从可用列表隐藏题目，不删除已发布问卷或历史答卷。

## 题目与错误约定

题型为 single、multi、text、number、rating。选择题需要 options 数组（元素为 { id, text }）；多选可配置 validation.minSelect、maxSelect、exactSelect；文本可配置 minLength、maxLength；数字可配置 min、max、integer；评分题要求 1～10 内的整数上下界。

跳转规则为 { id, when, targetQid }。单选条件用 optionId；多选条件可用 containsOptionId、containsAnyOptionIds、containsAllOptionIds、exactOptionIds、excludesOptionIds；数字与评分可用 gt、gte、lt、lte、eq 加 value，或 between 加 min/max（含边界）。规则按数组顺序匹配首条；不支持直接跳到“结束问卷”。

常见错误码：VALIDATION_ERROR（参数或答案错误）、LOGIN_REQUIRED、NOT_OWNER、NOT_FOUND、CONFLICT、SURVEY_LOCKED、SURVEY_CLOSED、VERSION_EXPIRED、JUMP_PATH_MISMATCH、INVALID_SURVEY_LOGIC、DUPLICATE_SUBMISSION。具体 HTTP 状态由实现返回；调用方应同时检查状态码和响应 code。
