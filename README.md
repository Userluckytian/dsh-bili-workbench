# dsh-bili-workbench

> 一个 **DSH（DeepSeek Harness）** 插件：把「刷 B站 / 素材库 / AI 出片 / 审核发布 / 自动互动」放进同一个工作台。

[![dsh-plugin](https://img.shields.io/badge/topic-dsh--plugin-blue)](https://github.com/topics/dsh-plugin)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)

刷到的视频会落进素材库，出片引擎从库里取真实帧和金句；同一条视频只抓一次。不是又一个「B站信息流面板」，而是一条从**看**到**做**再到**发**的完整流水线。

![界面预览](docs/workbench.png)

## 功能

| 模块 | 做什么 |
|---|---|
| 📚 素材库 | 视频元数据、逐字稿（带时间戳）、关键帧、封面、AI 点评、可引用金句、热评、热门弹幕、热梗；按 BV 幂等，7 天内不重复抓 |
| 🎬 刷B站 | 综合热门 / 关键词搜索 / 看懂视频；按多时段 + 每日上限自动采集；每条采完自动判定、抽句、抓热评/弹幕/热梗、刷新日报 |
| ✍️ 创作 / 出片 | 一句话出方案 → 改一版（v1/v2…）→ 真实帧 + Edge-TTS 配音 + Remotion 渲染 → 1080p 成片 + 封面；库里没料时自动转成「长任务」 |
| ✅ 审核 / 发布 | 待审列表、通过 / 打回、预览成片、投稿 dry-run；真投稿默认关，打开后仍需二次确认 |
| 👤 我的 | 扫码登录 / 登出、账号数据、素材库信息、运行日志、模型健康检查、发布权限 |
| 💬 自动互动 | 可选：每条采到的视频自动留一条评论并 @ 你、称呼你；有人回复就自动回；主人身份与只读指令；12 秒发送间隔 + 每日上限；**默认关** |

## 环境要求

- **DSH** `>= 0.2.1-rc.1`（`dsh --version`）
- **Node.js** `>= 22`
- **bili-cli**（命令名 `bili`，PyPI 包 `bili-agent`）—— 账号操作的“手”
- **ffmpeg**（需要 `libass`，烧字幕用）
- **edge-tts**（配音）
- **Chrome 或 Edge**（Remotion 渲染用，自动探测）
- 一个 **OpenAI 兼容的模型端点**（用于判定、写方案、写评论）

## 安装

### 方式 A：从 GitHub 直接装（推荐）

```bash
dsh plugin --profile web add github:Userluckytian/dsh-bili-workbench
```

> 仓库所有者是 `Userluckytian`；如果你 fork 了，把用户名换成自己的。pnpm 会同时安装插件依赖（Remotion / sharp）。

### 方式 B：克隆后 link（想改代码）

```bash
git clone https://github.com/Userluckytian/dsh-bili-workbench.git
cd dsh-bili-workbench
npm install
dsh plugin --profile web add link:$PWD
```

Windows PowerShell：

```powershell
git clone https://github.com/Userluckytian/dsh-bili-workbench.git
cd dsh-bili-workbench
npm install
dsh plugin --profile web add "link:$PWD"
```

### 方式 C：npm（暂未发布）

```bash
dsh plugin --profile web add dsh-bili-workbench
```

装完**重启 dsh**，刷新浏览器页面，会话顶部会出现「B站工作台」页签。

### 外部命令

```bash
# bili-cli（需要 Python 3.10+；会装一个 bili 命令）
uv tool install bili-agent
bili auth login

# 配音
uv tool install edge-tts

# ffmpeg（Windows）
winget install Gyan.FFmpeg

# 自检
node scripts/doctor.mjs
```

## 第一次使用

1. 打开 dsh → 会话顶部「B站工作台」。
2. **我的 → 扫码登录**（登录只在这一处；不要在别处再装老「刷B站」插件，会有两套账号）。
3. **刷B站 → 刷B站设置**：
   - 模型链：一行一个模型名，失败会自动换下一个。
   - 模型密钥：`llmKey`（也可以设环境变量 `OC_API_KEY`）。
   - 模型端点：环境变量 `BILI_OP_LLM_BASE`，默认 `http://127.0.0.1:40080/v1`。
4. 点「立即跑一轮」，确认能采集、判定、写日报。
5. 需要出片时，去「创作 / 出片」生成方案并渲染。

## 自动互动：默认关，打开前请读完

自动互动会**用你的账号公开发评论 / 回复**。为了安全，插件内置默认是：

```text
定时自动刷   关
自动评论     关
自动回复     关
私信监听     关
真投稿       关
```

打开「自动评论」后，当天每条采到的视频都会留一条评论并 @ 你；打开「自动回复」后，有新回复会自动回。发送间隔固定 12 秒（B站要求至少 10 秒），并有每日上限。命中风控 / 限流 / 操作间隔会立即停止本轮，失败条目不写账本，下一轮再补。

手动「评论 / 回复 / 私信」仍然默认 **dry-run**：只生成并打印将要提交的内容，不真正发送；勾「真的发」才会发。

> 公开内容一旦发出就可能被缓存或转发。请自行确认账号、内容和使用场景符合 B站 的社区规则。

## 主人身份与只读指令

在「刷B站 → 刷B站设置」里填两个字段：

| 字段 | 说明 |
|---|---|
| 主人 UID | 你的 B站 UID（例如 `498295893`）。只有这个 UID 会被当主人 |
| 称呼 | 自动评论 / 回复里怎么称呼你，默认「老弟」 |

设置后：

- **自动评论**会在正文里自然称呼你，并把这条评论 `@` 到你（`--at 主人UID`）。
- **自动回复**能区分主人和普通用户：主人留言即使已被界面标记已读也会处理；普通用户仍只回新消息。
- 主人可以问只读问题，答案从本地素材库和互动账本实时计算：
  - 「今天逛了多少视频？」
  - 「设定的时间是多久 / 时段是什么？」
  - 「今天评论、回复多少条？」
- 非主人询问统计、配置、权限、密钥、路径等，一律忽略，不回复。
- 主人要求改配置、投稿、删除、私信、发评论时，只回复“去工作台手动改”，不会在评论里执行。
- 自动回复会跳过账本里已回复的 `rpid` 和自己刚发出的回复文本，避免自问自答循环。

主人身份只影响**回复策略**，不会绕过 B站 的权限或风控；所有发送仍然是实名公开操作。

## 长任务：素材不够，自己去刷 B站

在「创作 / 出片」写一句需求（例如“找找素材，出一期新三国的名场面的热梗集锦”），不需要等它立刻出片：

1. 先查素材库，按需求拆出的关键词匹配「相关且可用」的视频（有字幕或金句）。
2. 够料（默认 3 条）就直接写分镜方案。
3. 不够就自己去「刷B站」：按关键词搜索 → 采集字幕 / 关键帧 / 热评 / 弹幕 → 判定抽句 → 再查库。
4. 还不够就每 3 小时再找一轮，最多找 5 天；期间任务卡一直显示进度。
5. 够料后自动生成方案，停在「方案已生成」，**不会自动渲染、不会自动投稿**。

创作页下方会为每个任务显示一张卡片，状态包括：

| 状态 | 含义 |
|---|---|
| 排队中 | 刚创建，等宿主开跑 |
| 检查素材库 | 正在按关键词查库 |
| 逛 B站 中 | 正在搜索、采集、判定 |
| 素材不足，继续找 | 这一轮没凑够，过几小时再来 |
| 写方案中 | 素材够了，正在写分镜 |
| 方案已生成 | 可以去下面看方案，再决定是否渲染 |
| 已暂停 / 已停止 | 手动暂停，或到期/出错停止 |

卡片上有「现在再找一轮」「暂停 / 继续」「删除」「查看方案」。任务记录在素材库的 `tasks.json`；宿主重启后，跑到一半的任务会自动恢复排队。

任务自己采到的新视频也会按「自动评论」设置留评论并 @ 主人，和日常采集共用同一条每日上限。

## 数据与配置

默认数据目录：

```text
~/.dsh-bili-workbench/store/
  videos/<BV>.json      视频事实 + 判定 + 金句
  subs/<BV>.json        逐字稿
  frames/<BV>/          关键帧
  covers/<BV>.jpg       封面
  plans/<项目>/          方案与版本
  renders/<runId>/      成片、封面、字幕、配音（升级插件不会丢）
  reports/YYYY-MM-DD.md 素材日报
  config.json           设置（含模型密钥，注意不要提交）
  interactions.json     已评论 / 已回复账本
  tasks.json            长任务（素材不够自己去刷B站）
```

默认位置是 `~/.dsh-bili-workbench/store`；从原项目迁移的机器上，如果存在 `D:\AI_projects\bibilili\bili-store` 且没有设置 `BILI_STORE`，会自动使用旧目录。也可以：

- 在「我的 → 素材库与运行 → 素材库位置」里直接改，保存后即时切换；新目录为空时会复制现有素材
- 用环境变量 `BILI_STORE` 指定

选择过的位置会写进 `~/.dsh-bili-workbench/location.json`，重启后保持不变。

常用环境变量：

| 变量 | 作用 |
|---|---|
| `BILI_STORE` | 素材库目录 |
| `BILI_OP_DIR` | 出片引擎目录（默认用插件内置的 `bili-op/`） |
| `BILI_OP_LLM_BASE` | OpenAI 兼容端点，默认 `http://127.0.0.1:40080/v1` |
| `OC_API_KEY` | 模型密钥（没设则读 `config.json` 的 `llmKey`） |
| `BILI_OP_CHROME` | 指定 Chrome / Edge 可执行文件 |
| `BILI_BIN` | 指定 `bili` 可执行文件 |

## 目录

```text
index.js                 dsh 宿主半端：路由 / 调度 / 子进程编排
client.js                浏览器半端：工作台界面
engine/                  采集、判定、日报、方案、渲染、互动、账本、长任务
engine/task.mjs          长任务：拆词 → 查库 → 逛B站 → 写方案
engine/taskstore.mjs     任务账本（tasks.json）
bili-op/                 出片引擎：脚本 → edge-tts → Remotion → ffmpeg → 封面
cordis.patch.yml         dsh bundle patch
scripts/doctor.mjs       环境自检
```

## 常见问题

**装完没有「B站工作台」页签？**
先确认 dsh `>= 0.2.1-rc.1`；装完必须重启 dsh，再刷新浏览器。看 dsh 的启动日志有没有插件加载错误。

**渲染报“找不到 Remotion CLI”？**
说明依赖没装到包根。重新执行 `npm install`（方式 B），或重装插件（方式 A）。脚本会按 Node 解析规则找 `@remotion/cli`，不再写死 `render/node_modules`。

**渲染时报找不到浏览器？**
装 Chrome 或 Edge；也可以用 `BILI_OP_CHROME` 指定路径。Linux/macOS 下请把 `bili-op/render/src/News.tsx` 和 `bili-op/cover.mjs` 里的字体改成系统有的字体。

**渲染完成后「预览成片」还是灰的？**
先确认成片文件存在：`<素材库>/renders/<runId>/final-subbed.mp4`。旧版本把成片放在插件的 `bili-op/runs`，升级重装会清掉；0.4.2 起已改到素材库目录，并会自动迁移旧成片。如果项目显示「已完成」但文件确实不存在，重启 dsh 后会自动改回草稿，重新渲染即可。

**ffmpeg 烧字幕失败？**
需要带 `libass` 的 ffmpeg：`ffmpeg -filters | grep subtitles`。

**模型一直 429？**
模型链会自动退避换下一个；也可以在设置里换一个可用的模型或端点。

**pnpm 提示忽略了构建脚本？**
在 dsh profile 目录执行 `pnpm approve-builds`，允许 `sharp` / Remotion 的平台包，然后重装。

## 安全边界

- 不自动投稿：`publishEnabled` 默认 `false`。
- 不自动私信：私信监听默认关。
- 自动评论 / 回复默认关；手动流程默认 dry-run。
- 账号凭证由 `bili` 管理，不写进本仓库；`bili-store/config.json` 可能含模型密钥，已被 `.gitignore` 排除。

## 致谢与许可

本项目以 **MIT** 发布。

灵感来源：

- [dsh-bili-scroll](https://github.com/c1overzz/dsh-bili-scroll)（c1overzz，MIT）—— 前身「刷B站」插件，字段、调度与互动设计参考
- [bili-cli](https://github.com/kukemc/bili-cli)（kukemc，MIT）—— B站 账号操作 CLI

其他运行时依赖（Remotion、edge-tts、FFmpeg 等）遵循各自许可证，详见 [NOTICE.md](NOTICE.md)。Remotion 不是 OSI 许可证，商业使用前请自行确认其授权条款。

> 本项目与哔哩哔哩官方无关联。使用本工具产生的账号行为、内容与后果由使用者自行承担。
