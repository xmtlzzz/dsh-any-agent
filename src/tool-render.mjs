/**
 * 工具结果的文本渲染：审核单、回合结果、后台收据、幂等重放、入队回执，以及 PowerShell
 * 版的哨兵等待 / 读取命令。
 *
 * 从 tools.mjs 拆出来：这些都是"结构化结果 -> 给模型看的文本"的纯函数（只读入参，
 * 不碰 hub 的运行期状态），所以能脱离处理器表单独测试。tools.mjs 仍然重新导出
 * `compactResultForBudget` / `psWaitCommand` / `psReadCommand`，外部的导入路径不变。
 */

import { TURN_MAX_MS, toPosixPath } from './config.mjs';
import { L } from './lang.mjs';

/**
 * 把审核单渲染成调用方一眼能看到的文本块。
 *
 * 为什么放在正文后面而不是单独一次工具调用：MCP 调用方拿到结果后往往直接转述，
 * 审核要求必须和结果出现在同一条消息里，才有机会改变它的下一步动作。
 */
export function renderReviewSection(review) {
  if (!review || typeof review !== 'object') return '';
  const lines = [];
  const pending = review.status === 'pending';
  lines.push(L(
    `【调用方审核${pending ? ' · 待提交' : ` · ${review.status}`}】`,
    `[Caller review${pending ? ' · not submitted yet' : ` · ${review.status}`}]`,
  ));
  if (review.prompt_preview) lines.push(L(`原任务: ${review.prompt_preview}`, `Task: ${review.prompt_preview}`));
  const ev = review.evidence ?? {};
  const bits = [];
  if (ev.stop_reason) bits.push(`stop=${ev.stop_reason}`);
  if (ev.workspace_changed != null) {
    bits.push(L(`工作区变化=${ev.workspace_changed ? '是' : '否'}`, `workspace changed=${ev.workspace_changed ? 'yes' : 'no'}`));
  }
  if (ev.changed_files != null) bits.push(L(`改动文件=${ev.changed_files}`, `changed files=${ev.changed_files}`));
  if (Array.isArray(ev.tools) && ev.tools.length) bits.push(L(`工具=[${ev.tools.join(', ')}]`, `tools=[${ev.tools.join(', ')}]`));
  if (ev.auto_approvals) {
    bits.push(L(
      `⚠ 自动放行审批=${ev.auto_approvals}${ev.auto_escalations ? `（含提权 ${ev.auto_escalations}）` : ''}`,
      `⚠ auto-allowed approvals=${ev.auto_approvals}${ev.auto_escalations ? ` (${ev.auto_escalations} escalations)` : ''}`,
    ));
  }
  if (bits.length) lines.push(L(`证据: ${bits.join(' · ')}`, `Evidence: ${bits.join(' · ')}`));
  if (pending) {
    lines.push(L('在把这次结果当作完成之前，请独立核验：', 'Before treating this result as done, verify it independently:'));
    (review.checklist ?? []).forEach((item, i) => lines.push(`${i + 1}. ${item}`));
    if (review.instructions) lines.push(review.instructions);
    lines.push(
      L('提交裁决: ', 'Submit the verdict: ') +
        `dsh_review(conversation_id="${review.conversation_id}", run_id="${review.run_id}", ` +
        `verdict="pass|partial|fail", notes="${L('审核理由', 'reason')}")`,
    );
  } else {
    if (review.notes) lines.push(L(`审核理由: ${review.notes}`, `Reason: ${review.notes}`));
    if (Array.isArray(review.findings) && review.findings.length) {
      lines.push(L(`审核问题: ${review.findings.join('；')}`, `Findings: ${review.findings.join('; ')}`));
    }
    if (review.review_file) lines.push(L(`审核记录: ${review.review_file}`, `Review record: ${review.review_file}`));
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
 * 等哨兵的后台命令多久放弃（秒）：回合总时长上限 + 5 分钟。到上限看门狗会取消回合、照常写哨兵；
 * 服务进程半路退出也会写"已中断"哨兵（被直接杀掉时由下一个启动的进程补写）。所以正常情况下
 * 哨兵一定先到，等到 TIMEOUT 只说明服务退出后一直没再起来。上限关掉（0）时用 35 分钟兜底。
 */
export const SENTINEL_WAIT_SEC = TURN_MAX_MS > 0 ? Math.ceil(TURN_MAX_MS / 1000) + 300 : 2100;

/**
 * PowerShell 版的哨兵等待命令（Windows 宿主上 Git Bash 可能不可用或挂住）。
 * 路径放进单引号字面量：PowerShell 单引号里只有 `'` 需要转义（写成 `''`），
 * `$`、反引号都不展开，所以不会被路径内容注入。
 */
export function psWaitCommand(sentinelPath, timeoutSec = SENTINEL_WAIT_SEC) {
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
export function renderSendResult(r) {
  const lines = [];
  if (r.answer?.trim()) lines.push(r.answer.trim());
  else lines.push(L('(DSH 本次没有产生正文输出)', '(DSH produced no answer text this turn)'));

  if (r.thinking && r.thinking.trim()) {
    lines.push('');
    lines.push(L('--- 思考内容 ---', '--- Reasoning ---'));
    lines.push(r.thinking.trim());
  }

  const meta = [];
  meta.push(`stop=${r.stop_reason}`);
  if (typeof r.elapsed_ms === 'number') {
    const sec = (r.elapsed_ms / 1000).toFixed(1);
    meta.push(L(`耗时=${sec}s`, `elapsed=${sec}s`));
  }
  if (r.thinking_stats?.chars) {
    const chars = r.thinking_stats.chars;
    meta.push(
      r.thinking_stats.hidden
        ? L(
            `思考已隐藏(${chars}字/${(r.thinking_stats.ms / 1000).toFixed(1)}s)`,
            `reasoning hidden (${chars} chars/${(r.thinking_stats.ms / 1000).toFixed(1)}s)`,
          )
        : L(`思考=${chars}字`, `reasoning=${chars} chars`),
    );
  }
  const tools = (r.tools_used ?? []).map((t) => t.name ?? t.title).filter(Boolean);
  if (tools.length) meta.push(L(`工具=[${[...new Set(tools)].join(', ')}]`, `tools=[${[...new Set(tools)].join(', ')}]`));
  if (r.git_snapshot_incomplete) {
    meta.push(L('已恢复回合结果，最终 Git 快照未完成。', 'Turn result recovered before the final Git snapshot completed.'));
  } else if (r.workspace_changed) {
    const n = r.diff_stat?.changed_files ?? '?';
    meta.push(L(
      `本轮工作区状态发生变化(当前共 ${n} 个文件有改动)`,
      `the workspace changed this turn (${n} files currently modified)`,
    ));
  }
  if (r.auto_approvals_total) {
    meta.push(
      L(`自动放行审批 ${r.auto_approvals_total} 次`, `${r.auto_approvals_total} approvals auto-allowed`) +
        (r.auto_escalations_total
          ? L(`(含沙箱提权 ${r.auto_escalations_total} 次)`, ` (${r.auto_escalations_total} sandbox escalations)`)
          : ''),
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
    lines.push(L(`⚠️ 回合失败: ${r.error}`, `⚠️ Turn failed: ${r.error}`));
  }
  return lines.join('\n');
}

/**
 * 后台收据的渲染：wait=false 直接走这里；wait=true 等超时会自动降级到这里。
 * 关键语义：**回合没有被取消**，只是我们不再原地等 —— 结果稍后由哨兵文件通知。
 */
export function backgroundReceipt(hub, conv, res) {
  const sentinel = res.sentinel_file ?? hub.runSentinelPath(conv.id, res.run_id);
  const sentinelPosix = toPosixPath(sentinel);
  const review = conv.pendingReviewTicket?.(res.run_id) ?? null;
  const waitedSec = res.waited_ms ? (res.waited_ms / 1000).toFixed(0) : null;
  const waited = waitedSec
    ? L(
        `已等待 ${waitedSec}s 仍未结束，改为后台继续（**回合没有被取消**）。`,
        `Still running after ${waitedSec}s of waiting; it continues in the background (**the turn was not cancelled**).`,
      )
    : L('已在后台执行（**回合没有被取消**）。', 'Running in the background (**the turn was not cancelled**).');
  const bashWait =
    `  Bash(run_in_background): sent="${sentinelPosix}"; \\\n` +
    `    dl=$(( $(date +%s)+${SENTINEL_WAIT_SEC} )); until [ -f "$sent" ]; do [ $(date +%s) -ge $dl ] && { echo TIMEOUT; exit 1; }; sleep 2; done; echo DONE\n`;
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
      `${waited}${L('（', ' (')}run_id=${res.run_id}${L('）', ')')}\n\n` +
      L(
        `【跑完自动通知，无需轮询】完成时（成功/失败/被取消）会原子写出这个文件（含最终结果，但**不含思考内容**）：\n`,
        `[You are notified when it ends; no polling] On completion (success, failure or cancel) this file is written atomically (it holds the final result but **no reasoning**):\n`,
      ) +
      `  ${sentinel}\n` +
      L(
        `直接用下面这个 Bash 形式路径，**不要手工转换**（写错会一直等到超时）：\n`,
        `Use the Bash-form path below as is; **do not convert it by hand** (a wrong path waits until the timeout):\n`,
      ) +
      `  ${sentinelPosix}\n` +
      L(
        `推荐用后台任务等它出现，文件一到就会唤醒你：\n`,
        `Wait for it with a background task; you are woken as soon as the file exists:\n`,
      ) +
      bashWait +
      (process.platform === 'win32'
        ? L(
            `Windows 上 Bash 不可用（或会挂住）时，用 PowerShell 版本（原生路径，已转义好）：\n`,
            `On Windows, when Bash is unavailable (or hangs), use the PowerShell version (native path, already escaped):\n`,
          ) +
          `  PowerShell(run_in_background): ${psWaitCommand(sentinel)}\n` +
          L(
            `读取时必须带 -Encoding UTF8（Windows PowerShell 5.1 默认按 ANSI 读，会乱码/解析失败）：\n`,
            `Read it with -Encoding UTF8 (Windows PowerShell 5.1 reads as ANSI by default, which garbles the text and breaks parsing):\n`,
          ) +
          `  ${psReadCommand(sentinel)}\n`
        : '') +
      (TURN_MAX_MS > 0
        ? L(
            `等待上限是回合总时长上限 + 5 分钟，哨兵一定先到；真等到 TIMEOUT 说明本服务被杀后没再起来 —— 重连本服务，哨兵会补出来。\n`,
            `The wait limit is the turn's maximum duration plus 5 minutes, so the sentinel arrives first; an actual TIMEOUT means this server was killed and never came back. Reconnect it and the sentinel is written.\n`,
          )
        : L(
            `回合没有总时长上限（DSH_MCP_TURN_MAX_MS=0），等待 35 分钟兜底；TIMEOUT 不代表回合失败，先 dsh_status 看一眼，还在跑就重新等。\n`,
            `Turns have no maximum duration (DSH_MCP_TURN_MAX_MS=0), so the wait gives up after 35 minutes; a TIMEOUT does not mean the turn failed. Check dsh_status and wait again if it is still running.\n`,
          )) +
      L(
        `文件出现后：直接读它拿结果（推荐——不受内存窗口限制、还扛服务重启），或 dsh_get(conversation_id, run_id) 验收。\n` +
          `消费完可以 rm 掉它。其它随时可用：dsh_status（是否在跑）、dsh_read（增量看输出）。`,
        `Once the file exists: read it for the result (recommended: it is not limited by the in-memory window and survives a server restart), or collect with dsh_get(conversation_id, run_id).\n` +
          `You may delete it after reading. Available at any time: dsh_status (is it running), dsh_read (incremental output).`,
      ) +
      (review ? `\n\n${renderReviewSection(review)}` : '') +
      (res.waited_ms
        ? L(
            `\n\n下次想立刻返回就传 wait=false；想等更久就调大 timeout_ms（**0 = 一直等**）。`,
            `\n\nTo return at once next time pass wait=false; to wait longer raise timeout_ms (**0 = wait forever**).`,
          )
        : ''),
  };
}

/**
 * 幂等命中：返回同一个 client_run_id 首次对应 run 的结果或收据。
 * 绝不创建第二个 run —— 这正是"响应在传输层丢了、想安全重发"需要的语义。
 */
export function replayRun(hub, conv, run, wantResult) {
  const sentinel = hub.runSentinelPath(conv.id, run.run_id);
  const sentinelPosix = toPosixPath(sentinel);
  const terminal = run.status === 'done' || run.status === 'error' || run.status === 'cancelled';
  const sentinelLine = L(`哨兵文件: ${sentinel}`, `Sentinel file: ${sentinel}`);
  if (terminal && run.result) {
    return {
      structured: { ...run.result, replayed: true, ...(wantResult ? {} : { background: true }) },
      text:
        L(
          `（幂等命中：client_run_id 已对应一个已结束的回合，未重复派活）\n`,
          `(Idempotent replay: this client_run_id already maps to a finished turn; nothing was dispatched again)\n`,
        ) +
        renderSendResult(run.result) +
        `\n${sentinelLine}`,
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
      L(
        `（幂等命中：同一个 client_run_id 已在跑或排队，未重复派活）`,
        `(Idempotent replay: this client_run_id is already running or queued; nothing was dispatched again) `,
      ) +
      `run_id=${run.run_id} status=${run.status}\n` +
      sentinelLine +
      (review ? `\n\n${renderReviewSection(review)}` : ''),
  };
}

/** 入队回执：入队时不写哨兵，真正结束才写。 */
export function queuedReceipt(hub, conv, run, position) {
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
      L(
        `已入队（第 ${position} 位）。当前回合结束后自动执行；**入队时不会写哨兵**，真正结束时才写：\n`,
        `Queued (position ${position}). It runs automatically after the current turn; **no sentinel is written when queued**, only when it really ends:\n`,
      ) +
      `  ${sentinel}\n` +
      L(
        `用 dsh_queue list 查看/修改/删除；取消：dsh_queue(conversation_id, action="remove", run_id="${run.run_id}")。`,
        `Use dsh_queue list to inspect, change or delete; to cancel: dsh_queue(conversation_id, action="remove", run_id="${run.run_id}").`,
      ) +
      (review ? `\n\n${renderReviewSection(review)}` : ''),
  };
}
