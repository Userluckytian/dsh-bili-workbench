# 第三方代码与署名说明

本项目（`dsh-bili-workbench`）以 **MIT** 协议发布，正文见 [LICENSE](LICENSE)。

## 一、直接依赖 / 运行时

| 项目 | 许可证 | 在本项目中的角色 |
|---|---|---|
| [DeepSeek Harness（dsh）](https://github.com/deepseek-ai/deepseek-harness) | 见上游仓库 | 插件宿主、Web 服务、客户端运行时 |
| [bili-cli / bili-agent](https://github.com/kukemc/bili-cli) | MIT | 通过本机 `bili` 命令读写 B站（不随本项目分发） |
| [bilibili-api-python](https://github.com/Nemo2011/bilibili-api) | GPL-3.0-or-later | 由 bili-cli 依赖，本项目不直接导入、不分发 |
| [Remotion](https://www.remotion.dev/) | 见 [Remotion License](https://www.remotion.dev/license) | React 视频渲染。Remotion 不是 OSI 许可证；个人/小团队免费，商业使用请自行确认条款 |
| [edge-tts](https://github.com/rany2/edge-tts) | LGPL-3.0 | 通过本机 `edge-tts` 命令生成配音（不随本项目分发） |
| [FFmpeg](https://ffmpeg.org/) | LGPL-2.1+ / GPL（取决于构建） | 混音、烧字幕（通过本机 `ffmpeg` 命令调用） |
| [sharp](https://github.com/lovell/sharp) | Apache-2.0 | 封面 SVG → PNG |
| [React](https://react.dev/) | MIT | Remotion 组件运行时 |

## 二、设计与前身项目

- **[dsh-bili-scroll](https://github.com/c1overzz/dsh-bili-scroll)**（MIT，Copyright (c) 2026 c1overzz）
  - 本项目的前身「刷B站」插件。
  - 日常 / 偏好 / 互动的字段命名、时段解析、模型链轮换、日报与互动思路参考了它；部分行为约定沿用。
  - 原项目的 `NOTICE.md` / `CONTRIBUTORS.md` 见 upstream 仓库。

- **[bilibili-mcp](https://github.com/adoresever/bilibili-mcp)**（MIT，Copyright (c) 2026 AGI_Ananas）
  - 前身插件曾以 `vendor/bilibili-mcp/` 形式内置；本项目**没有**直接复制或分发它，仅在功能设计上参考。

- **workbench-mockup**
  - 本项目界面原型的静态 HTML / 截图，作为设计参考；没有引入第三方 UI 框架。

## 三、前身项目的社区贡献

以下贡献属于 `dsh-bili-scroll` 时期，列在这里是对 upstream 历史的完整保留，不代表他们直接参与了本项目：

- [@wotorrrrr](https://github.com/wotorrrrr)：`uv venv` 钉 Python 3.10–3.13；私信 MCP 白名单；数组设置比较
- [@Rookiexg](https://github.com/Rookiexg)：headless overlay 补 `agent-default-model`（PR #50）
- [@383891598](https://github.com/383891598)：yt-dlp 进度条污染 stdout（PR #23，部分采纳）

## 四、许可证边界

- 本仓库只包含本项目源码与出片引擎源码；**不包含** `bili-store` 用户数据、`bili-op/runs` 成片、`node_modules`、B站 登录凭证或模型密钥。
- `bili-cli`、`bilibili-api-python`、`edge-tts`、FFmpeg 由使用者自行安装；它们各自的许可证独立生效。
- Remotion 通过 npm 依赖安装，使用前请阅读其授权条款；本项目不代替使用者取得 Remotion 商业授权。

---

*本文件只做署名与许可证说明，不构成额外限制。*
