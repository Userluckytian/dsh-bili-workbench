# Changelog

## 0.3.2 — 2026-10-23

- 修复「已评论」标签在长标题旁被挤成两行的问题（`white-space: nowrap` + `flex: none`）
- 更新 README 界面截图

## 0.3.1 — 2026-10-23

- 修复远程安装后 `judge / plan / compose` 仍按本地目录结构 import `../../bili-op/llm.mjs`、导致 `ERR_MODULE_NOT_FOUND` 的问题
- 新增 `engine/llmpath.mjs`：自动识别“源码同层 bili-op”和“插件内置 bili-op”两种布局

## 0.3.0 — 2026-10-23

- 「我的」页支持自定义素材库位置：默认 `~/.dsh-bili-workbench/store`，切换时新目录为空会自动复制现有素材，已有数据则直接切换
- 素材库位置写入 `~/.dsh-bili-workbench/location.json`，重启后保持
- 致谢收窄为灵感来源：dsh-bili-scroll（c1overzz）与 bili-cli（kukemc）
- 修复素材库切换后计划 / 互动账本 / 配置路径仍指向旧目录的问题

## 0.2.0 — 2026-10-23

首个公开版本。

- 五个模块：素材库 / 刷B站 / 创作·出片 / 审核·发布 / 我的
- 素材库按 BV 幂等；逐字稿、关键帧、封面、AI 点评、金句
- 日常：多时段 + 每日上限 + 综合热门/关注关键词混合
- 采集后自动判定、抽句、抓热评/热门弹幕/热梗、刷新日报
- 方案项目化与版本（v1/v2…）；真实帧 + Edge-TTS + Remotion 渲染 1080p 成片
- 审核通过 / 打回；投稿 dry-run；真投稿默认关
- 互动：手动评论/回复/私信（默认 dry-run）；自动评论 + 自动回复（默认关，12 秒间隔，每日上限）
- 设置页与视频页关键词共享；长按标签进入删除态（虚线 + ×）
- 自带白色 / dsh 主题变量；Edge / Chrome 自动探测
- 开源整理：MIT LICENSE、NOTICE、CONTRIBUTORS、安装与发布说明

## 0.1.0 — 2026-10-22

内部原型：素材库 + 采集器 + 判定抽句 + 素材日报。
