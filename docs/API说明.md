# API 说明

所有路径前缀为 `/api`；除注册、登录、退出外，下面的业务接口需要登录。成功响应形如 `{ "code": 0, "message": "ok", "data": ... }`；失败响应的 `code` 是字符串错误码。会话使用签名的 HTTP-only Cookie。`id` 是问卷 MongoDB `_id`，`publicId` 用于填写链接。

## 账号与问卷

| 方法与路径 | 输入及行为 |
|---|---|
| `POST /auth/register`、`POST /auth/login` | `{username,password}`；注册成功自动登录。 |
| `POST /auth/logout`、`GET /auth/me` | 退出、读取当前登录用户。 |
| `POST /surveys` | `{title,description?,allowAnonymous?,allowMultiple?,deadline?}`；创建草稿。`deadline` 为带时区的 ISO 时间或 `null`。 |
| `GET /surveys/mine`、`GET /surveys/:id` | 读取自己的问卷列表或单份问卷。 |
| `PATCH /surveys/:id` | 修改有编辑权限的问卷元数据；已发布问卷需先打开编辑草稿。 |
| `GET /surveys/:id/draft` | 草稿问卷直接返回；已发布问卷从当前版本复制一次编辑草稿，重复调用不覆盖已编辑内容。 |
| `POST /surveys/:id/questions` | 添加一题 `{qid,type,title,required,options?,validation?,jumpRules?}`。 |
| `PUT /surveys/:id/questions` | 以题目数组整体覆盖编辑草稿，供题号重排使用。 |
| `PATCH /surveys/:id/questions/:qid`、`DELETE /surveys/:id/questions/:qid` | 修改或删除草稿题目。 |
| `POST /surveys/:id/publish` | 校验草稿并新增版本，返回 `{versionId,version}`。 |
| `POST /surveys/:id/close` | 创建者关闭已发布问卷；旧答卷与统计保留。 |

题型为 `single`、`multi`、`text`、`number`、`rating`。多选可用 `validation.minSelect/maxSelect/exactSelect`；文本用 `minLength/maxLength`；数字用 `min/max/integer`；评分题必须配置 1～10 内的整数上下界并设 `integer:true`。选项是 `{id,text}`。

## 填写与统计

| 方法与路径 | 输入及行为 |
|---|---|
| `GET /public/surveys/:publicId` | 返回当前发布版本的题目及 `versionId`；问卷关闭后拒绝公开读取。 |
| `POST /public/surveys/:publicId/next` | `{versionId,currentQid,answers}`；服务端检查已答前缀，返回 `{nextQid}`，末题之后为 `null`。 |
| `POST /public/surveys/:publicId/submit` | `{versionId,clientSubmissionId,anonymous,answers}`；按指定版本重放路径，成功保存答卷。新提交返回 201，同键重试返回 200。 |
| `GET /surveys/:id/versions` | 创建者获取版本号、版本 ID、发布时间列表。 |
| `GET /surveys/:id/statistics?versionId=...` | 创建者查看整卷统计；不传版本时使用当前发布版本。 |
| `GET /surveys/:id/statistics/:qid?versionId=...` | 创建者查看某题在指定版本的统计。 |

答案形如 `{qid:"1",type:"single",value:"A"}`；多选的 `value` 为选项 ID 数组，文本为字符串，数字和评分为数值。统计响应包含 `totalResponses`：单选返回选项 `counts` 和本题回答人数 `count`，多选返回各选项被选次数，文本返回 `values/count`，数字和评分返回 `values/count/avg/min/max`。统计只纳入该 `versionId` 下的答卷。

## 跳转条件

规则统一形如 `{id:"r1",when:{...},targetQid:"3"}`。单选用 `{optionId:"A"}`；多选可用 `{containsOptionId:"A"}`、`{containsAnyOptionIds:["A","B"]}`、`{containsAllOptionIds:["A","B"]}`、`{exactOptionIds:["A","B"]}`、`{excludesOptionIds:["A","B"]}`。最后一种表示指定选项均未选择；选答题未作答也可命中。数字与评分可用 `{op:"gt"|"gte"|"lt"|"lte"|"eq",value:18}` 或含边界区间 `{op:"between",min:18,max:60}`。规则按数组顺序匹配首条；没有匹配项时顺序进入下一题。没有直接跳到结束问卷的目标。

常见错误码：`VALIDATION_ERROR`、`JUMP_PATH_MISMATCH`、`INVALID_SURVEY_LOGIC`（400）；`LOGIN_REQUIRED`、`INVALID_CREDENTIALS`（401）；`NOT_OWNER`（403）；`NOT_FOUND`（404）；`ALREADY_EXISTS`、`CONFLICT`、`SURVEY_LOCKED`、`VERSION_EXPIRED`、`SURVEY_CLOSED`、`DUPLICATE_SUBMISSION`（409）。具体响应以实现和测试为准。
