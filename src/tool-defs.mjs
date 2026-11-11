/**
 * 工具清单（JSON Schema）。
 *
 * 从 tools.mjs 拆出来：这是一张纯数据表（名字 / 标题 / 注解 / 描述 / inputSchema），不含任何处理逻辑；
 * 描述文字里的默认值读自 config.mjs。tools.mjs 仍然重新导出 `TOOL_DEFS`，外部的导入路径不变。
 */

import {
  APPROVAL_POLICIES,
  DEFAULT_PERMISSION,
  DEFAULT_REASONING,
  DEFAULT_REASONING_EFFORT,
  DEFAULT_REVIEW,
  PERMISSION_TIERS,
  REASONING_EFFORTS,
  REASONING_MODES,
  REVIEW_MODES,
} from './config.mjs';
import { REVIEW_VERDICTS } from './review.mjs';
import { TOOL_TEXT_EN } from './tool-defs.en.mjs';

const S = (props, required = []) => ({ type: 'object', properties: props, required, additionalProperties: false });

const CONV_ID = {
  type: 'string',
  description: '会话 id，来自 dsh_start 或 dsh_list。',
};

/**
 * MCP 工具注解。四项全部显式给出：缺省值是「会改东西、有破坏性、非幂等、对外」，
 * 留空会让客户端把只读查询也当成危险操作，有的目录还会直接拒收缺项的工具。
 *   readOnly    不改任何状态；
 *   destructive 可能丢东西：中断回合、杀进程、取消排队任务，或让 agent 去改文件；
 *   idempotent  同样的参数再调一次没有额外效果；
 *   openWorld   会让 agent 跑起来（它会调模型，也可能联网）。
 */
const H = (readOnly, destructive, idempotent, openWorld) => ({
  readOnlyHint: readOnly,
  destructiveHint: destructive,
  idempotentHint: idempotent,
  openWorldHint: openWorld,
});
const READ_ONLY = H(true, false, true, false);

/**
 * 结构化输出的 schema。只给三个工具声明：它们的 structuredContent 就是 tools.mjs 里当场拼出来的
 * 固定形状。其余工具的形状随路径变化（dsh_send 可能是完整结果也可能是后台收据，dsh_queue 每个
 * action 都不同），而声明了 schema 的工具，客户端会按它校验返回值 —— 写错一个字段，那次调用
 * 就被客户端当成失败。所以这里宁可少写：required 只列永远存在的键，也不禁止多出来的键。
 */
const OUT = (props, required) => ({ type: 'object', properties: props, required });

/** 工具清单（JSON Schema）。 */
export const TOOL_DEFS = [
  {
    name: 'dsh_start',
    title: '新建会话',
    annotations: H(false, false, false, true),
    description:
      '新建一个 DSH 会话（一个可长期共事的编码 agent）。会话活在磁盘上，进程只是缓存；' +
      '进程被回收或崩溃后会自动用 ACP session/resume 复活，对话不丢。' +
      '返回 conversation_id 与对话标题。建好后用 dsh_send 派活。',
    inputSchema: S(
      {
        cwd: {
          type: 'string',
          description:
            '工作区绝对路径。决定 agent 的工作目录、AGENTS.md/技能的发现范围、以及沙箱可写根。' +
            '**省略时自动用客户端当前打开的项目目录**（MCP roots），这样客户端里看到哪个项目就在这里干活；' +
            '客户端不支持 roots、或 roots 为空时才会要求你显式传入。别传用户家目录本身 —— 那里会让 DSH 的 ACL 沙箱起不来。',
        },
        permission: {
          type: 'string',
          enum: PERMISSION_TIERS,
          description:
            `权限档。默认 ${DEFAULT_PERMISSION}。read-only 适合分析不信任样本（如恶意软件）；workspace-write 由 DSH 沙箱限制可写范围，越界请求默认 auto-allow，想在调用方挂起审批请传 on_approval=ask。` +
            '**档位在创建时定下**：DSH 设计上"resume 的会话保留它自己记录的权限"，所以事后改这个参数不会改变已有会话，要换档需新建。' +
            '（本档位是**真实生效**的 —— 由启动时传入的 env 决定，并有 test/permission.mjs 对着会话自己的记录逐档核验。）',
        },
        on_approval: {
          type: 'string',
          enum: APPROVAL_POLICIES,
          description:
            `审批处理策略。**read-only 强制 auto-deny**（传 auto-allow/ask 会被直接拒绝，否则会放行 DSH 的 sandbox 提权）；` +
            `其余档位默认 ${process.env.DSH_MCP_APPROVAL ?? 'auto-allow'}。ask 会把审批挂起，需用 dsh_approval_decide 裁决。`,
        },
        title_hint: {
          type: 'string',
          maxLength: 200,
          description:
            '可读的会话标签（最长 200 字）。注意 DSH 自己的标题是首条消息的截断前缀（约 13–15 字），会优先显示；' +
            '这里给的值不会被覆盖，而是在 dsh_get / dsh_start 里作为「标题提示」一并返回。',
        },
        reasoning_effort: {
          type: 'string',
          enum: REASONING_EFFORTS,
          description: `思考深度，默认 ${DEFAULT_REASONING_EFFORT}。注意 ACP 自身的默认是"Provider default"（不设），本服务会显式设成 max。想省钱可调低。`,
        },
        review: {
          type: 'string',
          enum: REVIEW_MODES,
          description:
            `调用方审核策略，默认 ${DEFAULT_REVIEW}。advisory：每次派活的结果/哨兵都会附审核单（核验清单 + 证据 + dsh_review 入口），` +
            '但**不阻塞**后续派活；off：不生成审核单。可被单次 dsh_send 覆盖。',
        },
        provider: { type: 'string', description: '模型提供方名（如 deepseek-official）。留空用 profile 默认。' },
        model: { type: 'string', description: '模型名（如 deepseek-flash）。指定时必须同时给 provider。' },
        keep_alive: {
          type: 'boolean',
          description:
            'true = 这个会话的进程不受空闲 TTL / MAX_LIVE 回收（用于"必须一直握住写锁"的长期会话）。' +
            '默认 false：空闲 10 分钟后进程会被回收、内存释放，下次派活自动 resume（对话不丢）。' +
            '设 true 时请记得用完 `dsh_release`，否则它会一直占着一个 DSH 进程（约 300–480MB）。',
        },
        isolation: {
          type: 'string',
          enum: ['none', 'worktree'],
          description:
            '工作区隔离，默认 none（直接在 cwd 里干活）。worktree = 为 cwd 所在的 git 仓库新建一个 worktree 和分支 `dsh/<时间>`，' +
            '会话在里面干活，主检出不受影响 —— 你（调用方）可以同时在原目录继续改文件。' +
            '基于当前 HEAD：主检出里未提交的改动不会带过去；新 worktree 里没有 node_modules 等依赖，DSH 可能要重装。' +
            '改动留在那个分支上，审核后由你自己合并；dsh_release(forget=true) 时 worktree 干净就删目录（分支保留）。',
        },
      },
      // cwd 不再是必填：有 MCP roots 的客户端会自动带上当前项目目录。
      [],
    ),
  },
  {
    name: 'dsh_send',
    title: '派发任务',
    annotations: H(false, true, false, true),
    description:
      '向会话派一个任务。**给目标，不要给命令**：DSH 自己决定用哪些文件/shell/搜索/技能/子代理/团队工具，' +
      '本服务不预先加载或代理 DSH 的工具面。' +
      '**默认不阻塞（wait=false）**：立即返回 run_id + sentinel_file，' +
      '回合在后台跑，跑完自动通知你 —— 你继续做别的事，也永远不用担心任务被"超时"打断。' +
      '想原地等结果就显式传 wait=true（可配 timeout_ms；到期只会转后台，不会取消回合）。' +
      '【超时不会毁掉任务】wait=true 到达 timeout_ms 仍没跑完时，本工具**不会报错、也不会取消回合**，' +
      '而是自动降级为后台：返回 run_id + sentinel_file，回合继续跑完，结果稍后由哨兵文件通知。' +
      '（timeout_ms=0 表示一直等。）所以任何时候你都能拿到结果，不用怕"超时了白干"。' +
      '等待模式与后台模式都在回合结束时原子落地一个含最终结果的小文件——' +
      '**推荐用后台任务（Bash run_in_background + `until [ -f sentinel_file ]`；Windows/PowerShell 用 `Test-Path` 循环，收据里给出现成命令）等它，跑完自动通知你，无需轮询**；' +
      '文件出现后读它即得结果，或用 dsh_get(conversation_id, run_id) 验收，dsh_read 可中途看输出。' +
      '默认隐藏思考内容（只返回正文 + 思考统计）。' +
      '结果与后台收据都会带 `review` 审核单（默认 advisory）：调用方核验后用 dsh_review 提交裁决。' +
      '若会话正在忙，本工具会报错——改用 dsh_send(queue=true) 入队（立即返回）、dsh_interject 打断并改口，或 dsh_interrupt 只停下。',
    inputSchema: S(
      {
        conversation_id: CONV_ID,
        prompt: { type: 'string', description: '任务描述。可以引用工作区里的文件路径。' },
        wait: {
          type: 'boolean',
          description:
            '**默认 false**：立即返回 run_id + sentinel_file，回合在后台跑，跑完由哨兵文件通知（推荐用法）。true = 原地阻塞到回合结束再返回完整结果。',
        },
        reasoning: {
          type: 'string',
          enum: REASONING_MODES,
          description: `思考内容展示档位。默认 ${DEFAULT_REASONING}（只返回正文，思考只给统计）。full 会占用大量上下文。`,
        },
        timeout_ms: {
          type: 'number',
          description:
            '仅 wait=true 时的**等待**上限（毫秒），**默认 0 = 一直等**（不会凭空发明 30 分钟）。到期不会取消回合，只会转成后台并给你 run_id。',
        },
        review: {
          type: 'string',
          enum: REVIEW_MODES,
          description:
            '本次派活的审核策略，覆盖会话默认（默认 advisory）。advisory：结果/哨兵附审核单，提示调用方独立核验后用 dsh_review 提交裁决；off：本次不附。',
        },
        queue: {
          type: 'boolean',
          description:
            '会话正忙时是否入队（默认 false = 直接报错）。true 时立即返回 run_id + queue_position，' +
            '本轮结束后自动执行；哨兵只在真正结束时写，入队时不写。队列仅内存、重启丢失，用 dsh_queue 管理。' +
            "（dsh_interject(mode='queue') 也排在本轮之后，但它会阻塞到新回合跑完，且不进这个队列。）",
        },
        client_run_id: {
          type: 'string',
          maxLength: 128,
          description:
            '调用方生成的幂等键（≤128 字符，作用域=本会话）。重复提交同一个键不会创建第二个 run，' +
            '而是返回首次 run 的结果或收据（replayed=true）。用于"响应在传输层丢了、想安全重发"的场景。',
        },
        team: {
          type: 'boolean',
          description:
            '是否在本次派发前注入"需要并行/多角色时先建团队"的提示（默认跟随 DSH_MCP_TEAM，0.4.0 起默认开）。' +
            '传 false 只对这一次关闭；彻底关闭用 DSH_MCP_TEAM=0。',
        },
      },
      ['conversation_id', 'prompt'],
    ),
  },
  {
    name: 'dsh_list',
    title: '列出会话',
    outputSchema: OUT(
      {
        count: { type: 'integer' },
        running: { type: 'integer' },
        conversations: { type: 'array', items: { type: 'object' } },
        orphan_holders: { type: 'array', items: { type: 'object' } },
        probe_ok: { type: ['boolean', 'null'] },
        probe_error: { type: ['string', 'null'] },
        probe_cached: { type: 'boolean' },
      },
      ['count', 'running', 'conversations'],
    ),
    annotations: READ_ONLY,
    description:
      '列出会话及其运行状态，用来掌控多个会话实例。' +
      'state: running（正在跑回合）/ idle（进程活着但空闲）/ detached（进程没开，可 resume 复活）。' +
      'running 的会话会带上已跑时长、当前正在执行的工具、本轮已产出字数。' +
      '数据来自两路合并：本服务持有的 + DSH 磁盘上尚未打开的（DSH 的 session/list 会排除已打开的会话）。' +
      '想只看正在跑的，传 only_running=true；想看某个会话当前吐出的内容，接着用 dsh_read。',
    inputSchema: S({
      cwd: { type: 'string', description: '只看某个工作区下的会话。' },
      include_closed: {
        type: 'boolean',
        description:
          '是否包含磁盘上未打开的会话（含别的实例 / GUI 建的），默认 true。**代价：要 spawn 一个 DSH 进程去探测磁盘，实测约 1 秒**（结果缓存 10 秒）。只列本服务已打开的会话就传 false，毫秒级。',
      },
      only_running: {
        type: 'boolean',
        description: '只返回正在跑回合的会话，默认 false。**此模式自动跳过磁盘探测，毫秒级**（正在跑的会话必然在内存里）。',
      },
    }),
  },
  {
    name: 'dsh_read',
    title: '读取运行输出',
    annotations: READ_ONLY,
    description:
      '读会话的运行期输出（**游标式增量**）——用它可以看到"正在跑的会话"当前吐出了什么，' +
      '不必等回合结束。典型用法：dsh_list(only_running) 找到在跑的会话 → 反复 dsh_read 并回传上次的 cursor，' +
      '就能像切换窗口一样轮流观察多个会话。' +
      '输出缓冲**只在内存里且有界**（环形，满则丢最旧），服务/进程退出即消失；' +
      '**思考内容不进缓冲**——只有 include_reasoning=true 时才会附带"当前正在跑那一轮"的实时思考。' +
      'cursor 是**修订号**：同一条目被追加文本后会再次返回，调用方按 `seq` 用它替换全文（不要重复累加）。',
    inputSchema: S(
      {
        conversation_id: CONV_ID,
        cursor: { type: 'number', description: '上次返回的 cursor；首次不传或传 0。' },
        include_reasoning: { type: 'boolean', description: '附带当前回合的实时思考内容，默认 false。' },
        limit: { type: 'number', description: '单次最多返回多少条，默认 200。' },
      },
      ['conversation_id'],
    ),
  },
  {
    name: 'dsh_get',
    title: '查看会话或回合结果',
    annotations: READ_ONLY,
    description:
      '查看单个会话的详情；带 run_id 时**取那一次派活的最终结果**（异步模式的验收入口）。' +
      '不传 run_id 则取最近一次回合。返回：标题、工作区、权限档、状态、轮数、token 用量、' +
      '上下文压力、待决审批，以及该回合的完整结果（正文/工具/用量/错误）和 **review 审核单**。' +
      '**run 记录只在内存、最多保留最近 20 条**；服务重启或记录被挤掉后会从哨兵文件回读（它落盘且扛重启）。',
    inputSchema: S(
      {
        conversation_id: CONV_ID,
        run_id: { type: 'string', maxLength: 200, description: 'dsh_send 返回的 run_id；不传则取最近一次回合。' },
        client_run_id: {
          type: 'string',
          maxLength: 128,
          description: '按调用方幂等键取 run（与 run_id 二选一；只对仍在内存里的 run 有效，最多最近 20 条）。',
        },
        max_chars: {
          type: 'number',
          description:
            '结果预算（默认 0 = 不截断，返回完整结果）。>0 时**同时**作用于 text 与 structured：' +
            '正文截到该长度（附 answer_truncated/next_offset），structured.run.result.tools_used 只保留' +
            '工具名/状态与 input_chars，不再带完整输入。完整结果始终在 sentinel_file 里。' +
            '一个回合用了很多工具时，默认返回可能超过客户端单次工具结果上限，建议传 8000 左右。',
        },
      },
      ['conversation_id'],
    ),
  },
  {
    name: 'dsh_review',
    title: '提交审核裁决',
    annotations: H(false, false, false, false),
    description:
      '提交对一次**已结束**回合结果的**调用方审核裁决**（回合进行中放行/拒绝 DSH 的权限请求用 dsh_approval_decide）。dsh_send / dsh_interject / 哨兵里的 result 会带 `review` 审核单' +
      '（核验清单 + 证据摘要 + review_id）。在把结果当作完成之前，调用方应自己核验（读改动的文件、看 git diff、跑测试等），' +
      '再调用本工具记录 pass / partial / fail。' +
      '**默认是建议式审核**：不阻塞后续 dsh_send，也不会自动把审核意见回灌给 DSH；需要修就再 dsh_send。' +
      'run 记录被内存挤出或服务重启后仍可提交（以哨兵文件为准）。',
    inputSchema: S(
      {
        conversation_id: CONV_ID,
        run_id: { type: 'string', maxLength: 200, description: '要审核的那次派活（审核单里的 run_id）。' },
        verdict: {
          type: 'string',
          enum: REVIEW_VERDICTS,
          description: 'pass=可直接采用；partial=部分可用、需补充；fail=不可用、需重做。fail/partial 必须说明理由。',
        },
        notes: { type: 'string', description: '审核理由。fail/partial 必填（或改用 findings），最多 8000 字。' },
        findings: {
          type: 'array',
          items: { type: 'string' },
          description: '逐条问题清单，可选；最多 50 条、每条 2000 字。',
        },
      },
      ['conversation_id', 'run_id', 'verdict'],
    ),
  },
  {
    name: 'dsh_interject',
    title: '插话',
    annotations: H(false, true, false, true),
    description:
      '插话：会话正在跑某个回合时往里补一句话，**本工具会阻塞到新回合跑完**（timeout_ms 到期才转后台）。两种模式——' +
      'interject（默认）打断当前回合并立刻改口；queue 不打断，等本轮自然结束后紧接着说（不进 dsh_queue 的队列）。' +
      '只想停下、不说新话用 dsh_interrupt；想排到本轮之后又不阻塞用 dsh_send(queue=true)。' +
      '会话空闲时按 **wait=true 的普通回合**执行（返回完整结果，不是收据）。' +
      '说明：ACP 明确拒绝并发 prompt，所以做不到"让模型在同一个回合里即时改向"；' +
      'interject 是它的实用等价物（取消 + 立刻开新回合，历史完整保留）。',
    inputSchema: S(
      {
        conversation_id: CONV_ID,
        message: { type: 'string', description: '要插进去说的话。' },
        mode: {
          type: 'string',
          enum: ['interject', 'queue'],
          description: 'interject（默认）= 打断并改口；queue = 等本轮跑完接着说。',
        },
        reasoning: {
          type: 'string',
          enum: REASONING_MODES,
          description: `思考内容展示档位，默认 ${DEFAULT_REASONING}。`,
        },
        timeout_ms: { type: 'number', description: '新回合的**等待**上限（毫秒），**默认 0 = 一直等**；queue 模式也用它限制等待上一轮结束。忙时等待超时会报错（本次插话未发送，会话不受损）；空闲时到期只转后台，不取消回合。' },
        review: {
          type: 'string',
          enum: REVIEW_MODES,
          description: '本次插话回合的审核策略，覆盖会话默认（默认 advisory）；off 可关闭本次审核单。',
        },
        client_run_id: {
          type: 'string',
          maxLength: 128,
          description: '调用方生成的幂等键（≤128 字符，作用域=本会话）。重复提交返回首次的 run，不会重复插话。',
        },
      },
      ['conversation_id', 'message'],
    ),
  },
  {
    name: 'dsh_interrupt',
    title: '中断回合',
    annotations: H(false, true, true, false),
    description:
      '只停下、不说新话：中断会话当前正在进行的回合（ACP 原生 session/cancel，走的就是用户手动按停止那条路径）。' +
      '被中断的回合记为 cancelled，已产出的正文与工具调用留在它的结果里（dsh_get / 哨兵），已改动的文件不会回滚。' +
      '会话本身保持完好，可以立刻继续派新任务。想停下并立刻改口用 dsh_interject；取消还没开始的排队任务用 dsh_queue(action=remove)。',
    inputSchema: S({ conversation_id: CONV_ID }, ['conversation_id']),
  },
  {
    name: 'dsh_takeover',
    title: '抢占写锁',
    annotations: H(false, true, false, false),
    description:
      '**抢占会话的写锁**（DSH 的写锁是跨进程内核信号量，持有者活着就不过期，没有 API 能直接夺走——' +
      '唯一手段是杀掉持有者进程，所以本工具会先判定持有者是谁）：' +
      '① 若锁其实空着，正常 resume 即可，不会杀任何东西；' +
      '② 若持有者是**本服务自己留下的孤儿进程**（MCP 崩了/重启了，子进程还活着握着锁）→ **自动杀掉并接管**，安全；' +
      '③ 若持有者是**另一个活着的 dsh-any-agent 实例** → 默认拒绝，传 force=true 才夺；' +
      '④ 若持有者无法识别（**多半是你自己的 DSH GUI 正开着这个会话**）→ **绝不杀**（那会连你的界面和正在看的对话一起杀掉），' +
      '只报告，请你在那个窗口里关掉该会话后重试。' +
      '注意：杀掉正在跑回合的持有者会中断那一轮（会话日志记为 interrupted），会话本体不受损。',
    inputSchema: S(
      {
        conversation_id: CONV_ID,
        force: {
          type: 'boolean',
          description: '仅用于"另一个活着的 dsh-any-agent 实例持有"这一种情况；对 GUI/未知持有者无效（永远不杀）。',
        },
      },
      ['conversation_id'],
    ),
  },
  {
    name: 'dsh_release',
    title: '释放会话',
    annotations: H(false, true, true, false),
    description:
      '释放会话占用的 DSH 进程（释放写锁，让用户能在自己的 DSH GUI 里打开同一个会话）。' +
      '会话本体留在磁盘上，之后仍可 resume；**forget=true 会写墓碑**：从注册表移除，此后按 id 查询明确报“已被 forget”' +
      '（想恢复可按错误里的路径删除墓碑文件，默认在 `$DSH_HOME/.dsh-any-agent-forgotten/<id>.json`）。' +
      '★ 用完了想一次性腾内存就传 all=true（每个会话约 300-480MB；默认 `MAX_LIVE=4` 会回收最久未用者，' +
      'all=true 会释放**空闲**会话，正在跑回合的默认跳过；确实要连跑着的也停掉请传 force=true）。' +
      '对单个会话 release 会停掉其 DSH 进程；若它正在跑回合，该回合会被中断。',
    inputSchema: S(
      {
        conversation_id: CONV_ID,
        forget: { type: 'boolean', description: '同时从本服务的注册表里移除，默认 false。' },
        all: {
          type: 'boolean',
          description: '忽略 conversation_id，释放所有**空闲**会话进程（腾内存用）。正在跑回合的默认跳过。默认 false。',
        },
        force: {
          type: 'boolean',
          description: '仅配合 all=true：连正在跑回合的会话也停掉（会中断那些回合）。默认 false。',
        },
      },
      [],
    ),
  },
  {
    name: 'dsh_approval_decide',
    title: '裁决审批',
    annotations: H(false, true, false, false),
    description:
      '回合进行中裁决 DSH 正在等的一个权限请求（仅当会话的 on_approval=ask 时会出现），放行或拒绝后回合继续。' +
      '用于把 DSH 的越权/提权请求交给调用方决定，既不一律放行也不一律拒绝。给已结束回合的结果打分用 dsh_review。',
    inputSchema: S(
      {
        conversation_id: CONV_ID,
        approval_id: { type: 'string', description: '来自 dsh_inbox 或 dsh_get 的 pending_approvals。' },
        decision: { type: 'string', enum: ['allow', 'deny'], description: '放行或拒绝。' },
      },
      ['conversation_id', 'approval_id', 'decision'],
    ),
  },
  {
    name: 'dsh_status',
    title: '会话状态',
    outputSchema: OUT(
      {
        conversation_id: { type: 'string' },
        state: { type: 'string', enum: ['running', 'idle', 'detached'] },
        alive: { type: 'boolean' },
        busy: { type: 'boolean' },
        turns: { type: 'number' },
        pending_approvals: { type: 'array', items: { type: 'string' } },
        run: { type: ['object', 'null'] },
        review: { type: ['object', 'null'] },
      },
      ['conversation_id', 'state'],
    ),
    annotations: READ_ONLY,
    description:
      '单个会话的轻量快照：读本服务内存里的实时状态，不拉起 DSH 进程。返回 state（running/idle/detached）、' +
      '在跑时的当前工具与已产出字数、最近一次回合的 run_id/状态/审核状态、待决审批、队列长度，' +
      '以及写锁持有者 lock_holder（撞锁时据此决定用 dsh_takeover 还是让对方 dsh_release）。' +
      '要回合的完整结果用 dsh_get，看正在跑的输出用 dsh_read，看所有会话用 dsh_list。',
    inputSchema: S({ conversation_id: CONV_ID }, ['conversation_id']),
  },
  {
    name: 'dsh_inbox',
    title: '审批收件箱',
    outputSchema: OUT(
      {
        count: { type: 'integer' },
        approvals: { type: 'array', items: { type: 'object' } },
      },
      ['count', 'approvals'],
    ),
    annotations: READ_ONLY,
    description:
      '**跨会话的待决审批收件箱**（dsh_status 只看单个会话）。' +
      '一次列出所有会话里等你裁决的审批：会话 id/标题、审批 id、工具、原因、命令/路径摘要、等待时长。' +
      '裁决用 dsh_approval_decide。没有待决审批时返回空列表。',
    inputSchema: S(
      {
        conversation_id: { type: 'string', description: '只看某个会话（省略 = 全部）' },
        include_input: { type: 'boolean', description: '是否带操作输入摘要（默认 true）' },
      },
      [],
    ),
  },
  {
    name: 'dsh_queue',
    title: '管理队列',
    annotations: H(false, true, false, false),
    description:
      '查看/修改会话的待执行队列（只管理已入队的任务，入队用 dsh_send(queue=true)；**仅内存**，重启丢失）。' +
      'action=list 列出；remove 取消并写 cancelled 哨兵；update 改写排队文本；promote 提到队首。',
    inputSchema: S(
      {
        conversation_id: CONV_ID,
        action: { type: 'string', enum: ['list', 'remove', 'update', 'promote'] },
        run_id: { type: 'string', maxLength: 200, description: 'remove / update / promote 必填' },
        text: { type: 'string', description: 'update 时的新文本' },
      },
      ['conversation_id', 'action'],
    ),
  },
  {
    name: 'dsh_doctor',
    title: '体检',
    annotations: READ_ONLY,
    description:
      '只读体检：DSH 可执行文件与版本、profile 是否存在/漂移、状态文件、runs/locks 目录可写、孤儿锁、' +
      '当前会话数与 RSS、生效配置。只报告不修改；ok=false 表示存在 fail 项。',
    inputSchema: S({}, []),
  },
];

/**
 * 按语言给出工具清单。中文就是 TOOL_DEFS 本身；英文把标题、描述和参数描述换成
 * tool-defs.en.mjs 里的文字，名字、schema 结构与注解一律不变。
 */
export function localizeToolDefs(lang, defs = TOOL_DEFS) {
  if (lang !== 'en') return defs;
  return defs.map((t) => {
    const en = TOOL_TEXT_EN[t.name];
    if (!en) return t;
    const properties = {};
    for (const [key, schema] of Object.entries(t.inputSchema.properties)) {
      properties[key] = en.params?.[key] ? { ...schema, description: en.params[key] } : schema;
    }
    return { ...t, title: en.title, description: en.description, inputSchema: { ...t.inputSchema, properties } };
  });
}
