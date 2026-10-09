# Jev Scope

在 Codex 完成一轮修改后，提醒可能夹带的额外改动。提示给出文件位置、实际代码变化和对应需求；正常情况保持安静。

```text
Jev Scope：1 个文件需关注。
- web/styles.css:21：修改配色：.button · color：#222 → #f00；疑似超出R1「只改字体」的独立改动
详情：说“查看范围检查报告”
```

范围筛查，不做自动验收，也不自动回滚。零运行时依赖，提供 CLI 和可选本地工作台。

## 安装一次，多个项目共用

需要 **Node.js 22+、Git，以及支持 Hooks 的本地 Codex**。克隆并安装：

```sh
git clone https://github.com/DarenZc/JevScope.git
cd JevScope
node bin/scope.js install
```

安装器将三个 Hook 合并到 `~/.codex/hooks.json`，保留其他配置并备份原文件。设置了 `CODEX_HOME` 时使用该目录，也可指定 `--codex-home "配置目录"`。重复安装不会重复添加；更新或移动本工具、Node 后重新运行此命令。

1. 在安装命令显示的 `jev-scope/.env` 路径创建文件，填入自己的 OpenRouter Key。该目录有 `.env.example` 可复制。
2. 在实际使用的 Codex 中打开 `/hooks`，审阅并信任 Jev Scope 的 `UserPromptSubmit`、`PreToolUse`、`Stop`。
3. 打开或恢复任意本地 Git 项目会话，正常描述开发需求。

```dotenv
OPENROUTER_API_KEY=你的密钥
JEV_MODEL=jev-1.13
```

无需在其他项目复制代码、配置或 `AGENTS.md`。不必启动网页，也不必要求用户每次运行检查命令。全局 Hook 会向 Codex 提供需求记录和收尾检查指引；能否显示在最终回复中，仍取决于 Codex 遵循该指引。

```sh
node bin/scope.js doctor
```

`doctor` 检查 Node、Git、安装路径、Hook 配置和密钥是否存在，不调用 API，也不读取或修改 Codex 的信任设置。安装成功不等于 Hook 已被信任或启用。[Codex 官方 Hooks 说明](https://learn.chatgpt.com/docs/hooks)

密钥优先级：进程环境变量 → `CODEX_HOME/jev-scope/.env` → 本工具目录 `.env`。不会加载被检查项目的 `.env`，不会在安装时复制密钥。每位使用者配置自己的 Key，语义检查使用自己的 OpenRouter 余额。

## 在 Codex 中使用

直接提出需求，例如“只把正文改成微软雅黑”。Codex 在修改前记录需求原话和文件基线，在最终回复前运行 `check --for-chat`。有明确问题时，把简短提醒附在正常回复之后。

| 对话 | 行为 |
| --- | --- |
| 同一任务的补充 | 追加原话；撤销旧要求时明确记录撤销编号 |
| 查看范围检查报告 | 展开上次结果，不重新调用 API |
| 现在检查一下 | 检查当前改动 |
| 暂停自动检查 / 恢复自动检查 | 切换手动 / 结束时检查 |
| 新的开发任务 | 关闭旧记录，以当时文件建立新基线 |

问答和只读浏览不会自动建立任务。相同提醒会去重；证据不足的结果留在报告中，不等于已经通过。Stop Hook 是原生兜底，部分 Codex 界面会将其文字收在 Hook stats 中。

## 兼容范围

- 支持本地 Codex Git 工作区；按工作区隔离需求、基线和报告。**同一工作区只有一个活动任务**，并行开发使用独立 Git worktree。
- 非 Git 目录安静跳过，不自动 `git init`。缺少 Git 时可通过 `doctor` 排查；缺少 Node 时安装与 Hook 均无法执行。
- Windows 生成 PowerShell `commandWindows`；macOS、Linux 使用 POSIX 引用。配置包含安装时的绝对路径，所以不要复制生成的 `hooks.json` 给其他电脑。
- 不支持云端编排的 Codex / Work Cloud 本地命令 Hook。管理员也可能禁用 Hooks。[官方适用范围](https://learn.chatgpt.com/docs/hooks#managed-hooks-from-requirementstoml)
- 用户层、项目层、插件层的 Hook 会一起运行。若曾手工配置项目级 Jev Scope，请在 `/hooks` 中移除旧条目，保留一个来源。重复 Stop 检查会复用缓存并对提醒去重，但旧版入口可能失效。
- 不改写目标项目的 `AGENTS.md`、代码、真实 Git 暂存区或 Codex 权限。已有项目指令如有冲突，应在该项目明确调整。

## 卸载与升级

```sh
node bin/scope.js uninstall
```

只移除安装器登记且定义未被手动修改的全局 Hook，保留其他 Hook、密钥、备份和项目报告。手动改过的定义会保留并提示核对；旧的项目级 Hook 需在其来源文件移除。卸载后再删除工具目录，避免留下失效命令。

升级：更新工具代码，重新运行 `install`，在 `/hooks` 核对新的定义。安装器不自动授予信任。原配置备份在 `CODEX_HOME/jev-scope/backups/`；不要整份覆盖当前配置来卸载，以免覆盖其他工具后来新增的配置。

## 手动 CLI

在工具目录运行，`--cwd` 指定目标 Git 项目：

```sh
node bin/scope.js start "增加 CSV 导出" --constraint "不要增加历史记录" --cwd "项目目录"
node bin/scope.js amend "允许保存最近十次导出" --drop C1 --cwd "项目目录"
node bin/scope.js status --history --cwd "项目目录"
node bin/scope.js check --cwd "项目目录"
node bin/scope.js report --cwd "项目目录"
node bin/scope.js finish --cwd "项目目录"
```

`start` 不覆盖活动任务；`amend` 保留基线和历史。记录只应包含用户需求和约束，不能把 Agent 的计划当作授权。`finish` 不修改代码；正常收尾不要提前 `finish`，否则 Stop 无法检查当前任务。

| 选项 | 用途 |
| --- | --- |
| `--review end\|live\|manual` | 结束时检查（默认）/ 额外修改前语义检查 / 手动检查 |
| `--mode review` | 只读审查 |
| `--allow src/auth/` | 显式可编辑目录或精确文件，可重复；不支持 glob |
| `--no-deps` / `amend --allow-deps` | 禁止 / 恢复新增 npm 依赖 |
| `--offline` | 仅检查本地规则，不调用 Jev；语义结果标为未完成 |
| `--refresh` | 跳过检查缓存重试 |
| `--json` | 结构化结果 |
| `check --for-chat` | 仅输出尚未展示的简短提醒；正常、重复、手动模式无输出 |

普通 `check` / `report` 退出码：`0` 无问题，`1` 有违规或需核对项，`2` 未完成或命令出错。`report` 读取上次结果，不重新扫描；需求版本不同会标为过期。`check --for-chat` 成功投递提醒仍退出 `0`。

`hook-config` 只输出配置，供需要按项目手工配置的用户使用；推荐使用全局 `install`。可选运行 `npm install -g .` 得到 `jev-scope` 命令，再显式执行 `jev-scope install`。安装 npm 包本身不会修改 Codex 配置。

## 可选工作台

```sh
npm start -- --cwd "项目目录"
```

打开输出的本地地址（默认 `http://127.0.0.1:4173`）。支持查看需求、改动、证据和报告，`Ctrl+B` / `Ctrl+J` 收起侧栏 / 底栏。端口可用 `--port 4174` 修改。

页面读取和刷新不调用 API；点击完整检查会发送需求与相关差异并产生费用。服务只监听本机，修改操作验证同源和会话令牌，不向浏览器提供 `.env`。

## 数据与判断边界

任务和报告保存在当前 worktree 的 Git 管理目录 `jev-scope/`。临时 Git index 保存任务开始时的快照；之后的暂存、未暂存、新增和删除内容参与比较，已有工作不归因于新任务。快照写入本地 Git 对象库，但不创建提交。

语义检查向 OpenRouter 的 `/api/v1/systemone` 发送需求、约束、相关 diff 和源码证据候选。默认模型 `jev-1.13`。不扫描其他项目；敏感文件如 `.env`、私钥和凭据文件跳过，常见内联密钥会脱敏。规则无法保证识别所有敏感内容；仅在允许这些代码发送至该服务的项目使用。

Jev 选择分类、证据编号和需求依据，提示中的源码和行号取自实际差异。阈值是筛查启发式，不是生产准确率；复杂调用关系或模糊需求仍可能误报、漏报。不能证明代码正确、功能生效或任务完成。

大补丁分片，每轮最多 512 KB / 96 片段，语义预算 28 秒。失败、超预算、敏感内容或二进制被跳过时报告明确标为未完成。成功结果按需求版本和 Git 内容缓存；失败自动检查有 30 秒冷却，不自动重试。

修改前规则只覆盖 `apply_patch`；Shell、MCP 等其他写入通过结束时 Git 差异检查。语义提醒不阻断、不自动改回代码；显式只读或路径边界可在修改前拒绝补丁。

## 测试与发布

```sh
npm test
npm run verify:package
npm run demo
```

测试使用临时 Git 仓库、隔离 Codex 配置和模拟 HTTP，不访问生产项目或付费 API。覆盖安装合并、卸载、重复安装、跨项目引导、路径引用、环境隔离及原有检查行为。GitHub Actions 配置了 Windows / macOS / Linux 和 Node 22 / 24；本机通过不代表这些远程任务已经运行。

已有支持 Hooks 的 Codex 可额外运行 `npm run verify:codex`，在隔离配置下验证真实宿主从两个项目发现并执行全局 Hook，不使用真实模型或付费 API。可用 `JEV_CODEX_BINARY` 指定实际 Codex 可执行文件。

GitHub 应提交源码、测试、文档和工作流。`.gitignore` 排除密钥、本机 `.codex`、预览输出和本地评测结果；`npm pack` 通过白名单只打包运行所需文件。安装命令里的路径在使用者机器上生成。下载源码后按上述命令安装即可，不依赖预先发布到 npm。

许可证：MIT。
