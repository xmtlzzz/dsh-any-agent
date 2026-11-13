/**
 * English text for the tool list and the server instructions.
 *
 * tool-defs.mjs stays the single source of truth for names, schemas and annotations; this file
 * only carries the words. `localizeToolDefs` (in tool-defs.mjs) swaps them in when the language
 * is `en`. test/smoke.mjs checks that every tool and every described parameter has an entry here,
 * so a description added in Chinese cannot silently stay untranslated.
 *
 * This file holds what the client reads up front: titles, descriptions, parameter descriptions
 * and the instructions. The text a tool returns at run time is translated where it is produced,
 * with `L('中文', 'English')` from lang.mjs.
 */

import {
  DEFAULT_PERMISSION,
  DEFAULT_REASONING,
  DEFAULT_REASONING_EFFORT,
  DEFAULT_REVIEW,
  defaultApprovalPolicy,
} from './config.mjs';

const CONV_ID = 'Conversation id, from dsh_start or dsh_list.';

export const TOOL_TEXT_EN = {
  dsh_start: {
    title: 'Start conversation',
    description:
      'Create a DSH conversation: a coding agent you can keep working with. The conversation lives on disk and the process is ' +
      'only a cache; if the process is reaped or crashes, the next dispatch brings it back with ACP session/resume and nothing ' +
      'is lost. Returns the conversation_id and the conversation title. Dispatch work to it with dsh_send.',
    params: {
      cwd:
        'Absolute path of the workspace. It decides the agent\'s working directory, where AGENTS.md and skills are discovered, ' +
        'and the root the sandbox may write to. A single local root can supply the default in a legacy MCP client. ' +
        'Pass cwd explicitly with multiple roots, no roots, or MCP 2026-07-28.',
      permission:
        `Permission tier. Default ${DEFAULT_PERMISSION}. read-only suits untrusted material such as malware samples; ` +
        'workspace-write limits writes through the DSH sandbox. Escalation requests follow the machine approval policy. ' +
        'The tier is fixed at creation. A resumed DSH ' +
        'session keeps the permission it recorded, so changing this argument later does not change an existing conversation; ' +
        'create a new one to switch tiers. (The tier is really enforced: it comes from the environment passed at spawn time, ' +
        'and test/permission.mjs checks each tier against the session\'s own record.)',
      on_approval:
        'How approval requests are handled. **read-only forces auto-deny** (auto-allow or ask is rejected outright, because it ' +
        `would let DSH's sandbox escalation through). The default tier has a machine ceiling of ${defaultApprovalPolicy(DEFAULT_PERMISSION)}. ` +
        'Callers can choose a stricter policy. The operator sets DSH_MCP_APPROVAL to permit a less restrictive policy. ' +
        'ask leaves each request pending until you decide it with dsh_approval_decide.',
      title_hint:
        'A readable label for the conversation (up to 200 characters). DSH\'s own title is a truncated prefix of the first ' +
        'message (about 13-15 characters) and is shown first; the value given here is not overwritten and comes back in ' +
        'dsh_get / dsh_start as the title hint.',
      reasoning_effort:
        `Reasoning effort, default ${DEFAULT_REASONING_EFFORT}. ACP's own default is "Provider default" (unset); this server ` +
        'sets max explicitly. Lower it to save money.',
      review:
        `Caller review policy, default ${DEFAULT_REVIEW}. advisory: every dispatch result and sentinel carries a review ticket ` +
        '(checklist, evidence, and the dsh_review entry point) but **does not block** later dispatches; off: no ticket. ' +
        'A single dsh_send can override it.',
      provider: 'Model provider name (for example deepseek-official). Leave empty for the profile default.',
      model: 'Model name (for example deepseek-flash). When set, provider must be set too.',
      keep_alive:
        'true = this conversation\'s process is exempt from idle-TTL and MAX_LIVE reaping (for a long-lived conversation that ' +
        'must keep holding the write lock). Default false: after 10 idle minutes the process is reaped and its memory freed, and ' +
        'the next dispatch resumes it with nothing lost. With true, remember to dsh_release when done, or it keeps a DSH ' +
        'process (about 300-480 MB) forever.',
      isolation:
        'Workspace isolation, default none (work directly in cwd). worktree = create a new worktree and branch `dsh/<time>` for ' +
        "the git repository cwd is in and work there, leaving the main checkout alone, so you (the caller) can keep editing " +
        'the original directory at the same time. It starts from the current HEAD: uncommitted changes in the main checkout are ' +
        'not carried over, and the new worktree has no node_modules or other dependencies, so DSH may reinstall them. The changes ' +
        'stay on that branch for you to review and merge yourself; dsh_release(forget=true) deletes the worktree directory if it ' +
        'is clean (the branch is kept).',
    },
  },
  dsh_send: {
    title: 'Dispatch task',
    description:
      'Dispatch a task to a conversation. **Give a goal, not commands**: DSH decides which file, shell, search, skill, subagent ' +
      'and team tools to use, and this server does not preload or proxy DSH\'s tool surface. ' +
      '**Non-blocking by default (wait=false)**: it returns run_id + sentinel_file at once, the turn runs in the background and ' +
      'you are notified when it ends, so you can do other work and the task is never cut off by a timeout. ' +
      'Pass wait=true to block for the result (optionally with timeout_ms; on expiry it only moves to the background and does ' +
      'not cancel the turn). [A timeout never destroys the task] when wait=true reaches timeout_ms before the turn ends, this ' +
      'tool **does not error and does not cancel**: it downgrades to background, returns run_id + sentinel_file, and the turn ' +
      'runs to the end with the result delivered through the sentinel file (timeout_ms=0 means wait forever). ' +
      'In both modes a small file holding the final result is written atomically when the turn ends. ' +
      '**Wait for it with a background task (Bash run_in_background + `until [ -f sentinel_file ]`; on Windows/PowerShell a ' +
      '`Test-Path` loop, and the receipt contains ready-made commands) and you are woken when it lands; no polling needed.** ' +
      'Once the file exists, read it for the result, or collect with dsh_get(conversation_id, run_id); dsh_read shows output ' +
      'while the turn is running. Reasoning is hidden by default (answer plus reasoning statistics only). ' +
      'Results and background receipts carry a `review` ticket (advisory by default): verify, then submit a verdict with ' +
      'dsh_review. If the conversation is busy this tool errors: use dsh_send(queue=true) to enqueue (returns at once), ' +
      'dsh_interject to stop and redirect, or dsh_interrupt to just stop.',
    params: {
      conversation_id: CONV_ID,
      prompt: 'The task. It may refer to file paths in the workspace.',
      wait:
        '**Default false**: return run_id + sentinel_file at once; the turn runs in the background and the sentinel file ' +
        'signals completion (recommended). true = block until the turn ends and return the full result.',
      reasoning:
        `How much reasoning to return. Default ${DEFAULT_REASONING} (answer only, reasoning as statistics). full uses a lot of context.`,
      timeout_ms:
        'Upper bound on the **wait**, in milliseconds, only with wait=true. **Default 0 = wait forever** (no invented ' +
        '30-minute limit). On expiry the turn is not cancelled; it moves to the background and you get a run_id.',
      review:
        'Review policy for this dispatch, overriding the conversation default (advisory). advisory: the result and sentinel ' +
        'carry a review ticket asking the caller to verify independently and submit a verdict with dsh_review; off: none this time.',
      queue:
        'Whether to enqueue when the conversation is busy (default false = error). With true it returns run_id + ' +
        'queue_position at once and runs after the current turn; the sentinel is written only when the run really ends, not ' +
        'when it is queued. Queued prompts stay in memory. After restart, unstarted receipts resolve as cancelled. Manage the queue with dsh_queue. ' +
        "(dsh_interject(mode='queue') also runs after the current turn, but it blocks until the new turn ends and does not use this queue.)",
      client_run_id:
        'Caller-generated idempotency key (up to 128 characters, scoped to this conversation and retained with the sentinel). Submitting the same key again ' +
        'does not create a second run: it returns the first run\'s result or receipt (replayed=true). For safely resending ' +
        'after a response was lost in transport.',
      team:
        'Whether to prepend the "form a team first when this needs parallel or multi-role work" hint to this dispatch ' +
        '(default follows DSH_MCP_TEAM). false turns it off for this call only; DSH_MCP_TEAM=0 turns it off entirely.',
    },
  },
  dsh_list: {
    title: 'List conversations',
    description:
      'List conversations and their live state, for keeping track of several at once. ' +
      'state: running (a turn is in progress) / idle (process alive, nothing running) / detached (no process; resumable). ' +
      'A running conversation also reports elapsed time, the tool it is executing and how much it has output this turn. ' +
      'Two sources are merged: conversations this server holds, and ones on DSH\'s disk that are not open (DSH\'s session/list ' +
      'leaves out open sessions). Pass only_running=true for just the active ones; follow up with dsh_read to see what one is producing.',
    params: {
      cwd: 'Only conversations in this workspace.',
      include_closed:
        'Whether to include conversations on disk that are not open (including ones created by other instances or the GUI). ' +
        'Default true. **Cost: it spawns a DSH process to probe the disk, about 1 second measured** (cached for 10 seconds). ' +
        'Pass false to list only what this server has open, in milliseconds.',
      only_running:
        'Only return conversations with a turn in progress. Default false. **This mode skips the disk probe and answers in ' +
        'milliseconds** (a running conversation is always in memory).',
    },
  },
  dsh_read: {
    title: 'Read live output',
    description:
      'Read a conversation\'s run-time output (**cursor-based and incremental**): see what a running conversation has produced ' +
      'so far without waiting for the turn to end. Typical use: dsh_list(only_running) to find active conversations, then call ' +
      'dsh_read repeatedly, passing back the last cursor, to watch several in turn. The output buffer is **memory-only and ' +
      'bounded** (a ring; the oldest entries are dropped) and disappears when the server or process exits. ' +
      '**Reasoning is not buffered**: live reasoning of the turn currently running is attached only with include_reasoning=true. ' +
      'The cursor is a **revision number**: an entry whose text grew is returned again; match it by `seq` and replace its text ' +
      '(do not append twice).',
    params: {
      conversation_id: CONV_ID,
      cursor: 'The cursor returned last time; omit or pass 0 on the first call.',
      include_reasoning: 'Attach the live reasoning of the current turn. Default false.',
      limit: 'Maximum entries per call. Default 200.',
    },
  },
  dsh_get: {
    title: 'Get conversation or run result',
    description:
      'Details of one conversation; with run_id, **the final result of that dispatch** (the place to collect asynchronous ' +
      'work). Without run_id it uses the most recent turn. Returns: title, workspace, permission tier, state, turn count, ' +
      'token usage, context pressure, pending approvals, and the turn\'s full result (answer, tools, usage, error) with its ' +
      '**review ticket**. The service keeps the latest 20 runs in memory. After a restart or eviction the ' +
      'result is read back from the sentinel file, which is on disk and survives restarts.',
    params: {
      conversation_id: CONV_ID,
      run_id: 'The run_id returned by dsh_send. With only the conversation ID, look up the current or most recently started turn, including retained results after reconnecting.',
      client_run_id:
        'Look the run up by its idempotency key instead of run_id. Works across restarts during sentinel retention.',
      max_chars:
        'Result budget (default 0 = no truncation, full result). Above 0 it applies to **both** text and structured output: ' +
        'the answer is cut to that length (with answer_truncated / next_offset), and structured.run.result.tools_used keeps ' +
        'only tool name, status and input_chars instead of full inputs. The complete result is always in sentinel_file. ' +
        'When a turn used many tools the default can exceed a client\'s per-result limit; about 8000 is a good value.',
    },
  },
  dsh_review: {
    title: 'Submit review verdict',
    description:
      'Record the **caller\'s review verdict** on the result of a turn that has **ended** (to allow or deny a permission ' +
      'request while a turn is running, use dsh_approval_decide). Results from dsh_send / dsh_interject and the sentinel carry ' +
      'a `review` ticket (checklist, evidence summary, review_id). Before treating a result as done, verify it yourself (read ' +
      'the changed files, look at git diff, run tests), then call this tool to record pass / partial / fail. ' +
      '**Reviews are advisory by default**: they do not block later dsh_send calls and are not fed back to DSH automatically; ' +
      'send another dsh_send if something needs fixing. A verdict can still be submitted after the run record was evicted from ' +
      'memory or the server restarted (the sentinel file is the reference).',
    params: {
      conversation_id: CONV_ID,
      run_id: 'The dispatch being reviewed (the run_id on the review ticket).',
      verdict:
        'pass = usable as is; partial = partly usable, needs more work; fail = unusable, redo. fail and partial require a reason.',
      notes: 'The reason. Required for fail/partial (or use findings instead). Up to 8000 characters.',
      findings: 'Optional itemised list of problems; up to 50 items of up to 2000 characters each.',
    },
  },
  dsh_interject: {
    title: 'Interject',
    description:
      'Say something to a conversation while it is running a turn. **This tool blocks until the new turn ends** (it moves to ' +
      'the background only when timeout_ms expires). Two modes: interject (default) stops the current turn and redirects at ' +
      'once; queue does not stop it and speaks right after the current turn ends naturally (without using the dsh_queue queue). ' +
      'To stop without saying anything use dsh_interrupt; to run after the current turn without blocking use ' +
      'dsh_send(queue=true). On an idle conversation it runs as **an ordinary wait=true turn** (full result, not a receipt). ' +
      'Note: ACP refuses concurrent prompts, so steering the model inside the same turn is not possible; interject is the ' +
      'practical equivalent (cancel, then start a new turn immediately, with history intact).',
    params: {
      conversation_id: CONV_ID,
      message: 'What to say.',
      mode: 'interject (default) = stop and redirect; queue = speak after the current turn finishes.',
      reasoning: `How much reasoning to return. Default ${DEFAULT_REASONING}.`,
      timeout_ms:
        'Upper bound on **waiting** for the new turn, in milliseconds. **Default 0 = wait forever**; in queue mode it also ' +
        'bounds the wait for the previous turn to end. While busy, a wait that times out is an error (the message was not ' +
        'sent and the conversation is unharmed); when idle, expiry only moves the turn to the background without cancelling it.',
      review:
        'Review policy for this turn, overriding the conversation default (advisory); off skips the review ticket this time.',
      client_run_id:
        'Caller-generated idempotency key (up to 128 characters, scoped to this conversation). Submitting it again returns the first run instead of interjecting twice.',
    },
  },
  dsh_interrupt: {
    title: 'Interrupt turn',
    description:
      'Stop without saying anything new: interrupt the turn the conversation is running (ACP\'s native session/cancel, the ' +
      'same path as a user pressing stop). The interrupted turn is recorded as cancelled; the text and tool calls it had ' +
      'produced stay in its result (dsh_get / sentinel), and files it changed are not rolled back. The conversation itself ' +
      'stays healthy and can take a new task right away. To stop and redirect use dsh_interject; to cancel a queued task that ' +
      'has not started use dsh_queue(action=remove).',
    params: { conversation_id: CONV_ID },
  },
  dsh_takeover: {
    title: 'Take over write lock',
    description:
      '**Preempt a conversation\'s write lock.** DSH\'s write lock is a cross-process kernel semaphore that never expires ' +
      'while its holder lives, and no API can take it away: the only means is killing the holder, so this tool first works out ' +
      'who that is. (1) If the lock is actually free, a normal resume follows and nothing is killed. (2) If the holder is ' +
      '**an orphan this server left behind** (the MCP crashed or restarted while the child lived on holding the lock), it is ' +
      '**killed and taken over automatically**; this is safe. (3) If the holder is **another live dsh-any-agent instance**, ' +
      'the request is refused unless force=true. (4) If the holder cannot be identified (**most likely your own DSH GUI has ' +
      'this conversation open**) it is **never killed** (that would take your UI and the conversation you are reading down ' +
      'with it): it is only reported, so you can close the conversation in that window and retry. ' +
      'Killing a holder that is running a turn interrupts that turn (logged as interrupted); the conversation itself is unharmed.',
    params: {
      conversation_id: CONV_ID,
      force:
        'Only for the "another live dsh-any-agent instance holds it" case; it has no effect on a GUI or unknown holder (never killed).',
    },
  },
  dsh_release: {
    title: 'Release conversation',
    description:
      'Release the DSH process a conversation occupies (this frees the write lock so the user can open the same conversation ' +
      'in their own DSH GUI). The conversation stays on disk and can be resumed later; **forget=true writes a tombstone**: it ' +
      'is removed from the registry and later lookups by id say it was forgotten (to bring it back, delete the tombstone file ' +
      'named in the error, by default `$DSH_HOME/.dsh-any-agent-forgotten/<id>.json`). ' +
      'To free memory in one go when you are done, pass all=true (each conversation is about 300-480 MB; the default ' +
      '`MAX_LIVE=4` already reaps the least recently used one; all=true releases **idle** conversations and skips ones running ' +
      'a turn unless force=true). Releasing a single conversation stops its DSH process; if a turn is running, it is interrupted.',
    params: {
      conversation_id: CONV_ID,
      forget: 'Also remove it from this server\'s registry. Default false.',
      all:
        'Ignore conversation_id and release every **idle** conversation process (to free memory). Conversations running a turn are skipped by default. Default false.',
      force:
        'Only with all=true: also stop conversations that are running a turn (those turns are interrupted). Default false.',
    },
  },
  dsh_approval_decide: {
    title: 'Decide approval',
    description:
      'While a turn is running, decide a permission request DSH is waiting on (these only appear when the conversation uses ' +
      'on_approval=ask); after you allow or deny, the turn continues. It hands DSH\'s out-of-sandbox and escalation requests ' +
      'to the caller instead of allowing or denying them all. To grade the result of a finished turn use dsh_review.',
    params: {
      conversation_id: CONV_ID,
      approval_id: 'From dsh_inbox, or pending_approvals in dsh_get.',
      decision: 'Allow or deny.',
    },
  },
  dsh_status: {
    title: 'Conversation status',
    description:
      'A lightweight snapshot of one conversation: reads live state from this server\'s memory without spawning a DSH process. ' +
      'Returns state (running/idle/detached), the current tool and output size while running, the latest turn\'s run_id, ' +
      'status and review status, pending approvals, queue length, and the write-lock holder lock_holder (when you hit the ' +
      'lock, use it to choose between dsh_takeover and asking the other side to dsh_release). ' +
      'For a turn\'s full result use dsh_get, for live output dsh_read, for all conversations dsh_list.',
    params: { conversation_id: CONV_ID },
  },
  dsh_inbox: {
    title: 'Approval inbox',
    description:
      '**Inbox of pending approvals across conversations** (dsh_status covers a single one). Lists every approval waiting ' +
      'for your decision: conversation id and title, approval id, tool, reason, a summary of the command or path, and how long ' +
      'it has waited. Decide with dsh_approval_decide. Returns an empty list when nothing is pending.',
    params: {
      conversation_id: 'Only this conversation (omit for all).',
      include_input: 'Whether to include a summary of the operation\'s input (default true).',
    },
  },
  dsh_queue: {
    title: 'Manage queue',
    description:
      'Inspect or change a conversation\'s queue of pending tasks (it only manages tasks already queued; enqueue with ' +
      'dsh_send(queue=true)). A restart marks unstarted receipts cancelled. action=list lists them. remove cancels one and writes a ' +
      'cancelled sentinel; update rewrites the queued text; promote moves one to the front.',
    params: {
      conversation_id: CONV_ID,
      run_id: 'Required for remove / update / promote.',
      text: 'The new text, for update.',
    },
  },
  dsh_doctor: {
    title: 'Health check',
    description:
      'Read-only health check: the DSH executable and version, whether the profile exists or has drifted, the state file, ' +
      'whether the runs/locks directories are writable, orphan locks, the number of sessions and their RSS, and the effective ' +
      'configuration. It reports and changes nothing; ok=false means at least one check failed.',
    params: {},
  },
};

/** English server instructions. Kept short for the same reason as the Chinese ones: clients truncate. */
export const INSTRUCTIONS_EN = `This server drives DeepSeek Harness (DSH) as a coding agent you can keep working with. DSH has its own file, shell, search, skill and subagent tools; you give it a **goal** and it decides how.

[Iron rules]
- Give goals, not commands. DSH's internal tool names (read, pwsh, ...) are not tools of this server; this server only has dsh_*.
- Do not dsh_send to a busy conversation. To run after the current turn use dsh_send(queue=true) (returns at once); to stop and redirect use dsh_interject (blocks until the new turn ends); to just stop use dsh_interrupt.
- Before treating a result as done, verify it with your own tools (read files, git diff, run tests), then submit pass/partial/fail with dsh_review (fail and partial need a reason).
- **Do not open a conversation this server drives in the DSH GUI**: opening it gives the GUI the write lock and it is not returned. To look at it there, dsh_release first.

[Three ids] conversation_id = the long-lived conversation (the process is only a cache; after reaping or a crash the next dispatch resumes it); run_id = one dispatch; cursor = dsh_read's incremental position.

[Flow] dsh_start(cwd?) -> dsh_send(conversation_id, prompt), non-blocking by default, returns run_id + sentinel_file at once -> wait for the sentinel -> read it or collect with dsh_get -> dsh_review. dsh_status / dsh_read / dsh_list(only_running=true) work at any time. dsh_release when done.

[Waiting: the sentinel file, not polling] Every turn that ends (success, failure or cancel) writes a sentinel JSON atomically. Wait for it with a **background task** (the receipt has ready-made commands: sentinel_file_posix for Bash, sentinel_wait_powershell for PowerShell) and the host wakes you when it lands; read it for status and result (in Windows PowerShell read with -Encoding UTF8; the receipt has sentinel_read_powershell). wait=true blocks in place; a wait timeout only moves the turn to the background and never cancels it. Progress notifications are sent only when the call carries a progressToken.

[Write lock] One writer per conversation at a time. On "already owned by an active write handle" (or a vague Internal error) do not retry; read lock_holder from dsh_status: stale-mcp -> dsh_takeover; live-mcp -> dsh_release on that side, or dsh_takeover(force=true) if you must; none usually means the GUI holds it -> ask the user to close it there. This server never kills the GUI.

[Defaults] permission ${DEFAULT_PERMISSION}, machine approval ceiling ${defaultApprovalPolicy(DEFAULT_PERMISSION)}. Read-only forces auto-deny. Reasoning is hidden by default (returned only with reasoning='full'). Reasoning effort defaults to max (lower it with reasoning_effort).

[Privacy] This server's logs, sentinels and registry never contain reasoning text, but DSH's own ~/.dsh/sessions does store it. Sentinels contain the answer and tool inputs (common secrets redacted) and are kept for 7 days.

Tool results follow the same language as this text. A few less common error messages are still Chinese; the field names in structured output are always English.`;
