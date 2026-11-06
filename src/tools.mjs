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

// 外部（mcp.mjs、测试）一直从 tools.mjs 取这些名字；拆出去之后导入路径保持不变。
export { TOOL_DEFS } from './tool-defs.mjs';

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
 * 把审核单渲染成调用方一眼能看到的文本块。
 *
 * 为什么放在正文后面而不是单独一次工具调用：MCP 调用方拿到结果后往往直接转述，
 * 审核要求必须和结果出现在同一条消息里，才有机会改变它的下一步动作。
 */
function renderReviewSection(review) {
  if (!review || typeof review !== 'object') return '';
  const lines = [];
  const pending = review.status === 'pending';
  lines.push(`【调用方审核${pending ? ' · 待提交' : ` · ${review.status}`}】`);
  if (review.prompt_preview) lines.push(`原任务: ${review.prompt_preview}`);
  const ev = review.evidence ?? {};
  const bits = [];
  if (ev.stop_reason) bits.push(`stop=${ev.stop_reason}`);
  if (ev.workspace_changed != null) bits.push(`工作区变化=${ev.workspace_changed ? '是' : '否'}`);
  if (ev.changed_files != null) bits.push(`改动文件=${ev.changed_files}`);
  if (Array.isArray(ev.tools) && ev.tools.length) bits.push(`工具=[${ev.tools.join(', ')}]`);
  if (ev.auto_approvals) {
    bits.push(`⚠ 自动放行审批=${ev.auto_approvals}${ev.auto_escalations ? `（含提权 ${ev.auto_escalations}）` : ''}`);
  }
  if (bits.length) lines.push(`证据: ${bits.join(' · ')}`);
  if (pending) {
    lines.push('在把这次结果当作完成之前，请独立核验：');
    (review.checklist ?? []).forEach((item, i) => lines.push(`${i + 1}. ${item}`));
    if (review.instructions) lines.push(review.instructions);
    lines.push(
      `提交裁决: dsh_review(conversation_id="${review.conversation_id}", run_id="${review.run_id}", ` +
        'verdict="pass|partial|fail", notes="审核理由")',
    );
  } else {
    if (review.notes) lines.push(`审核理由: ${review.notes}`);
    if (Array.isArray(review.findings) && review.findings.length) {
      lines.push(`审核问题: ${review.findings.join('；')}`);
    }
    if (review.review_file) lines.push(`审核记录: ${review.review_file}`);
  }
  return lines.join('\n');
}

/**
 * 按 `max_chars` 预算压缩一份回合结果（只用于返回给调用方，不改原对象）。
 *
 * 体积大头是 tools_used[].input：edit/write 会带完整的新旧文本，几十次工具调用
 * 轻松几万字。压缩后每个工具只留 id/title/name/status/kind 与 input_chars；
 * 正文与思考截到预算长度。完整版本仍在哨兵文件里。
 */
export function compactResultForBudget(result, cap) {
  if (!result || typeof result !== 'object' || !(cap > 0)) return result ?? null;
  const out = { ...result };
  if (typeof out.answer === 'string' && out.answer.length > cap) out.answer = out.answer.slice(0, cap);
  if (typeof out.thinking === 'string' && out.thinking.length > cap) out.thinking = out.thinking.slice(0, cap);
  if (Array.isArray(out.tools_used)) {
    out.tools_used = out.tools_used.map((t) => {
      if (!t || typeof t !== 'object') return t;
      const { input, ...meta } = t;
      if (input === undefined) return meta;
      let chars = 0;
      try {
        chars = typeof input === 'string' ? input.length : JSON.stringify(input)?.length ?? 0;
      } catch {
        chars = 0;
      }
      return { ...meta, input_chars: chars };
    });
  }
  return out;
}

/**
 * PowerShell 版的哨兵等待命令（Windows 宿主上 Git Bash 可能不可用或挂住）。
 * 路径放进单引号字面量：PowerShell 单引号里只有 `'` 需要转义（写成 `''`），
 * `$`、反引号都不展开，所以不会被路径内容注入。
 */
export function psWaitCommand(sentinelPath, timeoutSec = 2100) {
  const lit = `'${String(sentinelPath).replace(/'/g, "''")}'`;
  return (
    `$f=${lit}; $dl=(Get-Date).AddSeconds(${Math.max(1, Math.floor(timeoutSec))}); ` +
    `while(-not (Test-Path -LiteralPath $f)){ if((Get-Date) -gt $dl){ 'TIMEOUT'; exit 1 }; Start-Sleep -Seconds 2 }; 'DONE'`
  );
}

/**
 * PowerShell 版的哨兵**读取**命令。哨兵是无 BOM 的 UTF-8：Windows PowerShell 5.1 的
 * `Get-Content` 默认按 ANSI 代码页读，中文正文会乱码、`ConvertFrom-Json` 直接解析失败，
 * 所以必须显式 `-Encoding UTF8`（PowerShell 7 默认就是 UTF-8，加上也无害）。
 */
export function psReadCommand(sentinelPath) {
  const lit = `'${String(sentinelPath).replace(/'/g, "''")}'`;
  return `Get-Content -LiteralPath ${lit} -Raw -Encoding UTF8 | ConvertFrom-Json`;
}

/** 把结构化结果渲染成给模型看的文本。 */
function renderSendResult(r) {
  const lines = [];
  if (r.answer?.trim()) lines.push(r.answer.trim());
  else lines.push('(DSH 本次没有产生正文输出)');

  if (r.thinking && r.thinking.trim()) {
    lines.push('');
    lines.push('--- 思考内容 ---');
    lines.push(r.thinking.trim());
  }

  const meta = [];
  meta.push(`stop=${r.stop_reason}`);
  if (typeof r.elapsed_ms === 'number') meta.push(`耗时=${(r.elapsed_ms / 1000).toFixed(1)}s`);
  if (r.thinking_stats?.chars) {
    meta.push(
      r.thinking_stats.hidden
        ? `思考已隐藏(${r.thinking_stats.chars}字/${(r.thinking_stats.ms / 1000).toFixed(1)}s)`
        : `思考=${r.thinking_stats.chars}字`,
    );
  }
  const tools = (r.tools_used ?? []).map((t) => t.name ?? t.title).filter(Boolean);
  if (tools.length) meta.push(`工具=[${[...new Set(tools)].join(', ')}]`);
  if (r.workspace_changed) meta.push(`本轮工作区状态发生变化(当前共 ${r.diff_stat?.changed_files ?? '?'} 个文件有改动)`);
  if (r.auto_approvals_total) {
    meta.push(
      `自动放行审批 ${r.auto_approvals_total} 次` +
        (r.auto_escalations_total ? `(含沙箱提权 ${r.auto_escalations_total} 次)` : ''),
    );
  }
  lines.push('');
  lines.push(`[${meta.join(' · ')}]`);

  if (r.review) {
    lines.push('');
    lines.push(renderReviewSection(r.review));
  }

  if (r.error) {
    lines.push('');
    lines.push(`⚠️ 回合失败: ${r.error}`);
  }
  return lines.join('\n');
}

/** 工具处理器表。 */
/**
 * 后台收据的渲染：wait=false 直接走这里；wait=true 等超时会自动降级到这里。
 * 关键语义：**回合没有被取消**，只是我们不再原地等 —— 结果稍后由哨兵文件通知。
 */
function backgroundReceipt(hub, conv, res) {
  const sentinel = res.sentinel_file ?? hub.runSentinelPath(conv.id, res.run_id);
  const sentinelPosix = toPosixPath(sentinel);
  const review = conv.pendingReviewTicket?.(res.run_id) ?? null;
  const waited = res.waited_ms
    ? `已等待 ${(res.waited_ms / 1000).toFixed(0)}s 仍未结束，改为后台继续（**回合没有被取消**）。`
    : '已在后台执行（**回合没有被取消**）。';
  return {
    structured: {
      conversation_id: conv.id,
      run_id: res.run_id,
      accepted: true,
      background: true,
      still_running: true,
      sentinel_file: sentinel,
      /** Bash/MSYS 形式（D:\a\b → /d/a/b）；非 Windows 等于 sentinel_file。 */
      sentinel_file_posix: sentinelPosix,
      /** Windows 宿主：现成的 PowerShell 等待命令（路径已按单引号字面量转义）。 */
      ...(process.platform === 'win32'
        ? { sentinel_wait_powershell: psWaitCommand(sentinel), sentinel_read_powershell: psReadCommand(sentinel) }
        : {}),
      ...(review ? { review } : {}),
    },
    text:
      `${waited}（run_id=${res.run_id}）\n\n` +
      `【跑完自动通知，无需轮询】完成时（成功/失败/被取消）会原子写出这个文件（含最终结果，但**不含思考内容**）：\n` +
      `  ${sentinel}\n` +
      `直接用下面这个 Bash 形式路径，**不要手工转换**（写错会一直等到超时）：\n` +
      `  ${sentinelPosix}\n` +
      `推荐用后台任务等它出现，文件一到就会唤醒你：\n` +
      `  Bash(run_in_background): sent="${sentinelPosix}"; \\\n` +
      `    dl=$(( $(date +%s)+2100 )); until [ -f "$sent" ]; do [ $(date +%s) -ge $dl ] && { echo TIMEOUT; exit 1; }; sleep 2; done; echo DONE\n` +
      (process.platform === 'win32'
        ? `Windows 上 Bash 不可用（或会挂住）时，用 PowerShell 版本（原生路径，已转义好）：\n` +
          `  PowerShell(run_in_background): ${psWaitCommand(sentinel)}\n` +
          `读取时必须带 -Encoding UTF8（Windows PowerShell 5.1 默认按 ANSI 读，会乱码/解析失败）：\n` +
          `  ${psReadCommand(sentinel)}\n`
        : '') +
      `文件出现后：直接读它拿结果（推荐——不受内存窗口限制、还扛服务重启），或 dsh_get(conversation_id, run_id) 验收。\n` +
      `消费完可以 rm 掉它。其它随时可用：dsh_status（是否在跑）、dsh_read（增量看输出）。` +
      (review ? `\n\n${renderReviewSection(review)}` : '') +
      (res.waited_ms
        ? `\n\n下次想立刻返回就传 wait=false；想等更久就调大 timeout_ms（**0 = 一直等**）。`
        : ''),
  };
}

/**
 * 幂等命中：返回同一个 client_run_id 首次对应 run 的结果或收据。
 * 绝不创建第二个 run —— 这正是"响应在传输层丢了、想安全重发"需要的语义。
 */
function replayRun(hub, conv, run, wantResult) {
  const sentinel = hub.runSentinelPath(conv.id, run.run_id);
  const sentinelPosix = toPosixPath(sentinel);
  const terminal = run.status === 'done' || run.status === 'error' || run.status === 'cancelled';
  if (terminal && run.result) {
    return {
      structured: { ...run.result, replayed: true, ...(wantResult ? {} : { background: true }) },
      text:
        `（幂等命中：client_run_id 已对应一个已结束的回合，未重复派活）\n` +
        renderSendResult(run.result) +
        `\n哨兵文件: ${sentinel}`,
    };
  }
  const review = conv.pendingReviewTicket?.(run.run_id) ?? null;
  return {
    structured: {
      conversation_id: conv.id,
      run_id: run.run_id,
      status: run.status,
      accepted: true,
      background: true,
      still_running: true,
      replayed: true,
      sentinel_file: sentinel,
      sentinel_file_posix: sentinelPosix,
      ...(review ? { review } : {}),
    },
    text:
      `（幂等命中：同一个 client_run_id 已在跑或排队，未重复派活）run_id=${run.run_id} status=${run.status}\n` +
      `哨兵文件: ${sentinel}` +
      (review ? `\n\n${renderReviewSection(review)}` : ''),
  };
}

/** 入队回执：入队时不写哨兵，真正结束才写。 */
function queuedReceipt(hub, conv, run, position) {
  const sentinel = hub.runSentinelPath(conv.id, run.run_id);
  const sentinelPosix = toPosixPath(sentinel);
  const review = conv.pendingReviewTicket?.(run.run_id) ?? null;
  return {
    structured: {
      conversation_id: conv.id,
      run_id: run.run_id,
      accepted: true,
      queued: true,
      queue_position: position,
      status: 'queued',
      sentinel_file: sentinel,
      sentinel_file_posix: sentinelPosix,
      ...(review ? { review } : {}),
    },
    text:
      `已入队（第 ${position} 位）。当前回合结束后自动执行；**入队时不会写哨兵**，真正结束时才写：\n` +
      `  ${sentinel}\n` +
      `用 dsh_queue list 查看/修改/删除；取消：dsh_queue(conversation_id, action="remove", run_id="${run.run_id}")。` +
      (review ? `\n\n${renderReviewSection(review)}` : ''),
  };
}

/**
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