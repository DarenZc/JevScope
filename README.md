# Jev Scope

在 Codex、Claude Code、WorkBuddy 或 CodeBuddy Code 完成一轮修改后，提醒可能夹带的额外改动。提示给出文件位置、实际代码变化和对应需求；正常情况保持安静。

```text
Jev Scope：1 个文件需关注。
- web/styles.css:21：修改配色：.button · color：#222 → #f00；疑似超出R1「只改字体」的独立改动
详情：说“查看范围检查报告”
```

范围筛查，不做自动验收，也不自动回滚。零运行时依赖，提供 CLI 和可选本地工作台。

## 安装一次，多个项目共用

需要 **Node.js 22+、Git，以及支持命令 Hooks 的本地客户端**。克隆后，选择需要接入的客户端：

```sh
git clone https://github.com/DarenZc/JevScope.git
cd JevScope
node bin/scope.js install --host codex
# 也可选 claude-code / workbuddy / codebuddy
```

| 客户端 | 安装命令 | 默认配置文件 | 配置目录环境变量 |
| --- | --- | --- | --- |
| Codex | `node bin/scope.js install --host codex` | `~/.codex/hooks.json` | `CODEX_HOME` |
| Claude Code | `node bin/scope.js install --host claude-code` | `~/.claude/settings.json` | `CLAUDE_CONFIG_DIR` |
| WorkBuddy 桌面版 | `node bin/scope.js install --host workbuddy` | `~/.workbuddy/settings.json` | `WORKBUDDY_CONFIG_DIR` |
| CodeBuddy Code CLI | `node bin/scope.js install --host codebuddy` | `~/.codebuddy/settings.json` | `CODEBUDDY_CONFIG_DIR` |

可以分别为多个客户端安装。省略 `--host` 时保持原有 Codex 行为；`claude` 是 `claude-code` 的别名。每个客户端使用独立的安装记录、密钥目录和备份。环境变量覆盖默认目录，也可用 `--host-home "配置目录"` 指定；旧的 `--codex-home` 仍有效。

安装器将 `UserPromptSubmit`、`PreToolUse`、`Stop` 合并到配置中，保留模型、权限和其他 Hook，并备份原文件。重复安装不会重复添加；更新或移动本工具、Node 后重新安装。

1. 在安装命令显示的 `jev-scope/.env` 路径创建文件，填入自己的 OpenRouter Key。该目录有 `.env.example` 可复制。
2. 按安装命令显示的客户端说明核对并启用 Hooks。Codex、Claude Code、CodeBuddy Code 可用 `/hooks`；WorkBuddy 需重启并在其 Hooks 管理入口核对，入口随版本可能不同。
3. 重新打开本地 Git 项目会话，正常描述开发需求。

```dotenv
OPENROUTER_API_KEY=你的密钥
JEV_MODEL=jev-1.13
```

无需在其他项目复制代码、配置或 `AGENTS.md` / `CLAUDE.md`。不必启动网页，也不必要求用户每次运行检查命令。全局 Hook 会向 Agent 提供需求记录和收尾检查指引；能否显示在最终回复中，仍取决于 Agent 遵循该指引。

```sh
node bin/scope.js doctor --host claude-code
```

`doctor` 检查所选客户端的 Node、Git、安装路径、Hook 配置、显式禁用开关和密钥是否存在，不调用 API，也不修改客户端的信任设置。安装成功不等于 Hook 已被信任、启用或已显示在界面中。

密钥优先级：进程环境变量 → **所选客户端配置目录**的 `jev-scope/.env` → 本工具目录 `.env`。不会跨客户端读取密钥，不会加载被检查项目的 `.env`，不会在安装时复制密钥。每位使用者配置自己的 Key，语义检查使用自己的 OpenRouter 余额。

## 在对话中使用

直接提出需求，例如“只把正文改成微软雅黑”。Agent 在修改前记录需求原话和文件基线，在最终回复前运行带有对应 `--host` 的 `check --for-chat`。有明确问题时，把简短提醒附在正常回复之后。

| 对话 | 行为 |
| --- | --- |
| 同一任务的补充 | 追加原话；撤销旧要求时明确记录撤销编号 |
| 查看范围检查报告 | 展开上次结果，不重新调用 API |
| 现在检查一下 | 检查当前改动 |
| 暂停自动检查 / 恢复自动检查 | 切换手动 / 结束时检查 |
| 新的开发任务 | 关闭旧记录，以当时文件建立新基线 |

问答和只读浏览不会自动建立任务。相同提醒在同一客户端内去重；切换客户端不会吞掉首次提醒。证据不足的结果留在报告中，不等于已经通过。Stop Hook 是原生兜底：不同客户端可能把 `systemMessage` 收进 Hook 日志，不能保证每种界面都直接显示。最终答复附加提醒仍走 `check --for-chat`，不通过阻止 Stop 让 Agent 再执行一轮。

## 兼容范围

- 四种接入均限本地 Git 工作区；按工作区隔离需求、基线和报告。切换客户端可以继续同一任务。**同一工作区只有一个活动任务**，同时使用多个客户端开发时使用独立 Git worktree。
- 非 Git 目录安静跳过，不自动 `git init`。缺少 Git 时可通过 `doctor` 排查；缺少 Node 时安装与 Hook 均无法执行。
- Windows 的 Codex 使用 `commandWindows`；其他客户端使用可从 Bash / PowerShell 启动的 PowerShell 命令，路径以编码参数安全传递。macOS、Linux 使用 POSIX 引用。Claude Code / CodeBuddy 的 Windows 版本可能还要求安装 Git Bash。配置包含安装时的绝对路径，不要直接复制给其他电脑。
- 不支持云端编排的 Codex / Work Cloud 本地命令 Hook。管理员也可能禁用 Hooks。[官方适用范围](https://learn.chatgpt.com/docs/hooks#managed-hooks-from-requirementstoml)
- 若曾手工配置项目级 Jev Scope，请在客户端核对来源，移除失效的旧条目。重复 Stop 检查会复用缓存并对提醒去重。宿主版本、企业策略、项目设置都可能影响 Hook 加载；`doctor` 不能代替客户端中的实际确认。
- 不改写目标项目的指令文件、代码、真实 Git 暂存区或客户端权限。已有项目指令如有冲突，应在该项目明确调整。

接入依据：[Codex Hooks](https://learn.chatgpt.com/docs/hooks)、[Claude Code Hooks](https://code.claude.com/docs/en/hooks)、[CodeBuddy Code Hooks](https://www.codebuddy.cn/docs/cli/hooks)。WorkBuddy 的配置目录和内置 CodeBuddy 引擎调用方式已核对本机 5.5.2 安装包。旧版本和 CodeBuddy IDE 扩展不在这次验证范围内。

本次已在 Windows 上用真实 Codex、Claude Code 2.1.183、WorkBuddy 5.5.2 内置引擎完成隔离集成测试；模型响应由本地服务模拟。CodeBuddy Code 适配通过配置、命令和事件测试，尚未验证独立发行的 CLI。桌面界面展示位置仍以各客户端为准。

## 卸载与升级

```sh
node bin/scope.js uninstall --host workbuddy
```

只移除安装器登记且定义未被手动修改的全局 Hook，保留其他 Hook、密钥、备份和项目报告。手动改过的定义会保留并提示核对；旧的项目级 Hook 需在其来源文件移除。卸载后再删除工具目录，避免留下失效命令。

升级：更新工具代码，为已接入的客户端重新运行 `install --host ...`，核对新的定义。安装器不自动授予信任。原配置备份在所选客户端的 `jev-scope/backups/`；不要整份覆盖当前配置来卸载，以免覆盖其他工具后来新增的配置。卸载一个客户端不影响其他客户端。

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
| `--host codex\|claude-code\|workbuddy\|codebuddy` | 选择配置与提醒投递身份；所有 CLI 命令可用 |
| `--host-home "目录"` | 指定该客户端的配置目录 |

普通 `check` / `report` 退出码：`0` 无问题，`1` 有违规或需核对项，`2` 未完成或命令出错。`report` 读取上次结果，不重新扫描；需求版本不同会标为过期。`check --for-chat` 成功投递提醒仍退出 `0`。

`hosts` 列出接入方式；`hook-config --host ...` 只输出配置，供需要手工合并配置的用户使用。推荐使用全局 `install`。可选运行 `npm install -g .` 得到 `jev-scope` 命令，再显式执行 `jev-scope install --host ...`。安装 npm 包本身不会修改客户端配置。

## 可选工作台

```sh
npm start -- --cwd "项目目录"
```

打开输出的本地地址（默认 `http://127.0.0.1:4173`）。支持查看需求、改动、证据和报告，`Ctrl+B` / `Ctrl+J` 收起侧栏 / 底栏。端口可用 `--port 4174` 修改；`--host workbuddy` 等选项让工作台使用对应客户端的密钥配置。

页面读取和刷新不调用 API；点击完整检查会发送需求与相关差异并产生费用。服务只监听本机，修改操作验证同源和会话令牌，不向浏览器提供 `.env`。

## 数据与判断边界

任务和报告保存在当前 worktree 的 Git 管理目录 `jev-scope/`。临时 Git index 保存任务开始时的快照；之后的暂存、未暂存、新增和删除内容参与比较，已有工作不归因于新任务。快照写入本地 Git 对象库，但不创建提交。

语义检查向 OpenRouter 的 `/api/v1/systemone` 发送需求、约束、相关 diff 和源码证据候选。默认模型 `jev-1.13`。不扫描其他项目；敏感文件如 `.env`、私钥和凭据文件跳过，常见内联密钥会脱敏。规则无法保证识别所有敏感内容；仅在允许这些代码发送至该服务的项目使用。

Jev 选择分类、证据编号和需求依据，提示中的源码和行号取自实际差异。阈值是筛查启发式，不是生产准确率；复杂调用关系或模糊需求仍可能误报、漏报。不能证明代码正确、功能生效或任务完成。

大补丁分片，每轮最多 512 KB / 96 片段，语义预算 28 秒。失败、超预算、敏感内容或二进制被跳过时报告明确标为未完成。成功结果按需求版本和 Git 内容缓存；失败自动检查有 30 秒冷却，不自动重试。

修改前规则覆盖 Codex 的 `apply_patch`，以及其他三种客户端的 `Write` / `Edit` / `MultiEdit` / `NotebookEdit`。只读和文件边界在本地检查，路径会解析软链接。`live` 模式还可对文本编辑生成实际差异做语义筛查；无法准确重建的编辑、NotebookEdit、Shell 和 MCP 写入由结束时 Git 差异检查覆盖。语义提醒不阻断、不自动改回代码；显式只读或路径边界可在修改前拒绝操作。

## 扩展其他工具

检查引擎与宿主分离：`src/hosts.js` 定义配置目录、工具名和启用提示；`src/config.js` 负责命令引用；`src/tool-changes.js` 将编辑输入转换成统一差异；`src/hooks.js` 处理生命周期。新增宿主需确认其官方事件、输入输出格式和显示行为，再增加适配及隔离测试。

其他能运行本地命令的 Agent 可直接调用 CLI：修改前 `start` / `amend`，结束前 `check --for-chat` 并附加非空输出。**只有 CLI / MCP 调用能力不能保证自动收尾**；没有结束事件或可靠指令机制的客户端暂不标为自动接入。不需要为扩展宿主复制检查引擎。

## 测试与发布

```sh
npm test
npm run verify:package
npm run demo
```

测试使用临时 Git 仓库、各客户端的隔离配置和模拟 HTTP，不访问生产项目或付费 API。覆盖安装合并、卸载、重复安装、跨项目引导、路径引用、环境隔离、原生文件编辑输入和跨客户端提醒去重。GitHub Actions 配置了 Windows / macOS / Linux 和 Node 22 / 24；本机通过不代表这些远程任务已经运行。

已有支持 Hooks 的 Codex 可额外运行 `npm run verify:codex`，在隔离配置下验证真实宿主从两个项目发现并执行全局 Hook，不使用真实模型或付费 API。可用 `JEV_CODEX_BINARY` 指定实际 Codex 可执行文件。

已安装其他客户端时，可运行 `npm run verify:claude` 或 `npm run verify:workbuddy`。测试通过本地模拟模型驱动真实 CLI，验证需求指引、`Write` 越界拒绝、Stop 报告、最终文本追加提醒及不自动续轮；不代表真实模型一定遵循指引，也不验证桌面 UI 的展示位置。支持 `JEV_CLAUDE_BINARY` / `JEV_WORKBUDDY_CLI` 指定安装路径；后者指向 WorkBuddy 内置 `codebuddy.js`。独立 CodeBuddy Code 可设置 `JEV_CODEBUDDY_CLI` 后运行 `node evaluation/verify-host-hooks.js --host codebuddy`。

GitHub 应提交源码、测试、文档和工作流。`.gitignore` 排除密钥、本机 `.codex`、预览输出和本地评测结果；`npm pack` 通过白名单只打包运行所需文件。安装命令里的路径在使用者机器上生成。下载源码后按上述命令安装即可，不依赖预先发布到 npm。

许可证：MIT。
