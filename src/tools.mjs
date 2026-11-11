/**
 * 工具定义与实现。
 *
 * 抽象单位是"会话 + 任务"，不是"命令"——不把 DSH 自己的文件/命令工具 1:1 代理出去，
 * 因为调用方 agent 已经有那些工具了。
 */

import { readFileSync } from 'node:fs';
import {
  DEFAULT_PERMISSION,
  DEFAULT_REASONING,
  TEAM_ACTIVE,
  DSH_PROFILE,
  toPosixPath,
} from './config.mjs';
import { audit } from './audit.mjs';
import { L } from './lang.mjs';
import { listOrphans } from './locks.mjs';
import { normalizeReviewMode } from './review.mjs';
import { runDoctor } from './doctor.mjs';
import {
  backgroundReceipt,
  compactResultForBudget,
  queuedReceipt,
  renderReviewSection,
  renderSendResult,
  replayRun,
} from './tool-render.mjs';

// 外部（mcp.mjs、测试）一直从 tools.mjs 取这些名字；拆出去之后导入路径保持不变。
export { TOOL_DEFS } from './tool-defs.mjs';
export { compactResultForBudget, psReadCommand, psWaitCommand } from './tool-render.mjs';

/**
 * timeout_ms 校验：只接受 >= 0 的有限数字（0 = 一直等）。
 *
 * 之前直接透传：'abc' → NaN → prompt 里 `NaN <= 0` 为假、setTimeout(NaN) 立即触发，
 * 静默降级成后台收据；非有限值或负数一律报错，别让调用方以为自己在原地等。
 */
function parseTimeoutMs(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(L('timeout_ms 必须是 >= 0 的有限数字', 'timeout_ms must be a finite number >= 0'));
  return n;
}

/**
 * 团队模式下注入到派发 prompt 前的一句策略。
 * 只描述"需要时怎么做"，不改变任务本身；简单任务不会因此组队。
 */
const TEAM_PREFIX = L(
  '【团队】如果这个任务需要并行或多角色协作，先用 spawn_teammate 创建团队再执行；' +
    '不需要就单 agent 完成。不要为简单任务组队。\n\n',
  '[Team] If this task needs parallel or multi-role work, create a team with spawn_teammate first and then do it; ' +
    'otherwise finish it as a single agent. Do not form a team for a simple task.\n\n',
);

/**
 * 工具处理器表。
 *
 * @param {object} hub
 * @param {{projectDir?: () => Promise<string|null>}} [opts]
 *   projectDir：客户端当前打开的项目目录（MCP roots）。不传 cwd 时用它兜底 ——
 *   让「在客户端里看到哪个项目，就在哪个项目干活」成为默认行为，而不是让
 *   调用方每次都自己拼绝对路径（拼错了就落到家目录，撞上 ACL 沙箱那个坑）。
 */
export function createHandlers(hub, opts = {}) {
  const projectDir = typeof opts.projectDir === 'function' ? opts.projectDir : null;

  return {
    async dsh_start(args) {
      let cwd = args.cwd;
      let cwdSource = cwd ? 'explicit' : null;
      if (!cwd && projectDir) {
        // 客户端声明了 roots 才有；拿不到就照旧要求显式传，不猜。
        const fromClient = await projectDir();
        if (fromClient) {
          cwd = fromClient;
          cwdSource = 'client-root';
        }
      }
      const conv = await hub.create({
        cwd,
        permission: args.permission ?? DEFAULT_PERMISSION,
        onApproval: args.on_approval,
        titleHint: args.title_hint,
        reasoningEffort: args.reasoning_effort,
        review: args.review,
        provider: args.provider,
        model: args.model,
        keepAlive: args.keep_alive === true,
        isolation: args.isolation,
      });
      if (args.title_hint) conv.titleHint = args.title_hint;
      audit('start', {
        conversation_id: conv.id,
        permission: conv.permission,
        keep_alive: conv.keepAlive === true,
      });
      const snap = conv.snapshot();
      const lines = [
        L('已创建会话。', 'Conversation created.'),
        `conversation_id: ${snap.conversation_id}`,
        L(`工作区: ${snap.cwd}`, `Workspace: ${snap.cwd}`) +
          (cwdSource === 'client-root' ? L('（取自客户端当前打开的项目）', ' (the project the client has open)') : ''),
        L(
          `权限档: ${snap.permission}（审批策略 ${snap.on_approval}）`,
          `Permission: ${snap.permission} (approval policy ${snap.on_approval})`,
        ),
        L(`思考深度: ${snap.reasoning_effort}`, `Reasoning effort: ${snap.reasoning_effort}`),
        snap.keep_alive
          ? L(
              '保活: 是（不受空闲 TTL / MAX_LIVE 回收；用完请 dsh_release）',
              'Keep alive: yes (exempt from idle-TTL / MAX_LIVE reaping; dsh_release when done)',
            )
          : L(
              '保活: 否（空闲后可被回收，下次派活自动 resume）',
              'Keep alive: no (may be reaped when idle; the next dispatch resumes it)',
            ),
        L('团队模式: ', 'Team mode: ') +
          (TEAM_ACTIVE
            ? L(
                `开（profile=${DSH_PROFILE}；派发时会提示"需要时先建团队"，简单任务不会组队）`,
                `on (profile=${DSH_PROFILE}; dispatches carry a "form a team first when needed" hint, simple tasks stay single-agent)`,
              )
            : L('关（默认关闭；需要时运行 dsh-any-agent team on）', 'off (the default; run dsh-any-agent team on to enable)')),
        L('对话名: ', 'Title: ') +
          (snap.title ?? L('(DSH 尚未生成，发出第一条消息后自动生成)', '(not generated yet; DSH creates it after the first message)')) +
          (snap.title_hint && snap.title !== snap.title_hint
            ? L(`（你给的标题提示: ${snap.title_hint}）`, ` (your title hint: ${snap.title_hint})`)
            : ''),
        L('工作区登记: ', 'Workspace registration: ') +
          (snap.workspace_registered
            ? L('已写入 DSH 工作区注册表（GUI 里能看到）', "written to DSH's workspace registry (visible in the GUI)")
            : L('未登记', 'not registered')),
      ];
      if (snap.worktree) {
        const w = snap.worktree;
        lines.push(L(
          `隔离 worktree: ${w.path}（分支 ${w.branch}，基于 ${String(w.base).slice(0, 7)}）。改动留在这个分支上，审核后由你合并。`,
          `Isolated worktree: ${w.path} (branch ${w.branch}, based on ${String(w.base).slice(0, 7)}). Changes stay on that branch for you to review and merge.`,
        ));
        if (w.main_dirty) {
          lines.push(L(
            '⚠️ 主检出里有未提交的改动，它们不在这个 worktree 里；需要的话先提交再建会话。',
            '⚠️ The main checkout has uncommitted changes that are not in this worktree; commit them first if DSH needs them.',
          ));
        }
      }
      if (snap.config_failed?.length) {
        lines.push(L(
          `⚠️ 配置未完全套用: ${snap.config_failed.join('; ')}`,
          `⚠️ Configuration not fully applied: ${snap.config_failed.join('; ')}`,
        ));
        if (snap.config_failed.some((f) => String(f).startsWith('模型='))) {
          lines.push(L(
            '⚠️ 指定的 provider/model 无效：本会话已回退到 profile 默认模型，' +
              '后续回合**不会**使用你指定的模型。',
            '⚠️ The provider/model you gave is not valid: this conversation fell back to the profile default model, ' +
              'and later turns will **not** use the model you asked for.',
          ));
        }
      }
      return { structured: snap, text: lines.join('\n') };
    },

    async dsh_send(args) {
      // 空/纯空白 prompt 会被 DSH 以 [-32602] 拒绝；默认 wait=false 下那会变成
      // 一个“accepted 但注定失败”的收据（错误只异步出现在哨兵里）。这里同步拦下。
      if (typeof args.prompt !== 'string' || args.prompt.trim() === '') {
        throw new Error(L('prompt 不能为空：至少包含一个非空白字符', 'prompt must not be empty: it needs at least one non-whitespace character'));
      }
      const conv = await hub.get(args.conversation_id);
      const review = args.review === undefined ? undefined : normalizeReviewMode(args.review, conv.review);
      const opts = { reasoning: args.reasoning ?? DEFAULT_REASONING };
      if (review !== undefined) opts.review = review;
      if (args.timeout_ms !== undefined && args.timeout_ms !== null) opts.timeoutMs = parseTimeoutMs(args.timeout_ms);

      // ── 幂等：同一个 client_run_id 直接返回首次的 run，不重复执行 ──
      if (args.client_run_id) {
        if (String(args.client_run_id).length > 128) throw new Error(L('client_run_id 最长 128 字符', 'client_run_id may be at most 128 characters'));
        const existing = conv.getRunByClientId(args.client_run_id);
        if (existing) {
          audit('send_replay', {
            conversation_id: conv.id,
            run_id: existing.run_id,
            client_run_id: args.client_run_id,
          });
          return replayRun(hub, conv, existing, args.wait === true);
        }
      }

      // 团队提示：只描述"需要时怎么做"，不改变任务本身；简单任务不会因此组队。
      const teamOn = TEAM_ACTIVE && args.team !== false;
      const promptText = teamOn ? TEAM_PREFIX + args.prompt : args.prompt;

      // ── 忙时：显式 queue=true 才入队；否则保持"直接报错"的旧契约 ──
      if (conv.busy) {
        if (args.queue === true && args.wait !== true) {
          const { run, position, deduped } = conv.enqueue(promptText, {
            reasoning: opts.reasoning,
            clientRunId: args.client_run_id ?? null,
            preview: args.prompt,
            review: review ?? conv.review,
          });
          if (deduped) return replayRun(hub, conv, run, false);
          audit('send_queued', {
            conversation_id: conv.id,
            run_id: run.run_id,
            position,
            client_run_id: args.client_run_id ?? null,
          });
          return queuedReceipt(hub, conv, run, position);
        }
        throw new Error(L(
          '会话正在跑另一个回合，无法再排一个。可以：dsh_interject（插话）、dsh_interrupt（打断）后重试，' +
            '或 dsh_send(queue=true) 入队。',
          'The conversation is running another turn, so this one cannot start. Use dsh_interject (stop and redirect), ' +
            'dsh_interrupt (stop) and retry, or dsh_send(queue=true) to enqueue.',
        ));
      }

      const wait = args.wait === true;
      // 记录与预览保留调用方原文；实际派发用 promptText（可能带团队提示）。
      const run = conv.createRun(args.prompt, {
        clientRunId: args.client_run_id ?? null,
        review: review ?? conv.review,
      });
      // prompt() 自己负责收尾与写哨兵。这里 await 是为了**同步暴露 resume/启动失败** ——
      // 否则调用方会拿到一个 accepted 但注定失败的收据（冷启动要几秒，热会话瞬时）。
      const r = await conv.prompt(promptText, { ...opts, run, wait });
      conv.lastResult = r;
      audit('send', {
        conversation_id: conv.id,
        run_id: r?.run_id ?? run.run_id,
        wait,
        still_running: Boolean(r?.still_running),
        client_run_id: args.client_run_id ?? null,
      });
      if (r?.still_running) return backgroundReceipt(hub, conv, r);
      return { structured: r, text: renderSendResult(r) };
    },

    async dsh_list(args) {
      let items = await hub.list({
        cwd: args.cwd,
        // only_running 只关心"正在跑"的会话，而那些必然在本服务内存里 ——
        // 磁盘探测（要 spawn 一个 DSH 进程，实测约 1 秒）对它是纯浪费，且语义等价。
        includeClosed: args.only_running === true ? false : args.include_closed !== false,
      });
      if (args.only_running === true) items = items.filter((c) => c.state === 'running');
      const running = items.filter((c) => c.state === 'running').length;
      const describe = (c) => {
        const bits = [`${c.title ?? L('(无标题)', '(untitled)')}`, `id=${c.conversation_id}`];
        if (c.state === 'running') {
          const sec = ((c.running_ms ?? 0) / 1000).toFixed(0);
          const extra = [
            L(`已跑${sec}s`, `${sec}s so far`),
            c.current_tool ? L(`工具=${c.current_tool}`, `tool=${c.current_tool}`) : null,
            c.out_chars ? L(`本轮输出=${c.out_chars}字`, `output this turn=${c.out_chars} chars`) : null,
          ].filter(Boolean);
          bits.push(L(`🔵进行中(${extra.join(', ')})`, `🔵running (${extra.join(', ')})`));
        } else if (c.state === 'idle') {
          bits.push(L('🟢空闲', '🟢idle'));
        } else {
          bits.push(L('⚪未打开(可 resume)', '⚪not open (resumable)'));
        }
        bits.push(`cwd=${c.cwd}`);
        if (c.permission) bits.push(L(`权限=${c.permission}`, `permission=${c.permission}`));
        if (c.turns != null) bits.push(L(`轮数=${c.turns}`, `turns=${c.turns}`));
        if (c.rss_mb != null) bits.push(`rss=${c.rss_mb}MB`);
        if (c.keep_alive) bits.push(L('保活', 'keep-alive'));
        if (c.queue_length) bits.push(L(`队列=${c.queue_length}`, `queue=${c.queue_length}`));
        return `- ${bits.join(' | ')}`;
      };
      const probe = hub.lastProbe ?? { ok: null, error: null, cached: false };
      const probeNote = probe.ok === false
        ? L(
            `\n\n⚠️ 磁盘会话探测失败：${probe.error}\n   上面只列出本服务已打开的会话；磁盘上未打开的会话可能没显示。`,
            `\n\n⚠️ Probing sessions on disk failed: ${probe.error}\n   Only conversations this server has open are listed above; ones on disk that are not open may be missing.`,
          )
        : '';
      const text = items.length
        ? L(
            `${items.length} 个会话（其中 ${running} 个正在跑）：\n`,
            `${items.length} conversations (${running} running):\n`,
          ) + items.map(describe).join('\n')
        : probe.ok === false
          ? L('(本服务没有已打开的会话；磁盘探测失败)', '(this server has no open conversations; the disk probe failed)')
          : L('(没有会话)', '(no conversations)');
      // 孤儿锁持有者：上一代 MCP 崩了但它的 DSH 子进程还活着握着写锁 —— 不主动报出来，
      // 用户只会在下一次撞上"被占用"时才发现。这里顺手提示，并给出可执行的动作。
      const orphans = listOrphans();
      const orphanAge = (o) => (o.age_ms === null ? L('未知', 'unknown') : Math.round(o.age_ms / 1000) + 's');
      const orphanNote = orphans.length
        ? L(
            `\n\n⚠️ 发现 ${orphans.length} 个**孤儿锁持有者**（MCP 已退出、子进程还握着写锁）：\n`,
            `\n\n⚠️ Found ${orphans.length} **orphan lock holders** (the MCP exited while its child still holds the write lock):\n`,
          ) +
          orphans.map((o) => L(
            `- 会话 ${o.conversation_id}（子进程 PID ${o.child_pid}，已失联 ${orphanAge(o)}）`,
            `- conversation ${o.conversation_id} (child PID ${o.child_pid}, out of contact for ${orphanAge(o)})`,
          )).join('\n') +
          L(
            '\n→ 用 dsh_takeover 抢占即可（这些是本服务自己的残留，抢占是安全的）。',
            '\n→ Take them over with dsh_takeover (they are this server\'s own leftovers, so that is safe).',
          )
        : '';
      return {
        structured: {
          count: items.length,
          running,
          conversations: items,
          orphan_holders: orphans,
          probe_ok: probe.ok,
          probe_error: probe.error ?? null,
          probe_cached: probe.cached === true,
        },
        text: text + probeNote + orphanNote,
      };
    },

    async dsh_read(args) {
      const conv = await hub.get(args.conversation_id);
      const r = conv.readOut({
        cursor: args.cursor ?? 0,
        includeReasoning: args.include_reasoning === true,
        limit: args.limit ?? 200,
      });
      const render = (e) => {
        if (e.kind === 'user') return `[${L('我', 'me')}] ${e.text}`;
        if (e.kind === 'text') return `[DSH] ${e.text}`;
        if (e.kind === 'tool') return `[${L('工具', 'tool')}] ${e.text}`;
        if (e.kind === 'turn') return `[${L('轮次', 'turn')}] ${e.text}`;
        return `[${e.kind}] ${e.text}`;
      };
      const flags = [
        L(`状态=${r.state}`, `state=${r.state}`),
        r.current_tool ? L(`正在执行=${r.current_tool}`, `running=${r.current_tool}`) : null,
        `cursor=${r.cursor}`,
        r.gap ? L('⚠️缓冲已覆盖中间一段，去重不保证', '⚠️the buffer overwrote part of the middle; de-duplication is not guaranteed') : null,
        r.has_more ? L('还有更多（继续用新 cursor 拉）', 'more available (keep reading with the new cursor)') : null,
      ].filter(Boolean);
      const body = r.entries.length ? r.entries.map(render).join('\n') : L('(游标之后没有新输出)', '(no new output after the cursor)');
      const think = r.live_thinking
        ? L(`\n--- 当前回合实时思考 ---\n`, `\n--- Live reasoning of the current turn ---\n`) + r.live_thinking
        : '';
      return { structured: r, text: `${flags.join(' | ')}\n\n${body}${think}` };
    },

    async dsh_get(args) {
      const conv = await hub.get(args.conversation_id);
      const snap = conv.snapshot();
      let run = null;
      let runSource = null;
      const meta = [];
      // DSH 的自动标题是首条消息的截断前缀，信息量低；调用方给过 title_hint 就一并显示。
      const titleKind = snap.title_source === 'native'
        ? L('DSH 自动生成', 'generated by DSH')
        : snap.title_source === 'title_hint'
          ? L('来自 title_hint（DSH 尚未生成标题）', 'from title_hint (DSH has not generated a title yet)')
          : L('尚未生成', 'not generated yet');
      meta.push(
        L('对话名: ', 'Title: ') + (snap.title ?? L('(尚未生成)', '(not generated yet)')) + L(`（${titleKind}）`, ` (${titleKind})`) +
        (snap.title_hint && snap.title !== snap.title_hint ? L(` / 标题提示: ${snap.title_hint}`, ` / title hint: ${snap.title_hint}`) : ''));
      meta.push(L(`工作区: ${snap.cwd}`, `Workspace: ${snap.cwd}`));
      meta.push(L('状态: ', 'State: ') + (snap.busy
        ? L('忙', 'busy')
        : snap.alive ? L('空闲(进程活着)', 'idle (process alive)') : L('未打开(可用 resume 复活)', 'not open (resumable)')));
      meta.push(L(`权限档: ${snap.permission} / 审批 ${snap.on_approval}`, `Permission: ${snap.permission} / approval ${snap.on_approval}`));
      meta.push(L(`轮数: ${snap.turns}`, `Turns: ${snap.turns}`));
      if (snap.model) {
        meta.push(L('模型: ', 'Model: ') + `${snap.model.provider}/${snap.model.model}${snap.model.reasoningEffort ? ` (${snap.model.reasoningEffort})` : ''}`);
      }
      if (snap.usage) meta.push(`token: in=${snap.usage.uncachedInputTokens ?? 0} out=${snap.usage.outputTokens ?? 0} cache=${snap.usage.cacheReadTokens ?? 0}`);
      if (snap.context_pressure) {
        meta.push(L('上下文压力: ', 'Context pressure: ') + `${snap.context_pressure.pressureTokens}/${snap.context_pressure.contextWindow}`);
      }
      if (snap.pending_approvals?.length) meta.push(L('待决审批: ', 'Pending approvals: ') + snap.pending_approvals.join(', '));
      if (snap.queue_length) {
        meta.push(L(`队列: ${snap.queue_length} 条待执行（dsh_queue list）`, `Queue: ${snap.queue_length} waiting (dsh_queue list)`));
      }
      for (const detail of snap.pending_approval_details ?? []) {
        const summary = [detail.title ?? detail.tool, detail.reason ?? detail.description].filter(Boolean).join(' — ');
        meta.push(`  ${detail.approval_id}: ${summary.slice(0, 300)}` + L('（操作输入见 pending_approval_details）', ' (the operation input is in pending_approval_details)'));
      }
      if (args.client_run_id) {
        run = conv.getRunByClientId(args.client_run_id);
        if (!run) {
          throw new Error(L(
            `未知 client_run_id: ${args.client_run_id}（只在内存里保留最近 20 条；已淘汰/服务重启后请用 run_id 或直接读哨兵文件）`,
            `Unknown client_run_id: ${args.client_run_id} (only the latest 20 are kept in memory; after eviction or a restart use run_id or read the sentinel file)`,
          ));
        }
        runSource = 'client_run_id';
      } else if (args.run_id) {
        try {
          run = conv.getRun(args.run_id);
        } catch {
          run = null;
        }
      } else {
        run = conv.getRun();
      }
      if (run && !runSource) runSource = 'memory';
      // ★ 内存只留最近 MAX_RUNS 条；服务重启或被挤出后，run_id 只能从哨兵文件回读。
      //   哨兵是"一个回合 = 一个文件"的落盘权威，把它接进入口，调用方不必自己拼路径。
      if (!run && args.run_id) {
        const file = hub.runSentinelPath(args.conversation_id, args.run_id);
        try {
          const raw = JSON.parse(readFileSync(file, 'utf8'));
          run = {
            run_id: raw.run_id ?? args.run_id,
            status: raw.status ?? 'unknown',
            started_at: null,
            ended_at: raw.ended_at ?? null,
            elapsed_ms: null,
            prompt_preview: null,
            result: raw.result ?? null,
          };
          runSource = 'sentinel';
        } catch {
          // 文件不存在或不可解析：保持 run=null，下面给明确报错
        }
      }
      if (args.run_id && !run) {
        throw new Error(L(
          `未知 run_id: ${args.run_id}（内存只留最近 20 条；哨兵文件 ${hub.runSentinelPath(args.conversation_id, args.run_id)} 也不存在或不可读）`,
          `Unknown run_id: ${args.run_id} (only the latest 20 are kept in memory, and the sentinel file ${hub.runSentinelPath(args.conversation_id, args.run_id)} does not exist or cannot be read)`,
        ));
      }
      // 预算同时作用于 text 与 structured：Claude Code 等客户端会把 structuredContent
      // 一并塞进上下文，只截 text 时一次带几十个工具输入的回合仍会超过单次结果上限
      // （实测 75K 字符被拒收）。完整结果始终在哨兵文件里。
      const answerFull = String(run?.result?.answer ?? '');
      const capRaw = Number(args.max_chars);
      const cap = Number.isFinite(capRaw) && capRaw > 0 ? Math.floor(capRaw) : 0;
      const truncated = cap > 0 && answerFull.length > cap;
      if (run) {
        meta.push('');
        meta.push(
          L(`回合 ${run.run_id}: 状态=${run.status}`, `Run ${run.run_id}: status=${run.status}`) +
            (runSource === 'sentinel'
              ? L('（来自哨兵文件；内存记录已过期或服务重启过）', ' (from the sentinel file; the in-memory record expired or the server restarted)')
              : '') +
            (run.elapsed_ms != null ? L(` 耗时=${(run.elapsed_ms / 1000).toFixed(1)}s`, ` elapsed=${(run.elapsed_ms / 1000).toFixed(1)}s`) : '') +
            (run.status === 'running' ? L('（还在跑，可继续用 dsh_read 看输出）', ' (still running; follow the output with dsh_read)') : ''),
        );
        if (run.prompt_preview) meta.push(L(`  指令: ${run.prompt_preview}`, `  Prompt: ${run.prompt_preview}`));
        if (run.result?.answer) {
          if (truncated) {
            meta.push(L(`  最终答复（已截断，共 ${answerFull.length} 字）:`, `  Final answer (truncated; ${answerFull.length} chars in total):`));
            meta.push(answerFull.slice(0, cap));
            meta.push(L(
              `  …（余下 ${answerFull.length - cap} 字；max_chars=0 取全文）`,
              `  … (${answerFull.length - cap} more chars; max_chars=0 returns the full text)`,
            ));
          } else {
            meta.push(L('  最终答复:', '  Final answer:'));
            meta.push(answerFull);
          }
        }
        if (run.result?.thinking_stats?.chars) {
          meta.push(L(`  （思考 ${run.result.thinking_stats.chars} 字已隐藏）`, `  (${run.result.thinking_stats.chars} chars of reasoning hidden)`));
        }
        if (run.result?.error) meta.push(L(`  ⚠️ 失败: ${run.result.error}`, `  ⚠️ Failed: ${run.result.error}`));
        const review = run.review ?? run.result?.review;
        if (review) {
          meta.push('');
          meta.push(renderReviewSection(review));
        }
      }
      const sentinelFile = run ? hub.runSentinelPath(args.conversation_id, run.run_id) : null;
      const runView = run
        ? {
            run_id: run.run_id,
            client_run_id: run.client_run_id ?? null,
            source: runSource,
            status: run.status,
            started_at: run.started_at ? new Date(run.started_at).toISOString() : null,
            ended_at: run.ended_at ? new Date(run.ended_at).toISOString() : null,
            elapsed_ms: run.elapsed_ms,
            prompt_preview: run.prompt_preview,
            answer_chars: answerFull.length,
            answer_truncated: truncated,
            next_offset: truncated ? cap : null,
            review: run.review ?? run.result?.review ?? null,
            result: cap > 0 ? compactResultForBudget(run.result, cap) : run.result,
            ...(cap > 0 ? { result_compacted: true } : {}),
          }
        : null;
      if (sentinelFile) {
        meta.push(L(`\n哨兵文件: ${sentinelFile}`, `\nSentinel file: ${sentinelFile}`));
        if (cap > 0) {
          meta.push(L(
            '（max_chars 已同时压缩 structured：正文截断、工具输入只留长度；完整结果读这个文件）',
            '(max_chars also compacted the structured output: the answer is cut and tool inputs keep only their length; read this file for the complete result)',
          ));
        }
      }
      return {
        structured: {
          ...snap,
          run: runView,
          ...(sentinelFile
            ? { sentinel_file: sentinelFile, sentinel_file_posix: toPosixPath(sentinelFile) }
            : {}),
        },
        text: meta.join('\n'),
      };
    },

    async dsh_review(args) {
      const conv = await hub.get(args.conversation_id);
      const r = conv.submitReview(args.run_id, {
        verdict: args.verdict,
        notes: args.notes,
        findings: args.findings,
      });
      audit('review', {
        conversation_id: conv.id,
        run_id: args.run_id,
        verdict: args.verdict,
      });
      const lines = [
        L(`审核已记录：${r.run_id} → ${r.status}（${r.review_id}）`, `Review recorded: ${r.run_id} → ${r.status} (${r.review_id})`),
        r.notes ? L(`理由: ${r.notes}`, `Reason: ${r.notes}`) : L('理由: (未填写)', 'Reason: (none given)'),
      ];
      if (Array.isArray(r.findings) && r.findings.length) {
        lines.push(L('问题:', 'Findings:'));
        for (const f of r.findings) lines.push(`  - ${f}`);
      }
      lines.push(L(`审核记录: ${r.review_file}`, `Review record: ${r.review_file}`));
      lines.push(L(
        '审核只记录裁决，不会自动回灌给 DSH；需要修复请用 dsh_send 再派活。',
        'A review only records the verdict; it is not fed back to DSH. Dispatch again with dsh_send if something needs fixing.',
      ));
      return { structured: r, text: lines.join('\n') };
    },

    async dsh_interject(args) {
      if (typeof args.message !== 'string' || args.message.trim() === '') {
        throw new Error(L('message 不能为空：至少包含一个非空白字符', 'message must not be empty: it needs at least one non-whitespace character'));
      }
      const conv = await hub.get(args.conversation_id);
      if (args.client_run_id) {
        if (String(args.client_run_id).length > 128) throw new Error(L('client_run_id 最长 128 字符', 'client_run_id may be at most 128 characters'));
        const existing = conv.getRunByClientId(args.client_run_id);
        if (existing) {
          audit('interject_replay', {
            conversation_id: conv.id,
            run_id: existing.run_id,
            client_run_id: args.client_run_id,
          });
          return replayRun(hub, conv, existing, true);
        }
      }
      const opts = {
        mode: args.mode ?? 'interject',
        reasoning: args.reasoning ?? DEFAULT_REASONING,
        clientRunId: args.client_run_id ?? null,
      };
      if (args.review !== undefined) opts.review = normalizeReviewMode(args.review, conv.review);
      if (args.timeout_ms !== undefined && args.timeout_ms !== null) opts.timeoutMs = parseTimeoutMs(args.timeout_ms);
      const r = await conv.interject(args.message, opts);
      conv.lastResult = r;
      audit('interject', {
        conversation_id: conv.id,
        run_id: r?.run_id ?? null,
        mode: r?.interjected ?? opts.mode,
        client_run_id: args.client_run_id ?? null,
      });
      const waitedSec = (r.waited_ms / 1000).toFixed(1);
      const head =
        r.interjected === 'idle'
          ? L('会话当时空闲，已按普通回合执行。', 'The conversation was idle, so this ran as an ordinary turn.')
          : r.interjected === 'queue'
            ? L(
                `已排队：等了 ${waitedSec}s 让上一轮跑完，然后说了这句。`,
                `Queued: waited ${waitedSec}s for the previous turn to finish, then said this.`,
              )
            : L(
                `已打断上一轮，改口说了这句（上一轮耗时 ${waitedSec}s 处被打断）。`,
                `Stopped the previous turn and said this instead (it took ${waitedSec}s to stop).`,
              );
      // 插话这一轮同样会写哨兵（"一个回合 = 一个哨兵"），把路径一并交回，
      // 调用方就能用同一套"等文件出现"的逻辑收活 —— 之前这里没有哨兵，等待方会空等。
      const sentinel = r?.run_id ? hub.runSentinelPath(conv.id, r.run_id) : null;
      return {
        structured: sentinel ? { ...r, sentinel_file: sentinel, sentinel_file_posix: toPosixPath(sentinel) } : r,
        text:
          `${head}\n\n${renderSendResult(r)}` +
          (sentinel
            ? L(
                `\n\n完成通知文件（本轮结束时原子写出，含最终结果）：\n`,
                `\n\nCompletion file (written atomically when this turn ends, with the final result):\n`,
              ) + `  ${sentinel}\n  ${toPosixPath(sentinel)}`
            : ''),
      };
    },

    async dsh_interrupt(args) {
      const conv = await hub.get(args.conversation_id);
      const r = await conv.interrupt();
      audit('interrupt', { conversation_id: conv.id, interrupted: Boolean(r.interrupted) });
      return {
        structured: r,
        text: r.interrupted ? L('已发送中断请求。', 'Interrupt request sent.') : L(`未中断：${r.reason}`, `Not interrupted: ${r.reason}`),
      };
    },

    async dsh_release(args) {
      // ★ all=true：一次性放掉所有活着的会话进程（腾内存）。
      //   无损：会话日志都在磁盘上，之后照样 resume。
      if (args.all === true) {
        const r = await hub.releaseAll({ force: args.force === true });
        audit('release_all', { released: r.released, failed: r.failed.length, skipped_busy: r.skipped_busy.length });
        return {
          structured: { released: r.released, conversations: r.conversations, skipped_busy: r.skipped_busy, failed: r.failed },
          text:
            L(
              `已释放 ${r.released} 个空闲会话进程（写锁让出，内存回收）。`,
              `Released ${r.released} idle conversation processes (write locks freed, memory reclaimed).`,
            ) +
            (r.skipped_busy.length
              ? L(
                  `\n跳过 ${r.skipped_busy.length} 个正在跑回合的会话；要连它们一起停掉请传 force=true。`,
                  `\nSkipped ${r.skipped_busy.length} conversations that are running a turn; pass force=true to stop those too.`,
                )
              : '') +
            (r.failed.length
              ? L(
                  `\n⚠️ ${r.failed.length} 个会话的进程未确认退出，写锁登记已保留；可稍后用 dsh_status/dsh_takeover 处理。`,
                  `\n⚠️ ${r.failed.length} conversations' processes were not confirmed to have exited, so their lock registrations were kept; handle them later with dsh_status / dsh_takeover.`,
                )
              : '') +
            L(
              `\n会话日志都在磁盘上，之后派活会自动 resume；没有一个可释放时 released=0。`,
              `\nSession logs are on disk, so a later dispatch resumes them; released=0 means nothing was releasable.`,
            ),
        };
      }
      const conv = await hub.get(args.conversation_id);
      const r = await conv.close({ forget: args.forget === true });
      audit('release', {
        conversation_id: conv.id,
        forgotten: Boolean(r.forgotten),
        deleted: Boolean(r.deleted),
      });
      return {
        structured: { conversation_id: args.conversation_id, ...r },
        text: r.forgotten
          ? L('已释放进程并从注册表移除。会话日志仍在磁盘上。', 'Process released and the conversation removed from the registry. The session log is still on disk.') +
            (r.worktree?.removed
              ? L(`\nworktree 已删除（${r.worktree.path}）；分支 ${r.worktree.branch} 保留。`, `\nWorktree deleted (${r.worktree.path}); branch ${r.worktree.branch} kept.`)
              : r.worktree?.reason === 'dirty'
                ? L(
                    `\n⚠️ worktree 里有未提交的改动，已保留：${r.worktree.path}（分支 ${r.worktree.branch}）。处理完后可用 git worktree remove 删除。`,
                    `\n⚠️ The worktree has uncommitted changes and was kept: ${r.worktree.path} (branch ${r.worktree.branch}). Remove it with git worktree remove when done.`,
                  )
                : r.worktree && r.worktree.reason !== 'missing'
                  ? L(`\n⚠️ worktree 未删除（${r.worktree.reason}）：${r.worktree.path}`, `\n⚠️ Worktree not deleted (${r.worktree.reason}): ${r.worktree.path}`)
                  : '')
          : args.forget === true
            ? L(`⚠️ forget 未完成：${r.error ?? '原因未知'}`, `⚠️ forget did not complete: ${r.error ?? 'unknown reason'}`)
            : L(
                '已释放 DSH 进程（写锁已让出，你可以在自己的 DSH GUI 里打开这个会话）。会话仍可 resume。',
                'DSH process released (the write lock is free, so you can open this conversation in your own DSH GUI). It can still be resumed.',
              ),
      };
    },

    async dsh_takeover(args) {
      const conv = await hub.get(args.conversation_id);
      const r = await conv.takeover({ force: args.force === true });
      audit('takeover', { conversation_id: conv.id, ok: Boolean(r.ok), forced: args.force === true });
      return { structured: r, text: `${r.ok ? '✅' : '❌'} ${r.message}` };
    },

    async dsh_approval_decide(args) {
      const conv = await hub.get(args.conversation_id);
      const r = conv.decideApproval(args.approval_id, args.decision);
      audit('approval_decide', {
        conversation_id: conv.id,
        approval_id: r.approval_id,
        decision: r.decision,
        effective: r.effective,
      });
      // ★ 只有 effective=selected 才是真的把决定送达了 DSH。
      //   没有对应 option 时 ACP 收到的是 cancelled，绝不能渲染成"已裁决为 allow"。
      const ok = r.effective === 'selected';
      return {
        structured: r,
        text: ok
          ? L(`审批 ${r.approval_id} 已裁决为 ${r.decision}。`, `Approval ${r.approval_id} decided: ${r.decision}.`)
          : L(
              `审批 ${r.approval_id} 未生效：DSH 没有提供 ${r.decision} 对应的选项，已按取消处理（effective=cancelled）。`,
              `Approval ${r.approval_id} did not take effect: DSH offered no option matching ${r.decision}, so it was treated as cancelled (effective=cancelled).`,
            ),
      };
    },

    async dsh_status(args) {
      const conv = await hub.get(args.conversation_id);
      const snap = conv.snapshot();
      const run = conv.getRun();
      const review = run ? (run.review ?? run.result?.review ?? null) : null;
      const bits = [L(`状态=${snap.state}`, `state=${snap.state}`), L(`轮数=${snap.turns}`, `turns=${snap.turns}`)];
      if (snap.state === 'running') {
        const sec = ((snap.running_ms ?? 0) / 1000).toFixed(1);
        bits.push(L(`已跑=${sec}s`, `running for=${sec}s`));
        if (snap.current_tool) bits.push(L(`当前工具=${snap.current_tool}`, `current tool=${snap.current_tool}`));
        bits.push(L(`本轮输出=${snap.out_chars ?? 0}字`, `output this turn=${snap.out_chars ?? 0} chars`));
        if (snap.since_progress_ms != null) {
          const q = (snap.since_progress_ms / 1000).toFixed(0);
          bits.push(L(`距上次进展=${q}s`, `since last progress=${q}s`));
        }
      }
      if (run) bits.push(L(`最近回合=${run.run_id}(${run.status})`, `latest run=${run.run_id}(${run.status})`));
      if (review) {
        bits.push(
          L('审核=', 'review=') + `${review.status}${review.verdict ? `(${review.verdict})` : ''}` +
            (review.status === 'pending' ? L('（待提交）', ' (not submitted yet)') : ''),
        );
      }
      bits.push(L(`待决审批=${snap.pending_approvals.length}`, `pending approvals=${snap.pending_approvals.length}`));
      if (snap.rss_mb != null) bits.push(`rss=${snap.rss_mb}MB`);
      if (snap.keep_alive) bits.push(L('保活=是', 'keep-alive=yes'));
      if (snap.queue_length) bits.push(L(`队列=${snap.queue_length}`, `queue=${snap.queue_length}`));
      // 写锁在谁手上：区分"自己握着"和"被别人占着"，后者直接给出可执行动作
      if (snap.lock_holder && snap.lock_holder !== 'self') {
        const hint =
          snap.lock_holder === 'stale-mcp'
            ? L('（本服务残留/卡死的持有者，可 dsh_takeover 抢占）', " (a leftover or wedged holder of this server's own; take it over with dsh_takeover)")
            : snap.lock_holder === 'live-mcp'
              ? L(
                  '（另一个活着的 dsh-any-agent 实例在用；要夺需 dsh_takeover(force=true)）',
                  ' (another live dsh-any-agent instance is using it; taking it needs dsh_takeover(force=true))',
                )
              : snap.lock_conflict
                ? L(
                    '（最近撞过锁：多半是你自己的 DSH GUI 正开着它；本服务不会去杀它）',
                    ' (a recent lock conflict: most likely your own DSH GUI has it open; this server will not kill it)',
                  )
                : L(
                    '（没有本服务的持锁登记；空闲/已释放时也会是 none，只有在撞锁时才可能是 GUI）',
                    ' (no lock registration by this server; idle or released conversations also show none, and it only points at the GUI after a lock conflict)',
                  );
        bits.push(L(`写锁=${snap.lock_holder}`, `write lock=${snap.lock_holder}`) + hint);
        if (snap.lock_holder_reason) bits.push(L(`   判定：${snap.lock_holder_reason}`, `   why: ${snap.lock_holder_reason}`));
      }
      // ★ 撞过锁就把"谁占用 + 怎么解"讲清楚。实测：GUI 点开一次就会长期持有写锁
      //   （切走、等十几分钟都不释放），所以这条信息必须持久可见，而不是一闪而过的报错。
      if (snap.lock_conflict) {
        const lc = snap.lock_conflict;
        const ago = Math.round((Date.now() - lc.at) / 1000);
        bits.push(L(`⚠️ 最近一次撞锁：${ago}s 前，持有者=${lc.holder_kind}`, `⚠️ Latest lock conflict: ${ago}s ago, holder=${lc.holder_kind}`));
        bits.push(L(`   判定：${lc.reason}`, `   why: ${lc.reason}`));
        bits.push(L(`   怎么办：${lc.hint}`, `   what to do: ${lc.hint}`));
      }
      return {
        structured: {
          conversation_id: snap.conversation_id,
          state: snap.state,
          alive: snap.alive,
          busy: snap.busy,
          current_tool: snap.current_tool,
          out_chars: snap.out_chars,
          running_ms: snap.running_ms,
          since_progress_ms: snap.since_progress_ms,
          pending_approvals: snap.pending_approvals,
          pending_approval_details: snap.pending_approval_details,
          turns: snap.turns,
          rss_mb: snap.rss_mb,
          keep_alive: snap.keep_alive,
          queue_length: snap.queue_length,
          lock_holder: snap.lock_holder,
          lock_holder_reason: snap.lock_holder_reason,
          lock_conflict: snap.lock_conflict,
          review: review
            ? { review_id: review.review_id, status: review.status, verdict: review.verdict ?? null }
            : null,
          run: run
            ? {
                run_id: run.run_id,
                status: run.status,
                elapsed_ms: run.elapsed_ms,
                stop_reason: run.result?.stop_reason ?? null,
                error: run.result?.error ?? run.error ?? null,
              }
            : null,
        },
        text: bits.join(' | '),
      };
    },

    async dsh_inbox(args) {
      const convs = args.conversation_id
        ? [await hub.get(args.conversation_id)]
        : [...hub.conversations.values()];
      const items = [];
      for (const conv of convs) {
        const snap = conv.snapshot();
        for (const d of snap.pending_approval_details ?? []) {
          items.push({
            conversation_id: snap.conversation_id,
            title: snap.title ?? null,
            cwd: snap.cwd,
            approval_id: d.approval_id,
            tool: d.tool ?? null,
            reason: d.reason ?? d.description ?? null,
            created_at: d.created_at ?? null,
            age_ms: d.created_at ? Date.now() - d.created_at : null,
            options: (d.options ?? []).map((o) => ({
              option_id: o.optionId,
              kind: o.kind,
              name: o.name,
            })),
            ...(args.include_input === false ? {} : { input: d.input ?? null }),
          });
        }
      }
      items.sort((a, b) => (a.created_at ?? 0) - (b.created_at ?? 0));
      const lines = items.map(
        (i) =>
          `- [${i.conversation_id}] ${i.title ?? L('(无标题)', '(untitled)')} | ${i.approval_id} | ${i.tool ?? '?'} | ` +
          `${i.reason ?? ''} | ${L('等待', 'waiting')}=${i.age_ms == null ? '?' : `${Math.round(i.age_ms / 1000)}s`}`,
      );
      return {
        structured: { count: items.length, approvals: items },
        text: items.length
          ? L(`${items.length} 个待决审批：\n`, `${items.length} pending approvals:\n`) + `${lines.join('\n')}\n\n` +
            L('裁决：', 'Decide: ') + `dsh_approval_decide(conversation_id, approval_id, decision)`
          : L('(没有待决审批)', '(no pending approvals)'),
      };
    },

    async dsh_queue(args) {
      const conv = await hub.get(args.conversation_id);
      switch (args.action) {
        case 'list': {
          const items = conv.queueList();
          return {
            structured: { count: items.length, queue: items },
            text: items.length
              ? L(`${items.length} 条排队：\n`, `${items.length} queued:\n`) +
                items.map((i) => `- #${i.position} ${i.run_id} | ${i.preview}`).join('\n')
              : L('(队列为空)', '(the queue is empty)'),
          };
        }
        case 'remove': {
          if (!args.run_id) throw new Error(L('remove 需要 run_id', 'remove needs run_id'));
          const r = conv.queueRemove(args.run_id);
          audit('queue_remove', { conversation_id: conv.id, run_id: args.run_id });
          return {
            structured: r,
            text: L(
              `已从队列移除 ${args.run_id}（已写 cancelled 哨兵，等待方不会空等）`,
              `Removed ${args.run_id} from the queue (a cancelled sentinel was written, so a waiter is not left hanging)`,
            ),
          };
        }
        case 'update': {
          if (!args.run_id) throw new Error(L('update 需要 run_id', 'update needs run_id'));
          if (typeof args.text !== 'string' || args.text.trim() === '') {
            throw new Error(L('update 需要非空 text', 'update needs a non-empty text'));
          }
          const r = conv.queueUpdate(args.run_id, args.text);
          audit('queue_update', { conversation_id: conv.id, run_id: args.run_id });
          return { structured: r, text: L(`已更新 ${args.run_id} 的排队文本`, `Updated the queued text of ${args.run_id}`) };
        }
        case 'promote': {
          if (!args.run_id) throw new Error(L('promote 需要 run_id', 'promote needs run_id'));
          const r = conv.queuePromote(args.run_id);
          audit('queue_promote', { conversation_id: conv.id, run_id: args.run_id });
          return { structured: r, text: L(`已把 ${args.run_id} 提到队首`, `Moved ${args.run_id} to the front of the queue`) };
        }
        default:
          throw new Error(L(`未知 action: ${args.action}`, `Unknown action: ${args.action}`));
      }
    },

    async dsh_doctor() {
      return runDoctor(hub);
    },
  };
}