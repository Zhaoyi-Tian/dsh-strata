# dsh-strata

DeepSeek Harness（dsh）的上下文管理插件，提供全上下文、全文摘要和自主笔记三种模式。

每次运行选择一种上下文模式。默认 `notes`：模型边干活边给自己记笔记；上下文快满时切换到新窗口，再通过笔记和会话历史找回需要的信息。

## 运行模式

先按下文安装，再在本仓库目录通过 profile patch 选择启动模式：

```yaml
# full.yml
- id: dsh-strata
  config:
    mode: full
```

```sh
pnpm exec dsh --profile headless --patch ./full.yml "任务内容"
```

| `mode` | 行为 | 插件提供的工具 |
| --- | --- | --- |
| `notes`（默认） | 模型写笔记、查历史并换窗 | 10 个笔记、历史和窗口工具 |
| `full` | 保留全部历史，达到 `full.stopAtTokens` 时结束；`null` 时由 API 容量限制 | 无，使用宿主的任务工具 |
| `summary` | 当前全部历史做一次摘要，再用摘要替换历史 | 无，使用宿主的任务工具 |

每种模式新建运行与会话；恢复旧会话时沿用原模式。模式切换不会还原旧会话已经被摘要或清掉的上下文。`new_context` 只在 `notes` 模式内换窗，不改变运行模式。

`summary` 使用本插件的白盒压缩，例如：

```yaml
- id: dsh-strata
  config:
    mode: summary
    summary:
      compactAtTokens: 81920
      maxOutputTokens: null
```

在下一次正常模型请求前检查当前历史的 token 数，达到 `summary.compactAtTokens` 后，用当前模型做一次摘要。
`summary.maxOutputTokens: null` 默认继承宿主本次模型调用的输出预算；也可以单独设定，例如 `4096`。
触发阈值还受「模型窗口减摘要输出预算」约束；`compactAtTokens: null` 表示只使用这个模型上限。
思考强度继承同一次模型路由。宿主负责配置模型、思考强度和普通请求的输出预算，插件不再额外隐含一份摘要输出默认值。

摘要输入包含系统提示和当前全部交互：用户消息、模型输出与思考、工具调用和结果、上一次摘要。只在末尾追加摘要指令，保留原有前缀以利用缓存。成功后只留下系统提示和新摘要，下一条输入照常追加。不选段、不保留近期原文、不创建笔记，也不改变环境状态。

流程在 [src/compaction/index.ts](src/compaction/index.ts)，默认提示词在 [src/compaction/prompts.ts](src/compaction/prompts.ts)。提示词要求忠实保留关键观察、结果、进度和不确定性，合并旧摘要，不强制 coding 栏目；可通过 `prompts.summary` 覆盖。

工具配对不完整、摘要请求失败、内容为空或达到输出上限时，保留原上下文并结束本轮、报告错误，不自动重试。新输入此时尚未追加，调用方需在处理错误后重新提交。原始历史保留在会话日志；`compaction/summary` 记录摘要、原始输出（含思考）和 usage，`plugin:dsh-strata/summary-request`、`plugin:dsh-strata/summary-response` 额外记录完整摘要请求和返回流，失败请求也能检查。

## notes 模式的工作方式

- **窗口**：模型用 `get_context_remaining` 查距强制切窗还剩多少 token，用 `new_context` 主动换窗。达到 `notes.remindAtTokens` 时提醒一次，达到 `checkpointAtTokens` 时要求保存检查点并主动换窗；达到 `forceSwitchAtTokens` 时强制换窗。切换保留系统提示，清掉当前对话，环境状态不受影响。新窗口只提供笔记文件名提示，模型自行读取笔记和历史恢复任务。强制换窗会提示检查点可能过时，并给出上一窗口的条目范围。
- **笔记**：会话内的虚拟文件，跨窗口保留。提供 `notes_list_files_by_prefix`、`notes_read_file`、`notes_search_contents`、`notes_append_to_file`、`notes_write_file` 五个工具。
- **历史**：只读查询本会话的原始事件。提供 `history_list_items`、`history_search_contents`、`history_read_item` 三个工具；列表与搜索仍可按窗口编号过滤。
- **条目编号**：对已有的用户消息和工具结果，在下一次模型请求前附加 `[id: #N]`。模型把编号记进笔记，换窗后用 `history_read_item({ seq: N })` 精确读回原文。编号使用会话事件序号，标记不改写原始消息。

笔记和历史限定在当前会话，随本地会话日志保存，可在进程重启后恢复。预算使用服务商返回的实际 usage，只对之后新增、尚未发送的内容做估算。恢复效果依赖模型主动记笔记和查找；强制换窗不会替模型补写检查点。

## 安装

使用 Node.js 26+ 和 pnpm 11。本仓库依赖固定为 dsh `0.2.1-alpha.2`；下面通过 `pnpm exec dsh` 调用本地 CLI。
在本仓库目录从源码打包安装：

```sh
pnpm install --frozen-lockfile
pnpm pack
pnpm exec dsh plugin --profile headless add ./dsh-strata-0.1.3.tgz
```

装好后重启对应 profile。安装补丁关闭宿主的原生自动压缩、`/compact`、工具结果裁剪、spill 和图像 offload，由本插件按 `mode` 启用一套上下文处理。

这个安装补丁面向官方 headless/base profile。Strata 游戏使用其仓库内的 `dsh/profile.yml`，直接加载本插件；
游戏接入与运行说明在 Strata 的 `docs/dsh.md`。其他自定义 profile 也应只启用一套上下文处理。

插件提供笔记、历史查询和上下文窗口。模型、任务提示词、环境工具或 shell 由宿主 profile 配置，不要求使用 `sdk-minimal`。宿主需提供 `llm`、`tokenMeter`、`sessions`、`sessionProjections`、`tools` 和 `sessionQuery` 服务；历史读取与搜索继续使用 dsh 的查询服务。当前仅支持原生工具调用，不提供 Web 预设或 PTC 适配。

卸载：

```sh
pnpm exec dsh plugin --profile headless remove dsh-strata
```

卸载后移除本插件的工具和上下文处理，恢复宿主 profile 的默认行为。旧会话日志仍可重放，但不再注入条目编号。

## 配置

每种模式的字段只控制本模式。下面是插件配置，可以放在宿主 profile 的 `dsh-strata.config` 下。
Strata runner 的统一实验配置在相邻仓库的 `dsh/config.yml`，其中 `context` 整段直接传给本插件。

```yaml
mode: notes
notes:
  remindAtTokens: 59392
  checkpointAtTokens: 65536
  forceSwitchAtTokens: 81920
summary:
  compactAtTokens: 81920
  maxOutputTokens: null
full:
  stopAtTokens: null
```

所有 `AtTokens` 都是**当前上下文已用 token 数的绝对阈值**，不是剩余量、比例或整局累计费用。
计量使用服务商返回的 usage，加上此后尚未发送内容的估算；包括已有系统提示、历史与工具定义。
在下一次正常请求前检查已有上下文，随后宿主追加本步的新输入。因此它们是处理阈值，不是裁剪请求到某个精确长度的策略。

| 字段 | 默认值 | 达到阈值后的行为 |
| --- | --- | --- |
| `notes.remindAtTokens` | 59392 | 提醒准备保存笔记、主动换窗，每窗一次 |
| `notes.checkpointAtTokens` | 65536 | 要求立即保存检查点并调用 `new_context`，每窗一次 |
| `notes.forceSwitchAtTokens` | 81920 | 即使模型没有主动换窗，也强制切换；`null` 使用模型可用容量 |
| `summary.compactAtTokens` | 81920 | 用当前全部历史生成摘要并替换历史；`null` 使用模型可用容量 |
| `summary.maxOutputTokens` | `null` | 摘要调用的输出上限，包含思考；`null` 继承宿主输出预算 |
| `full.stopAtTokens` | `null` | 结束本轮并报告 `FULL_CONTEXT_LIMIT`，保留原文；`null` 不设插件阈值 |

notes 的配置满足 `remindAtTokens <= checkpointAtTokens`；强制切窗阈值为数值时，还需 `checkpointAtTokens < forceSwitchAtTokens`。
从 checkpoint 到 forceSwitch 之间就是写笔记的空间，不再单独配置缓冲或做减法。
`get_context_remaining` 返回到强制切窗的剩余量，包含这段空间；关闭 checkpoint 提示不改变窗口容量。
模型物理窗口还会扣除输出预留，可能让 notes 强制切窗或 summary 压缩更早发生；各模式的阈值不必相同。

其他设置通常不必改：`notes.maxFileBytes` 默认为 1000000，限制单个笔记的 UTF-8 字节数。
`prompts.guidance`、`prompts.reminder`、`prompts.fallback` 自定义 notes 提示，`prompts.summary` 自定义摘要提示。
提醒里的 `{n_remaining}` 替换为距强制切窗的剩余 token；`prompts.fallback: null` 只关闭 checkpoint 提示。

旧的 `contextTokens`、`reminderThresholdTokens`、`fallbackBufferTokens`、顶层 `maxFileBytes` 和 `summary.maxTokens` 已移除，使用上面的分组字段。

## 开发

插件沿用 dsh 的原生循环，挂钩顺序是：

```text
agent/pre-step → agent/request → 提交本步输入与当前画面 → 模型请求 → 工具执行与结果落盘 → 下一步
```

- **notes**：`pre-step` 处理换窗、条目编号和预算提醒；`request` 拿到本次模型路由后，补查模型切换带来的容量变化。
  `new_context` 成功返回后，窗口状态记下换窗请求，下一次 `pre-step` 再替换上下文，因此工具调用与结果会先完整落盘。
- **summary**：在 `request` 拿到模型路由后压缩已有历史，随后由宿主追加本步输入。实现见 [src/compaction/index.ts](src/compaction/index.ts)。
- **full**：在 `request` 检查可选的停止阈值；不替换上下文。

窗口和笔记状态从 Session 事件推导，原始历史交给宿主查询服务。记忆工具的使用说明由 notes 模式提供；任务提示词由宿主提供。

```sh
pnpm install --frozen-lockfile
pnpm test           # 先构建，再跑笔记、历史、预算、换窗和会话重放测试
pnpm pack
pnpm test:install   # 在隔离的 DSH_HOME 中安装打包产物并验证
```

安装测试使用脚本模型验证真实 headless 的安装、换窗、完整原文找回、自有摘要后的继续运行、跨进程恢复、禁用和卸载，不需要 API key。

## 许可

MIT。部分代码取自 DeepSeek Harness 的实验实现，版权声明见 [LICENSE](LICENSE)。
