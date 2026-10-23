# 外部贡献与致谢

## 本项目

- **dsh-bili-workbench**：界面、宿主、引擎、出片流水线、自动互动。
- 如果你提交的代码 / 修法被采纳，欢迎通过 PR 把你加到这里。

## 前身项目（dsh-bili-scroll）

下面这些贡献属于 `dsh-bili-scroll` 时期，保留在此完整致谢：

| 人 | 采纳了什么 |
|---|---|
| [@wotorrrrr](https://github.com/wotorrrrr) | `uv venv` 钉 Python 3.10–3.13（3.14+ 没有 `av` / `ctranslate2` 的 wheel）；私信模式必须把 `bili_send_message` 放进 MCP 白名单；数组类设置不能用 `!==` 比默认值 |
| [@Rookiexg](https://github.com/Rookiexg) | headless overlay 要补 `agent-default-model`，否则账号登录的机器会 `MISSING_CREDENTIAL`（PR #50） |
| [@383891598](https://github.com/383891598) | yt-dlp 的进度条会污染 stdout，导致“输出非空 = 成功”恒真（PR #23，部分采纳） |

## 上游项目

- **DeepSeek Harness**（dsh）—— 插件宿主与客户端运行时
- **bili-cli**（[@kukemc](https://github.com/kukemc)）—— B站 账号操作 CLI
- **bilibili-api-python**（Nemo2011 / MoyuScript）—— bili-cli 的底层 API 封装
- **Remotion** —— React 视频渲染
- **edge-tts**（[@rany2](https://github.com/rany2)）—— 配音
- **FFmpeg** —— 混音 / 烧字幕
- **sharp**（[@lovell](https://github.com/lovell)）—— 封面合成
- **bilibili-mcp**（AGI_Ananas / adoresever）—— 前身插件的 MCP 实现，本项目未直接分发

完整许可证说明见 [NOTICE.md](NOTICE.md)。
