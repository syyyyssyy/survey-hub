# 基于 MongoDB 的问卷系统

Node.js、Express 和 MongoDB 实现的单页问卷应用。用户登录后可以创建、发布、填写和统计问卷。题目及跳转规则由问卷配置驱动；发布版本单独保存，答卷始终关联作答时的版本。

## 文档与测试用例

以下路径均相对于 `survey-system/` 项目目录，可直接点击打开。四份设计与接口文档位于 `docs/`，测试用例文档位于 `tests/`。

| 文件地址 | 内容 |
|---|---|
| [`docs/系统说明.md`](docs/系统说明.md) | 系统目标、功能模块、用户权限及创建、发布、填写、统计流程。 |
| [`docs/数据库设计.md`](docs/数据库设计.md) | MongoDB 四个集合的字段与关联、题目嵌套和版本引用、校验器及索引设计。 |
| [`docs/API说明.md`](docs/API说明.md) | 登录、问卷管理、公开填写和统计接口的请求、响应、跳转条件及错误码。 |
| [`docs/关键逻辑说明.md`](docs/关键逻辑说明.md) | 发布校验、答案校验、条件跳转、路径重放、幂等提交和聚合统计的执行逻辑。 |
| [`tests/测试用例.md`](tests/测试用例.md) | 自动化用例的测试步骤、输入、预期输出、实际结果及对应测试文件。 |

## 目录结构

```text
survey-system/
├─ public/                 浏览器页面、样式和交互脚本
├─ database/
│  └─ init-mongodb.js      集合校验器与索引初始化
├─ src/
│  ├─ app.js              Express API、鉴权及提交接口
│  ├─ rule-engine.js       答案校验、下一题判断、路径重放
│  ├─ schemas.js          Zod 请求与题目结构校验
│  ├─ survey-logic.js     发布前题目和跳转图校验
│  ├─ survey-status.js    截止日期自动关闭
│  └─ statistics.js       MongoDB 聚合统计
├─ tests/                 六个单元与 API 集成测试文件
│  └─ 测试用例.md          步骤、输入、输出与结果
├─ docs/                  系统、数据库、API 和关键逻辑说明
├─ server.js              服务入口和定期关闭任务
├─ package.json           启动和测试脚本、依赖
└─ package-lock.json      锁定依赖版本
```

`node_modules/` 不随项目复制；使用 `npm.cmd ci` 按锁文件安装。项目不需要原目录的报告、AI 日志或设计过程文档即可运行和测试。

## 环境和启动

需要 Node.js 24+、MongoDB Server 和 `mongosh`。以下命令在 PowerShell 中执行；MongoDB 安装路径请按实际机器调整。

```powershell
cd survey-system
npm.cmd ci
```

先保持 MongoDB Server 在 `127.0.0.1:27017` 运行。如果尚未启动，可在另一个终端运行下列示例，其中 `mongod.exe` 使用本机实际路径：

```powershell
New-Item -ItemType Directory -Force "$env:TEMP\survey-system-db" | Out-Null
& '<MongoDB安装目录>\bin\mongod.exe' --dbpath "$env:TEMP\survey-system-db" --bind_ip 127.0.0.1 --port 27017
```

回到项目终端初始化数据库并启动应用：

```powershell
mongosh 'mongodb://127.0.0.1:27017/survey_system' --file database/init-mongodb.js
$env:SESSION_SECRET = node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))"
npm.cmd start
```

打开 <http://127.0.0.1:3000>。`SESSION_SECRET` 至少 32 字符；正式使用时应固定保存，重启换密钥会使既有登录 Cookie 失效。`MONGODB_URI` 可更改数据库连接，`PORT` 可更改监听端口。初始化脚本可重复执行，会创建或更新四个集合的校验器和必要索引；应用启动时不会自动执行该脚本。首次启动前必须初始化数据库。

## 功能和业务流程

- **账号和问卷**：注册时记录 `createdAt`，密码只保存 bcrypt 哈希。创建者可管理自己的问卷，设置标题、说明、匿名填写、重复填写和截止时间。问卷可为 `draft`、`published`、`closed`；创建者可主动关闭，到期也会自动关闭。
- **题目**：支持单选、多选、文本、数字和 1～10 整数评分。多选支持最少、最多及精确选择数；文本和数字可设置相应边界。草稿题目可以增删、重排并整体保存。
- **发布与版本**：发布前校验题目、规则目标和跳转环。发布会新增 `survey_versions` 快照，更新问卷的 `publishedVersionId`，不覆盖旧快照。已发布问卷可从当前版本复制编辑草稿，再发布新版本；关闭的问卷不能编辑。
- **填写与跳转**：公开填写仍要求登录。新页面使用最新发布版本；已经打开的旧版页面可继续按其 `versionId` 提交。跳转规则按顺序匹配第一条；多选支持单项、任一项、全部项、恰好指定项和未选择指定项，数字及评分支持比较和含边界区间。没有匹配规则时进入顺序下一题；不提供直接跳到“结束问卷”的规则。
- **安全提交**：`/next` 用于填写导航，`/submit` 从版本第一题重新执行 `replayPath`。无效答案、循环和路径外答案被拒绝。`clientSubmissionId` 配合唯一索引实现幂等；不允许重复填写时，`dedupeKey` 防止同一人换提交 ID 再次提交。匿名只对创建者隐藏身份，服务端仍保留用于幂等和防重复的内部标识。
- **统计**：创建者可查整卷或单题，并按 `versionId` 查询历史版本；不传时使用当前发布版本。MongoDB 聚合计算选项计数、单选本题回答人数、文本内容、数字和评分的回答数、平均值、最小值、最大值。关闭后历史统计仍可查看。

## MongoDB 数据设计

| 集合 | 主要字段 | 作用 |
|---|---|---|
| `users` | `_id`, `username`, `passwordHash`, `createdAt`, `updatedAt` | 账号；`surveys.ownerId` 引用 `_id`。 |
| `surveys` | `_id`, `ownerId`, `publicId`, `title`, `description`, `allowAnonymous`, `allowMultiple`, `status`, `deadline`, `draftQuestions`, `draftBaseVersionId`, `publishedVersionId`, 时间字段 | 问卷元数据及可编辑的嵌套题目草稿。 |
| `survey_versions` | `_id`, `surveyId`, `version`, `questions`, `publishedAt`, `publishedBy` | 发布时冻结的题目和跳转规则；`surveys.publishedVersionId` 指向当前快照。 |
| `responses` | `_id`, `surveyId`, `versionId`, `respondentId`, `respondentKey`, `dedupeKey`, `anonymous`, `clientSubmissionId`, `answers`, `path`, `submittedAt` | 独立保存每份答卷，绑定具体发布版本；`path` 为服务端计算的实际路径。 |

题目嵌入 `draftQuestions` 和版本的 `questions` 数组，是因为编辑和填写经常需要整卷题序、选项及规则。答卷独立存储，避免问卷文档随提交无限增长和并发写入争用。版本快照保留历史题意，旧答卷按原版本读取和统计。MongoDB 文档模型能直接表达不同题型的 `validation` 参数及不同形态的 `jumpRules.when`；新增题型仍需同步前端、Zod、数据库校验器和统计分支。

### 校验与索引

请求入口使用 Zod，MongoDB 四个集合使用 `$jsonSchema` 阻止错误 BSON 类型及缺失字段写入。发布时另由后端检查跨题跳转目标、自跳转和环。

| 集合 | 索引 | 用途 |
|---|---|---|
| `users` | `username` 唯一 | 用户名不重复 |
| `surveys` | `publicId` 唯一；`ownerId, createdAt` | 公开链接查找；创建者问卷列表 |
| `survey_versions` | `surveyId, version` 唯一 | 同一问卷的版本号不重复 |
| `responses` | `surveyId, respondentKey, clientSubmissionId` 唯一 | 并发提交幂等 |
| `responses` | `surveyId, versionId, submittedAt, _id` | 按问卷及版本查询答卷 |
| `responses` | `dedupeKey` 唯一部分索引 | 禁止不允许重复填写的用户再次提交 |

没有 `status + deadline` 复合索引。到期关闭由启动时、运行期间定期扫描和相关接口访问时的核对实现。统计管道先按 `surveyId`、`versionId` 做 `$match`，再通过 `$facet`、`$unwind`、`$group` 计算总数和各题指标；统计入口只投影计算所需字段，不返回答卷内部身份键。当前没有单份答卷详情读取 API。

## 测试

保持 MongoDB 运行后，在本目录执行：

```powershell
npm.cmd test
```

测试使用真实 MongoDB、独立临时数据库，结束时删除；`TEST_MONGODB_URI` 可指定测试服务器。`tests/extensibility.test.js` 会调用 `mongosh` 执行 `database/init-mongodb.js`，因此测试环境也必须能从 `PATH` 找到 `mongosh`。`tests/` 中的六个文件覆盖规则引擎、发布图、鉴权、问卷操作、并发及幂等、版本隔离、聚合统计、评分题扩展和编辑器形状的规则保存。

2026-10-21 在本目录验证：**46 项通过、0 项失败**；执行本目录的初始化脚本后，首页及 `/app.js` 返回 HTTP 200，未登录访问 `/api/auth/me` 返回 401。验证时本机 MongoDB 原本未运行，已启动后重测。由于当前环境的 npm 离线缓存缺少锁文件要求的 Zod 包，`npm.cmd ci --offline` 未完成；本次测试和启动临时使用了原目录已安装的同一套依赖，验证后已将其移出交付文件夹。在可访问 npm 仓库的环境中需先执行 `npm.cmd ci`。浏览器端自动化点击测试尚未执行，API 通过不等于页面交互已自动验证。

## 已知限制

发布新快照与更新 `publishedVersionId` 是两次数据库写入；进程恰在中间崩溃可能留下未引用的快照。文本和数字原始值统计目前一次返回全部结果，尚无分页；大规模问卷还受 MongoDB 单文档大小及 `$facet` 结果大小限制。本项目测试覆盖并发请求，但没有进行高负载或多进程压力测试。
