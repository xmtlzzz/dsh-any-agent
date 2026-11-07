/**
 * 工具定义与实现。
 *
 * 抽象单位是"会话 + 任务"，不是"命令"——不把 DSH 自己的文件/命令工具 1:1 代理出去，
 * 因为调用方 agent 已经有那些工具了。
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_PERMISSION,
  DEFAULT_REASONING,
  IDLE_TTL_MS,
  MAX_LIVE,
  MAX_RSS_MB,
  REVIEWS_DIR,
  RUNS_DIR,
  SHARED_PROCESS,
  STATE_FILE,
  TEAM_ACTIVE,
  TEAM_MODE,
  DSH_PROFILE,
  toPosixPath,
  dshVersionStatus,
} from './config.mjs';
import {
  SOURCE_LABEL,
  discoverDsh,
  isNpxCachePath,
  probeRuntimeNode,
  resolveDsh,
  satisfiesNodeRange,
} from './dsh-locate.mjs';
import { inspectProfile } from './bootstrap.mjs';
import { audit } from './audit.mjs';
import { listOrphans, LOCKS_DIR } from './locks.mjs';
import { rssMb } from './procstat.mjs';
import { normalizeReviewMode } from './review.mjs';
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
  if (!Number.isFinite(n) || n < 0) throw new Error('timeout_ms 必须是 >= 0 的有限数字');
  return n;
}

/**
 * 团队模式下注入到派发 prompt 前的一句策略。
 * 只描述"需要时怎么做"，不改变任务本身；简单任务不会因此组队。
 */
const TEAM_PREFIX =
  '【团队】如果这个任务需要并行或多角色协作，先用 spawn_teammate 创建团队再执行；' +
  '不需要就单 agent 完成。不要为简单任务组队。\n\n';

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
      });
      if (args.title_hint) conv.titleHint = args.title_hint;
      audit('start', {
        conversation_id: conv.id,
        permission: conv.permission,
        keep_alive: conv.keepAlive === true,
      });
      const snap = conv.snapshot();
      const lines = [
        '已创建会话。',
        `conversation_id: ${snap.conversation_id}`,
        `工作区: ${snap.cwd}` + (cwdSource === 'client-root' ? '（取自客户端当前打开的项目）' : ''),
        `权限档: ${snap.permission}（审批策略 ${snap.on_approval}）`,
        `思考深度: ${snap.reasoning_effort}`,
        snap.keep_alive
          ? '保活: 是（不受空闲 TTL / MAX_LIVE 回收；用完请 dsh_release）'
          : '保活: 否（空闲后可被回收，下次派活自动 resume）',
        `团队模式: ${
          TEAM_ACTIVE
            ? `开（profile=${DSH_PROFILE}；派发时会提示"需要时先建团队"，简单任务不会组队）`
            : '关（默认关闭；需要时运行 dsh-any-agent team on）'
        }`,
        `对话名: ${snap.title ?? '(DSH 尚未生成，发出第一条消息后自动生成)'}` +
        (snap.title_hint && snap.title !== snap.title_hint ? `（你给的标题提示: ${snap.title_hint}）` : ''),
        `工作区登记: ${snap.workspace_registered ? '已写入 DSH 工作区注册表（GUI 里能看到）' : '未登记'}`,
      ];
      if (snap.config_failed?.length) {
        lines.push(`⚠️ 配置未完全套用: ${snap.config_failed.join('; ')}`);
        if (snap.config_failed.some((f) => String(f).startsWith('模型='))) {
          lines.push(
            '⚠️ 指定的 provider/model 无效：本会话已回退到 profile 默认模型，' +
              '后续回合**不会**使用你指定的模型。',
          );
        }
      }
      return { structured: snap, text: lines.join('\n') };
    },

    async dsh_send(args) {
      // 空/纯空白 prompt 会被 DSH 以 [-32602] 拒绝；默认 wait=false 下那会变成
      // 一个“accepted 但注定失败”的收据（错误只异步出现在哨兵里）。这里同步拦下。
      if (typeof args.prompt !== 'string' || args.prompt.trim() === '') {
        throw new Error('prompt 不能为空：至少包含一个非空白字符');
      }
      const conv = await hub.get(args.conversation_id);
      const review = args.review === undefined ? undefined : normalizeReviewMode(args.review, conv.review);
      const opts = { reasoning: args.reasoning ?? DEFAULT_REASONING };
      if (review !== undefined) opts.review = review;
      if (args.timeout_ms !== undefined && args.timeout_ms !== null) opts.timeoutMs = parseTimeoutMs(args.timeout_ms);

      // ── 幂等：同一个 client_run_id 直接返回首次的 run，不重复执行 ──
      if (args.client_run_id) {
        if (String(args.client_run_id).length > 128) throw new Error('client_run_id 最长 128 字符');
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
        throw new Error(
          '会话正在跑另一个回合，无法再排一个。可以：dsh_interject（插话）、dsh_interrupt（打断）后重试，' +
            '或 dsh_send(queue=true) 入队。',
        );
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
        const bits = [`${c.title ?? '(无标题)'}`, `id=${c.conversation_id}`];
        if (c.state === 'running') {
          const extra = [
            `已跑${((c.running_ms ?? 0) / 1000).toFixed(0)}s`,
            c.current_tool ? `工具=${c.current_tool}` : null,
            c.out_chars ? `本轮输出=${c.out_chars}字` : null,
          ].filter(Boolean);
          bits.push(`🔵进行中(${extra.join(', ')})`);
        } else if (c.state === 'idle') {
          bits.push('🟢空闲');
        } else {
          bits.push('⚪未打开(可 resume)');
        }
        bits.push(`cwd=${c.cwd}`);
        if (c.permission) bits.push(`权限=${c.permission}`);
        if (c.turns != null) bits.push(`轮数=${c.turns}`);
        if (c.rss_mb != null) bits.push(`rss=${c.rss_mb}MB`);
        if (c.keep_alive) bits.push('保活');
        if (c.queue_length) bits.push(`队列=${c.queue_length}`);
        return `- ${bits.join(' | ')}`;
      };
      const probe = hub.lastProbe ?? { ok: null, error: null, cached: false };
      const probeNote = probe.ok === false
        ? `\n\n⚠️ 磁盘会话探测失败：${probe.error}\n   上面只列出本服务已打开的会话；磁盘上未打开的会话可能没显示。`
        : '';
      const text = items.length
        ? `${items.length} 个会话（其中 ${running} 个正在跑）：\n${items.map(describe).join('\n')}`
        : probe.ok === false ? '(本服务没有已打开的会话；磁盘探测失败)' : '(没有会话)';
      // 孤儿锁持有者：上一代 MCP 崩了但它的 DSH 子进程还活着握着写锁 —— 不主动报出来，
      // 用户只会在下一次撞上"被占用"时才发现。这里顺手提示，并给出可执行的动作。
      const orphans = listOrphans();
      const orphanNote = orphans.length
        ? `\n\n⚠️ 发现 ${orphans.length} 个**孤儿锁持有者**（MCP 已退出、子进程还握着写锁）：\n` +
          orphans.map((o) => `- 会话 ${o.conversation_id}（子进程 PID ${o.child_pid}，已失联 ${o.age_ms === null ? '未知' : Math.round(o.age_ms / 1000) + 's'}）`).join('\n') +
          '\n→ 用 dsh_takeover 抢占即可（这些是本服务自己的残留，抢占是安全的）。'
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
        if (e.kind === 'user') return `[我] ${e.text}`;
        if (e.kind === 'text') return `[DSH] ${e.text}`;
        if (e.kind === 'tool') return `[工具] ${e.text}`;
        if (e.kind === 'turn') return `[轮次] ${e.text}`;
        return `[${e.kind}] ${e.text}`;
      };
      const flags = [
        `状态=${r.state}`,
        r.current_tool ? `正在执行=${r.current_tool}` : null,
        `cursor=${r.cursor}`,
        r.gap ? '⚠️缓冲已覆盖中间一段，去重不保证' : null,
        r.has_more ? '还有更多（继续用新 cursor 拉）' : null,
      ].filter(Boolean);
      const body = r.entries.length ? r.entries.map(render).join('\n') : '(游标之后没有新输出)';
      const think = r.live_thinking ? `\n--- 当前回合实时思考 ---\n${r.live_thinking}` : '';
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
        ? 'DSH 自动生成'
        : snap.title_source === 'title_hint'
          ? '来自 title_hint（DSH 尚未生成标题）'
          : '尚未生成';
      meta.push(`对话名: ${snap.title ?? '(尚未生成)'}（${titleKind}）` +
        (snap.title_hint && snap.title !== snap.title_hint ? ` / 标题提示: ${snap.title_hint}` : ''));
      meta.push(`工作区: ${snap.cwd}`);
      meta.push(`状态: ${snap.busy ? '忙' : snap.alive ? '空闲(进程活着)' : '未打开(可用 resume 复活)'}`);
      meta.push(`权限档: ${snap.permission} / 审批 ${snap.on_approval}`);
      meta.push(`轮数: ${snap.turns}`);
      if (snap.model) meta.push(`模型: ${snap.model.provider}/${snap.model.model}${snap.model.reasoningEffort ? ` (${snap.model.reasoningEffort})` : ''}`);
      if (snap.usage) meta.push(`token: in=${snap.usage.uncachedInputTokens ?? 0} out=${snap.usage.outputTokens ?? 0} cache=${snap.usage.cacheReadTokens ?? 0}`);
      if (snap.context_pressure) meta.push(`上下文压力: ${snap.context_pressure.pressureTokens}/${snap.context_pressure.contextWindow}`);
      if (snap.pending_approvals?.length) meta.push(`待决审批: ${snap.pending_approvals.join(', ')}`);
      if (snap.queue_length) meta.push(`队列: ${snap.queue_length} 条待执行（dsh_queue list）`);
      for (const detail of snap.pending_approval_details ?? []) {
        const summary = [detail.title ?? detail.tool, detail.reason ?? detail.description].filter(Boolean).join(' — ');
        meta.push(`  ${detail.approval_id}: ${summary.slice(0, 300)}（操作输入见 pending_approval_details）`);
      }
      if (args.client_run_id) {
        run = conv.getRunByClientId(args.client_run_id);
        if (!run) {
          throw new Error(
            `未知 client_run_id: ${args.client_run_id}（只在内存里保留最近 20 条；已淘汰/服务重启后请用 run_id 或直接读哨兵文件）`,
          );
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
        throw new Error(
          `未知 run_id: ${args.run_id}（内存只留最近 20 条；哨兵文件 ${hub.runSentinelPath(args.conversation_id, args.run_id)} 也不存在或不可读）`,
        );
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
          `回合 ${run.run_id}: 状态=${run.status}` +
            (runSource === 'sentinel' ? '（来自哨兵文件；内存记录已过期或服务重启过）' : '') +
            (run.elapsed_ms != null ? ` 耗时=${(run.elapsed_ms / 1000).toFixed(1)}s` : '') +
            (run.status === 'running' ? '（还在跑，可继续用 dsh_read 看输出）' : ''),
        );
        if (run.prompt_preview) meta.push(`  指令: ${run.prompt_preview}`);
        if (run.result?.answer) {
          if (truncated) {
            meta.push(`  最终答复（已截断，共 ${answerFull.length} 字）:`);
            meta.push(answerFull.slice(0, cap));
            meta.push(`  …（余下 ${answerFull.length - cap} 字；max_chars=0 取全文）`);
          } else {
            meta.push('  最终答复:');
            meta.push(answerFull);
          }
        }
        if (run.result?.thinking_stats?.chars) {
          meta.push(`  （思考 ${run.result.thinking_stats.chars} 字已隐藏）`);
        }
        if (run.result?.error) meta.push(`  ⚠️ 失败: ${run.result.error}`);
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
        meta.push(`\n哨兵文件: ${sentinelFile}`);
        if (cap > 0) meta.push('（max_chars 已同时压缩 structured：正文截断、工具输入只留长度；完整结果读这个文件）');
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
        `审核已记录：${r.run_id} → ${r.status}（${r.review_id}）`,
        r.notes ? `理由: ${r.notes}` : '理由: (未填写)',
      ];
      if (Array.isArray(r.findings) && r.findings.length) {
        lines.push('问题:');
        for (const f of r.findings) lines.push(`  - ${f}`);
      }
      lines.push(`审核记录: ${r.review_file}`);
      lines.push('审核只记录裁决，不会自动回灌给 DSH；需要修复请用 dsh_send 再派活。');
      return { structured: r, text: lines.join('\n') };
    },

    async dsh_interject(args) {
      if (typeof args.message !== 'string' || args.message.trim() === '') {
        throw new Error('message 不能为空：至少包含一个非空白字符');
      }
      const conv = await hub.get(args.conversation_id);
      if (args.client_run_id) {
        if (String(args.client_run_id).length > 128) throw new Error('client_run_id 最长 128 字符');
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
      const head =
        r.interjected === 'idle'
          ? '会话当时空闲，已按普通回合执行。'
          : r.interjected === 'queue'
            ? `已排队：等了 ${(r.waited_ms / 1000).toFixed(1)}s 让上一轮跑完，然后说了这句。`
            : `已打断上一轮，改口说了这句（上一轮耗时 ${(r.waited_ms / 1000).toFixed(1)}s 处被打断）。`;
      // 插话这一轮同样会写哨兵（"一个回合 = 一个哨兵"），把路径一并交回，
      // 调用方就能用同一套"等文件出现"的逻辑收活 —— 之前这里没有哨兵，等待方会空等。
      const sentinel = r?.run_id ? hub.runSentinelPath(conv.id, r.run_id) : null;
      return {
        structured: sentinel ? { ...r, sentinel_file: sentinel, sentinel_file_posix: toPosixPath(sentinel) } : r,
        text:
          `${head}\n\n${renderSendResult(r)}` +
          (sentinel
            ? `\n\n完成通知文件（本轮结束时原子写出，含最终结果）：\n  ${sentinel}\n  ${toPosixPath(sentinel)}`
            : ''),
      };
    },

    async dsh_interrupt(args) {
      const conv = await hub.get(args.conversation_id);
      const r = await conv.interrupt();
      audit('interrupt', { conversation_id: conv.id, interrupted: Boolean(r.interrupted) });
      return { structured: r, text: r.interrupted ? '已发送中断请求。' : `未中断：${r.reason}` };
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
            `已释放 ${r.released} 个空闲会话进程（写锁让出，内存回收）。` +
            (r.skipped_busy.length
              ? `\n跳过 ${r.skipped_busy.length} 个正在跑回合的会话；要连它们一起停掉请传 force=true。`
              : '') +
            (r.failed.length
              ? `\n⚠️ ${r.failed.length} 个会话的进程未确认退出，写锁登记已保留；可稍后用 dsh_status/dsh_takeover 处理。`
              : '') +
            `\n会话日志都在磁盘上，之后派活会自动 resume；没有一个可释放时 released=0。`,
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
          ? '已释放进程并从注册表移除。会话日志仍在磁盘上。'
          : '已释放 DSH 进程（写锁已让出，你可以在自己的 DSH GUI 里打开这个会话）。会话仍可 resume。',
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
          ? `审批 ${r.approval_id} 已裁决为 ${r.decision}。`
          : `审批 ${r.approval_id} 未生效：DSH 没有提供 ${r.decision} 对应的选项，已按取消处理（effective=cancelled）。`,
      };
    },

    async dsh_status(args) {
      const conv = await hub.get(args.conversation_id);
      const snap = conv.snapshot();
      const run = conv.getRun();
      const review = run ? (run.review ?? run.result?.review ?? null) : null;
      const bits = [`状态=${snap.state}`, `轮数=${snap.turns}`];
      if (snap.state === 'running') {
        bits.push(`已跑=${((snap.running_ms ?? 0) / 1000).toFixed(1)}s`);
        if (snap.current_tool) bits.push(`当前工具=${snap.current_tool}`);
        bits.push(`本轮输出=${snap.out_chars ?? 0}字`);
      }
      if (run) bits.push(`最近回合=${run.run_id}(${run.status})`);
      if (review) {
        bits.push(`审核=${review.status}${review.verdict ? `(${review.verdict})` : ''}${review.status === 'pending' ? '（待提交）' : ''}`);
      }
      bits.push(`待决审批=${snap.pending_approvals.length}`);
      if (snap.rss_mb != null) bits.push(`rss=${snap.rss_mb}MB`);
      if (snap.keep_alive) bits.push('保活=是');
      if (snap.queue_length) bits.push(`队列=${snap.queue_length}`);
      // 写锁在谁手上：区分"自己握着"和"被别人占着"，后者直接给出可执行动作
      if (snap.lock_holder && snap.lock_holder !== 'self') {
        const hint =
          snap.lock_holder === 'stale-mcp'
            ? '（本服务残留/卡死的持有者，可 dsh_takeover 抢占）'
            : snap.lock_holder === 'live-mcp'
              ? '（另一个活着的 dsh-any-agent 实例在用；要夺需 dsh_takeover(force=true)）'
              : snap.lock_conflict
                ? '（最近撞过锁：多半是你自己的 DSH GUI 正开着它；本服务不会去杀它）'
                : '（没有本服务的持锁登记；空闲/已释放时也会是 none，只有在撞锁时才可能是 GUI）';
        bits.push(`写锁=${snap.lock_holder}${hint}`);
        if (snap.lock_holder_reason) bits.push(`   判定：${snap.lock_holder_reason}`);
      }
      // ★ 撞过锁就把"谁占用 + 怎么解"讲清楚。实测：GUI 点开一次就会长期持有写锁
      //   （切走、等十几分钟都不释放），所以这条信息必须持久可见，而不是一闪而过的报错。
      if (snap.lock_conflict) {
        const lc = snap.lock_conflict;
        const ago = Math.round((Date.now() - lc.at) / 1000);
        bits.push(`⚠️ 最近一次撞锁：${ago}s 前，持有者=${lc.holder_kind}`);
        bits.push(`   判定：${lc.reason}`);
        bits.push(`   怎么办：${lc.hint}`);
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
          `- [${i.conversation_id}] ${i.title ?? '(无标题)'} | ${i.approval_id} | ${i.tool ?? '?'} | ` +
          `${i.reason ?? ''} | 等待=${i.age_ms == null ? '?' : `${Math.round(i.age_ms / 1000)}s`}`,
      );
      return {
        structured: { count: items.length, approvals: items },
        text: items.length
          ? `${items.length} 个待决审批：\n${lines.join('\n')}\n\n` +
            `裁决：dsh_approval_decide(conversation_id, approval_id, decision)`
          : '(没有待决审批)',
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
              ? `${items.length} 条排队：\n` +
                items.map((i) => `- #${i.position} ${i.run_id} | ${i.preview}`).join('\n')
              : '(队列为空)',
          };
        }
        case 'remove': {
          if (!args.run_id) throw new Error('remove 需要 run_id');
          const r = conv.queueRemove(args.run_id);
          audit('queue_remove', { conversation_id: conv.id, run_id: args.run_id });
          return {
            structured: r,
            text: `已从队列移除 ${args.run_id}（已写 cancelled 哨兵，等待方不会空等）`,
          };
        }
        case 'update': {
          if (!args.run_id) throw new Error('update 需要 run_id');
          if (typeof args.text !== 'string' || args.text.trim() === '') {
            throw new Error('update 需要非空 text');
          }
          const r = conv.queueUpdate(args.run_id, args.text);
          audit('queue_update', { conversation_id: conv.id, run_id: args.run_id });
          return { structured: r, text: `已更新 ${args.run_id} 的排队文本` };
        }
        case 'promote': {
          if (!args.run_id) throw new Error('promote 需要 run_id');
          const r = conv.queuePromote(args.run_id);
          audit('queue_promote', { conversation_id: conv.id, run_id: args.run_id });
          return { structured: r, text: `已把 ${args.run_id} 提到队首` };
        }
        default:
          throw new Error(`未知 action: ${args.action}`);
      }
    },

    async dsh_doctor() {
      const checks = [];
      const add = (id, status, detail, fix = null) => checks.push({ id, status, detail, fix });

      try {
        // 体检总是重新探测（不吃 60 秒缓存）：用户刚装/升级完桌面版就来查，必须看到新结果。
        const all = discoverDsh({ fresh: true });
        const dsh = resolveDsh();
        const { bin, version } = dsh;
        const fromNpx = isNpxCachePath(bin);
        add(
          'dsh_bin',
          fromNpx ? 'warn' : 'ok',
          `${bin}${version ? ` (DSH ${version})` : ''}；来源=${SOURCE_LABEL[dsh.source] ?? dsh.source}` +
            `；运行时=${dsh.runtime === 'node' ? `node ${process.versions.node}` : dsh.command}` +
            (fromNpx ? ' —— 位于 npx 缓存，清缓存后会失效' : ''),
          fromNpx
            ? '安装 DeepSeek Harness 桌面版（会被自动识别），或 npm i -g @deepseek-ai/dsh'
            : null,
        );

        // DSH 的 engines.node 与实际拉起它的运行时是否匹配（0.2.2 起要求 Node >= 24.9）。
        const runtimeNode = probeRuntimeNode(dsh);
        const engOk = satisfiesNodeRange(dsh.enginesNode, runtimeNode);
        add(
          'dsh_runtime',
          engOk === false ? 'warn' : 'ok',
          `运行时 Node ${runtimeNode ?? '未知'}，DSH 要求 ${dsh.enginesNode ?? '未声明'}` +
            (engOk === false ? ' —— 不满足，部分能力可能异常' : ''),
          engOk === false
            ? dsh.runtime === 'node'
              ? '安装桌面版（自带满足要求的运行时，会被优先选用），或升级本机 Node，或用 DSH_RUNTIME 指定一个满足要求的 node'
              : '更新桌面版，或用 DSH_RUNTIME 指定一个满足要求的 node'
            : null,
        );

        // GUI（桌面版）与本服务是不是同一份 DSH：两边共用 ~/.dsh 会话存储。
        const desktops = all.filter((c) => c.source === 'desktop');
        if (desktops.length === 0) {
          add('dsh_desktop', 'ok', '未发现 DeepSeek Harness 桌面版（不影响使用）');
        } else {
          const gui = desktops[0];
          const same = gui.version === version;
          add(
            'dsh_desktop',
            same ? 'ok' : 'warn',
            `桌面版 ${gui.version ?? '?'}（${gui.installDir}）` +
              (same ? '，与本服务所用 DSH 一致' : `；本服务用的是 ${version ?? '?'}（${SOURCE_LABEL[dsh.source]}）—— 两者共用 ~/.dsh 会话，版本不一致时新版本写的会话可能被旧版本 resume`),
            same ? null : dsh.source === 'env' ? '去掉 DSH_BIN 让服务自动选用桌面版，或把 DSH_BIN 指向同版本' : '升级/统一两边的 DSH 版本',
          );
        }
        if (all.length > 1) {
          add(
            'dsh_candidates',
            'ok',
            all.map((c) => `${SOURCE_LABEL[c.source]} ${c.version ?? '?'}${c === all[0] ? '（自动选用）' : ''}`).join('；'),
          );
        }

        const vs = dshVersionStatus(version);
        add(
          'dsh_version',
          vs.status,
          `${vs.level}: ${vs.note}`,
          vs.status === 'ok'
            ? null
            : vs.level === 'unverified'
              ? '对照 docs/zh/compatibility.md；升级后跑一遍 npm test，必要时 npm run test:all'
              : '升级到 DSH 0.1.7-rc.1 及以上',
        );
      } catch (e) {
        add('dsh_bin', 'fail', e.message, '安装 DeepSeek Harness 桌面版（自动识别），或设置 DSH_BIN 指向 @deepseek-ai/dsh/lib/bin.js');
      }

      try {
        const p = inspectProfile();
        add(
          'profile',
          p.exists ? (p.drifted ? 'warn' : 'ok') : 'warn',
          `${p.dir} exists=${p.exists} managed=${p.managed} drifted=${p.drifted} routes=${p.routes.join(',') || 'none'}`,
          p.exists ? null : '让服务首启自动创建，或运行 dsh-any-agent-setup',
        );
      } catch (e) {
        add('profile', 'fail', e.message);
      }

      try {
        const raw = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
        add(
          'state',
          raw.version === 1 ? 'ok' : 'warn',
          `${STATE_FILE} version=${raw.version} conversations=${raw.conversations?.length ?? 0}`,
        );
      } catch (e) {
        add('state', 'warn', `${STATE_FILE}: ${e.message}`, '首次启动会自动创建');
      }

      for (const [id, dir] of [
        ['runs_dir', RUNS_DIR],
        ['reviews_dir', REVIEWS_DIR],
        ['locks_dir', LOCKS_DIR],
      ]) {
        try {
          mkdirSync(dir, { recursive: true });
          const probe = join(dir, `.doctor-${process.pid}`);
          writeFileSync(probe, '');
          rmSync(probe, { force: true });
          add(id, 'ok', dir);
        } catch (e) {
          add(id, 'fail', `${dir}: ${e.message}`, '检查权限，或用对应环境变量指向可写目录');
        }
      }

      try {
        const orphans = listOrphans();
        add(
          'orphan_locks',
          orphans.length ? 'warn' : 'ok',
          orphans.length ? `${orphans.length} 个孤儿锁持有者（可 dsh_takeover）` : '没有孤儿锁',
        );
      } catch (e) {
        add('orphan_locks', 'warn', e.message);
      }

      const all = [...hub.conversations.values()];
      const alive = all.filter((c) => c.proc?.alive);
      // ★ 共享进程下多个会话共用一个 PID：必须按 PID 去重，否则同一份 RSS 会被按会话
      //   重复累加，"RSS 合计"就会凭空翻几倍，把这行诊断变成误导。
      const livePids = new Set(alive.map((c) => c.proc?.pid).filter(Boolean));
      let totalRss = 0;
      for (const pid of livePids) totalRss += rssMb(pid) ?? 0;
      add(
        'sessions',
        'ok',
        `共 ${all.length} 个会话，活进程 ${livePids.size} 个` +
          (SHARED_PROCESS ? `（共享宿主 ${hub.hosts?.size ?? 0} 个）` : '（一会话一进程）') +
          `，RSS 合计 ${totalRss}MB`,
      );
      add(
        'config',
        'ok',
        `profile=${DSH_PROFILE} team=${TEAM_ACTIVE ? 'on' : 'off'} permission=${DEFAULT_PERMISSION} ` +
          `idle_ttl=${IDLE_TTL_MS}ms max_live=${MAX_LIVE} max_rss=${MAX_RSS_MB}MB shared=${SHARED_PROCESS}`,
      );
      add(
        'team',
        TEAM_ACTIVE ? 'ok' : TEAM_MODE ? 'warn' : 'ok',
        TEAM_ACTIVE
          ? `on（profile=${DSH_PROFILE}）`
          : TEAM_MODE
            ? 'requested but unavailable：DSH < 0.1.7-0，或该 profile 不含 team 包'
            : 'off（opt-in：dsh-any-agent team on）',
        TEAM_ACTIVE ? null : TEAM_MODE ? '检查 DSH 版本 / profile，或 dsh-any-agent team off' : null,
      );

      const ok = !checks.some((c) => c.status === 'fail');
      const lines = checks.map(
        (c) =>
          `${c.status === 'ok' ? '✓' : c.status === 'warn' ? '⚠' : '✗'} ${c.id}: ${c.detail}` +
          (c.fix ? ` → ${c.fix}` : ''),
      );
      return {
        structured: { ok, verdict: ok ? 'ok' : 'fail', checks },
        text: `${ok ? '体检通过' : '体检发现失败项'}\n${lines.join('\n')}`,
      };
    },
  };
}