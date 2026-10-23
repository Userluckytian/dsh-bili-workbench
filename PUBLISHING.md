# 发布清单（GitHub / npm）

这个目录 `dsh-bili-workbench-github/` 是干净的发布副本：**不含** `bili-store`、登录凭证、模型密钥、`node_modules`、成片 `runs/`。

## 0. 仓库所有者

已设为 `Userluckytian`，`package.json` 里的 `repository` / `homepage` / `bugs` 也已指向：

`https://github.com/Userluckytian/dsh-bili-workbench`

如果你 fork 到别的账号，全仓库替换 `Userluckytian` 即可。

## 1. 登录 GitHub

优先 `gh auth login`。如果本机 Windows 凭据管理器里已有 GitHub 凭据，也可以直接用 `git push`，不必再登录 `gh`。
```bash
gh auth login
```

## 2. 创建仓库并推送

在本目录执行：

```bash
git init
git add .
git commit -m "feat: initial public release of dsh-bili-workbench"
git branch -M main
gh repo create dsh-bili-workbench --public --source=. --remote=origin --push
```

## 3. 加 topic（关键）

`dsh-plugin` 是 dsh 插件生态的公开检索标签，必须在仓库 **About → Topics** 里加上：

```bash
gh repo edit --add-topic dsh-plugin \
  --add-topic dsh \
  --add-topic deepseek-harness \
  --add-topic bilibili \
  --add-topic remotion \
  --add-topic ai
```

也可以打开仓库首页 → 右侧 About 齿轮 → Topics 手动填。`dsh-plugin` 加上后，会出现在
<https://github.com/topics/dsh-plugin>。

## 4. 验证别人能装

在另一台机器（或换一个 `DSH_HOME`）执行：

```bash
dsh plugin --profile web add github:Userluckytian/dsh-bili-workbench
```

重启 dsh，刷新页面，应出现「B站工作台」页签。首次安装会拉 Remotion / sharp，体积较大，耐心等。

## 5. 可选：发布到 npm

包名 `dsh-bili-workbench` 目前**未被占用**。先登录：

```bash
npm login
npm publish --access public
```

发布后别人可以更简单地装：

```bash
dsh plugin --profile web add dsh-bili-workbench
```

## 6. 可选：打 tag / release

```bash
git tag v0.5.3
git push origin v0.5.3
gh release create v0.5.3 --generate-notes
```

GitHub 直接安装不依赖 release，但 release 页面方便别人看更新说明。

## 7. 发布前自检

```bash
node --check index.js
node --check client.js
node scripts/doctor.mjs
git status --short
```

确认 `git status` 里**没有**：

- `bili-store/`
- `config.json`（含模型密钥）
- `runs/`
- `node_modules/`
- 任何 `*.mp4` / `*.mp3` / 封面截图之外的私人素材

## 8. 之后同步源码

这个目录是快照，不是源码真身。改了 `../dsh-bili-workbench/` 或 `../bili-op/` 后，重新复制代码文件：

```bash
cd /path/to/source
cp dsh-bili-workbench/index.js dsh-bili-workbench/client.js dsh-bili-workbench/cordis.patch.yml dsh-bili-workbench-github/
cp dsh-bili-workbench/engine/*.mjs dsh-bili-workbench-github/engine/
cp bili-op/bili.mjs bili-op/build.mjs bili-op/cover.mjs bili-op/gen.mjs bili-op/llm.mjs \
   bili-op/prompts.mjs bili-op/tts.mjs bili-op/package.json bili-op/package-lock.json \
   dsh-bili-workbench-github/bili-op/
cp bili-op/render/package.json bili-op/render/package-lock.json dsh-bili-workbench-github/bili-op/render/
cp bili-op/render/src/*.tsx dsh-bili-workbench-github/bili-op/render/src/
```

不要从源码目录整体 `cp -r`，会把 `node_modules`、`runs`、测试数据带进去。
