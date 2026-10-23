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
| ✍️ 创作 / 出片 | 一句话出方案 → 改一版（v1/v2…）→ 真实帧 + Edge-TTS 配音 + Remotion 渲染 → 1080p 成片 + 封面 |
| ✅ 审核 / 发布 | 待审列表、通过 / 打回、预览成片、投稿 dry-run；真投稿默认关，打开后仍需二次确认 |
| 👤 我的 | 扫码登录 / 登出、账号数据、素材库信息、运行日志、模型健康检查、发布权限 |
| 💬 自动互动 | 可选：每条采到的视频自动留一条评论并 @ 你；有人回复就自动回；12 秒发送间隔 + 每日上限；**默认关** |

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
dsh plugin --profile web add github:YOUR_GITHUB_USER/dsh-bili-workbench
```

> 把 `YOUR_GITHUB_USER` 换成仓库所有者。pnpm 会同时安装插件依赖（Remotion / sharp）。

### 方式 B：克隆后 link（想改代码）

```bash
git clone https://github.com/YOUR_GITHUB_USER/dsh-bili-workbench.git
cd dsh-bili-workbench
npm install
dsh plugin --profile web add link:$PWD
```

Windows PowerShell：

```powershell
git clone https://github.com/YOUR_GITHUB_USER/dsh-bili-workbench.git
cd dsh-bili-workbench
npm install
dsh plugin --profile web add "link:$PWD"
```

### 方式 C：npm（如果已发布）

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

## 数据与配置

默认数据目录：

```text
~/.dsh-bili-workbench/store/
  videos/<BV>.json      视频事实 + 判定 + 金句
  subs/<BV>.json        逐字稿
  frames/<BV>/          关键帧
  covers/<BV>.jpg       封面
  plans/<项目>/          方案与版本
  reports/YYYY-MM-DD.md 素材日报
  config.json           设置（含模型密钥，注意不要提交）
  interactions.json     已评论 / 已回复账本
```

如果目录里存在原项目的 `D:\AI_projects\bibilili\bili-store`，会优先使用它；否则用 `~/.dsh-bili-workbench/store`。也可以用 `BILI_STORE` 显式指定。

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
engine/                  采集、判定、日报、方案、渲染、互动、账本
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

本项目以 **MIT** 发布。完整第三方署名见 [NOTICE.md](NOTICE.md)，上游贡献者见 [CONTRIBUTORS.md](CONTRIBUTORS.md)。

主要参考 / 依赖：

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) —— dsh 插件宿主与运行时
- [dsh-bili-scroll](https://github.com/c1overzz/dsh-bili-scroll) —— 前身「刷B站」插件，字段、调度与互动设计参考
- [bili-cli](https://github.com/kukemc/bili-cli)（MIT）—— B站 账号操作 CLI
- [bilibili-api-python](https://github.com/Nemo2011/bilibili-api)（GPL-3.0+，由 bili-cli 使用，未随本项目分发）
- [Remotion](https://www.remotion.dev/) —— React 视频渲染（使用前请确认其授权条款）
- [edge-tts](https://github.com/rany2/edge-tts)（LGPL-3.0）—— 配音
- [FFmpeg](https://ffmpeg.org/) —— 混音 / 烧字幕
- [sharp](https://github.com/lovell/sharp)（Apache-2.0）—— 封面合成
- [bilibili-mcp](https://github.com/adoresever/bilibili-mcp)（MIT，Copyright (c) 2026 AGI_Ananas）—— 前身插件曾内置，本项目未直接分发

> 本项目与哔哩哔哩官方无关联。使用本工具产生的账号行为、内容与后果由使用者自行承担。
