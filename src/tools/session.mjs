/**
 * 会话生命周期与运维观测类 MCP 工具：dsh_start、dsh_list、dsh_status、dsh_release、dsh_takeover、dsh_doctor。
 */

import { DEFAULT_PERMISSION, TEAM_MODE } from '../config.mjs';
import { audit } from '../audit.mjs';
import { L } from '../lang.mjs';
import { listOrphans } from '../locks.mjs';
import { runDoctor } from '../doctor.mjs';
import { latestRun } from './inspect.mjs';

export function createSessionHandlers(hub, { projectDir = null } = {}) {
  return {
    async dsh_start(args, { signal, modern } = {}) {
      let cwd = args.cwd;
      let cwdSource = cwd ? 'explicit' : null;
      if (!cwd && projectDir && !modern) {
        const fromClient = await projectDir();
        if (fromClient) {
          cwd = fromClient;
          cwdSource = 'client-root';
        }
      }
      signal?.throwIfAborted();
      if (!cwd && modern) throw new Error(L('MCP 2026-07-28 请显式传入 cwd。', 'Pass cwd explicitly with MCP 2026-07-28.'));
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
      const { profile, backend } = conv.proc?.teamProfile ?? {};
      let teamStatus = L('关（默认关闭；需要时运行 dsh-any-agent team on）', 'off (the default; run dsh-any-agent team on to enable)');
      if (backend === 'native') {
        teamStatus = L(`开（profile=${profile}；使用 DSH 的会话团队模式）`, `on (profile=${profile}; uses DSH session team mode)`);
      } else if (backend === 'experimental') {
        teamStatus = L(
          `开（profile=${profile}；派发时会提示"需要时先建团队"，简单任务不会组队）`,
          `on (profile=${profile}; dispatches carry a "form a team first when needed" hint, simple tasks stay single-agent)`,
        );
      } else if (TEAM_MODE) {
        teamStatus = L('未启用（用 dsh_doctor 检查 DSH 版本与 profile）', 'unavailable (check the DSH version and profile with dsh_doctor)');
      }
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
        L('团队模式: ', 'Team mode: ') + teamStatus,
        L('对话名: ', 'Title: ') +
          (snap.title ?? L('(DSH 尚未生成，发出第一条消息后自动生成)', '(not generated yet; DSH creates it after the first message)')) +
          (snap.title_hint && snap.title !== snap.title_hint
            ? L(`（你给的标题提示: ${snap.title_hint}）`, ` (your title hint: ${snap.title_hint})`)
            : ''),
        L('工作区登记: ', 'Workspace registration: ') +
          (snap.workspace_registered
            ? L('已写入 DSH 工作区注册表（GUI 里能看到）', "written to DSH's workspace registry (visible in the GUI)")
            : L('未登记', 'not registered')),
        L(
          '实时查看: 运行 dsh-any-agent watch 或 dashboard --open（只读、不碰写锁；避免在 DSH GUI 直接点开运行中会话）。',
          'Live view: run dsh-any-agent watch or dashboard --open (read-only, never takes the write lock; avoid opening active sessions in DSH GUI).',
        ),
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
        if (
          conv.lastConfigApplied?.failedKeys?.includes('model') ||
          snap.config_failed.some((f) => /^(?:模型|model)=/i.test(String(f)))
        ) {
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

    async dsh_list(args) {
      let items = await hub.list({
        cwd: args.cwd,
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
            '\n→ 可用 dsh_takeover 尝试接管，服务会先核实持锁进程的身份。',
            '\n→ Try dsh_takeover. The server verifies the lock holder’s process identity first.',
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

    async dsh_release(args) {
      if (args.all === true) {
        const r = await hub.releaseAll({ force: args.force === true });
        audit('release_all', { released: r.released, failed: r.failed.length, skipped_busy: r.skipped_busy.length });
        return {
          isError: r.failed.length > 0,
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
              '\n会话日志都在磁盘上，之后派活会自动 resume；没有一个可释放时 released=0。',
              '\nSession logs are on disk, so a later dispatch resumes them; released=0 means nothing was releasable.',
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
        isError: r.closed !== true || (args.forget === true && !r.forgotten),
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
            : !r.closed
              ? L(`⚠️ 未确认写锁已释放：${r.error ?? '原因未知'}`, `⚠️ Could not confirm write lock release: ${r.error ?? 'unknown reason'}`)
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

    async dsh_status(args) {
      const conv = await hub.get(args.conversation_id);
      const run = await latestRun(hub, conv);
      const snap = conv.snapshot();
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

    async dsh_doctor() {
      return runDoctor(hub);
    },
  };
}
