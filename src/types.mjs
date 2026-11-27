/**
 * Core JSDoc type definitions shared across Hub, Conversation, RunLedger, and client setup.
 * Zero runtime footprint; imported only in JSDoc comments (`import('./types.mjs').Foo`).
 */

/**
 * @typedef {object} RunRecord
 * @property {string} run_id
 * @property {string} conversation_id
 * @property {string|null} client_run_id
 * @property {string} prompt_preview
 * @property {'queued'|'running'|'done'|'error'|'cancelled'} status
 * @property {'off'|'advisory'} review_mode
 * @property {number|null} started_at
 * @property {number} [start_order]
 * @property {number|null} ended_at
 * @property {number|null} elapsed_ms
 * @property {object|null} result
 * @property {string} [sentinel_error]
 * @property {boolean} [result_available]
 */

/**
 * @typedef {object} SentinelPayload
 * @property {1} schema
 * @property {string} conversation_id
 * @property {string} run_id
 * @property {string|null} client_run_id
 * @property {'done'|'error'|'cancelled'} status
 * @property {string|null} [prompt_preview]
 * @property {'off'|'advisory'} [review_mode]
 * @property {number|null} started_at
 * @property {number|null} start_order
 * @property {number} ended_at
 * @property {object|null} result
 * @property {string|null} [error]
 */

/**
 * @typedef {object} ConversationState
 * @property {string} id
 * @property {string} cwd
 * @property {'read-only'|'workspace-write'|'danger-full-access'} permission
 * @property {'auto-allow'|'auto-deny'|'ask'} onApproval
 * @property {number} createdAt
 * @property {number} lastUsedAt
 * @property {number} turnCount
 * @property {string|null} titleHint
 * @property {boolean} keepAlive
 * @property {string} reasoningEffort
 * @property {string|null} provider
 * @property {string|null} model
 * @property {'off'|'advisory'} review
 * @property {object|null} workspace
 * @property {object|null} worktree
 */

/**
 * @typedef {object} ApprovalPending
 * @property {string} id
 * @property {string} conversation_id
 * @property {string|null} run_id
 * @property {string} desc
 * @property {Array<object>} options
 * @property {object} context
 * @property {number} created_at
 * @property {number} timeout_ms
 */

/**
 * Runtime approval entry, including the resolver for the pending ACP request.
 * @typedef {object} PendingApprovalEntry
 * @property {ApprovalPending['run_id']} runId
 * @property {{tool:string, details:Record<string, unknown>}} params
 * @property {number} createdAt
 * @property {string|null} allowId
 * @property {string|null} rejectId
 * @property {(outcome:object)=>void} resolve
 */

/**
 * @typedef {object} ConversationContext
 * @property {import('./hub.mjs').Hub} hub
 * @property {import('./conversation-live.mjs').ConversationLive} activity
 * @property {()=>number|null} getLastChildStartedAt
 * @property {()=>void} assertNotForgotten
 * @property {()=>void} scheduleDrain
 * @property {(run:RunRecord|null)=>void} setUndispatched
 * @property {()=>void} resetCancelBeforeDispatch
 * @property {()=>boolean} isCancelledBeforeDispatch
 */

/** @typedef {{id:string, status:'ok'|'warn'|'fail', detail:string, fix:string|null}} DoctorCheck */
/** @typedef {{mode:'daemon'|'direct', endpointId?:string, pid?:number, logFile?:string, fallbackReason?:string}} HubRuntime */
/** @typedef {{pid:number, path:string, token:string, version:string, started_at:string, started_at_ms?:number|null}} DaemonInfo */

/**
 * @typedef {object} ClientPlan
 * @property {string} id
 * @property {string} label
 * @property {string} path
 * @property {string} status
 * @property {boolean} changed
 * @property {string} summary
 * @property {string} [sourceHash]
 * @property {string|null} [next]
 * @property {boolean} [deleteFile]
 * @property {string|null} [backup]
 * @property {string} [error]
 */

export {};
