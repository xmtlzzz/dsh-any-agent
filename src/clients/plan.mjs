/**
 * 单个客户端配置的计划（planClient，纯只读）与落盘（applyClient，先备份后原子写）。
 */

import { chmodSync, existsSync, mkdirSync, statSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  ENTRY_NAME,
  atomicWrite,
  backupFile,
  isWritable,
  readConfigFile,
  settleRemoval,
  sourceHashOf,
} from './io.mjs';
import { editJsonEntry, repairJsonLaunch, stripWs } from './jsonc.mjs';
import { editTomlBlock, repairTomlLaunch } from './toml.mjs';
import { codexBlock, entryShape, existingShapeMode } from './registry.mjs';

const DELETES_FILE = '; nothing else is in the file, so the file itself would be deleted';

/** @returns {import('../types.mjs').ClientPlan} */
export function planClient(client, ctx) {
  const { dirs, remove, repair, launch, env } = ctx;
  const file = client.pathOf(dirs);
  const base = { id: client.id, label: client.label, path: file, sourceHash: sourceHashOf(file) };

  if (repair) {
    if (!existsSync(file)) return { ...base, status: 'absent', changed: false, summary: 'config file does not exist' };
    const { text, bom } = readConfigFile(file);
    const next = client.kind === 'toml' ? repairTomlLaunch(text, launch) : repairJsonLaunch(text, client, launch);
    if (next === null) return { ...base, status: 'absent', changed: false, summary: 'entry does not exist; use setup --yes to register it' };
    if (next === text) return { ...base, status: 'unchanged', changed: false, summary: 'launch paths already up to date' };
    return { ...base, status: 'planned', changed: true, next: bom + next, summary: 'launch command and arguments would be updated' };
  }

  if (client.kind === 'toml') {
    const block = remove ? null : codexBlock(launch, env);
    if (!existsSync(file)) {
      if (remove) return { ...base, status: 'absent', changed: false, summary: 'config file does not exist' };
      return { ...base, status: 'planned', changed: true, next: editTomlBlock('', block).text, summary: 'would create the config file with our table' };
    }
    const { bom, text } = readConfigFile(file);
    const edited = editTomlBlock(text, block, {
      preserveEnv: !ctx.resetEnv,
      replaceBin: Boolean(env?.DSH_BIN),
      replaceDaemon: ctx.replaceDaemon !== false,
    });
    const r = { changed: edited.changed, text: bom + edited.text };
    if (!r.changed) {
      return { ...base, status: 'unchanged', changed: false, summary: remove ? 'not present' : 'already up to date' };
    }
    if (remove) {
      const settled = settleRemoval(file, r.text, r.text, (t) => t.trim() === '');
      return { ...base, status: 'planned', changed: true, ...settled, summary: 'TOML block would be removed' + (settled.deleteFile ? DELETES_FILE : '') };
    }
    return { ...base, status: 'planned', changed: true, next: r.text, summary: 'TOML block would be written' };
  }

  // JSON / JSONC
  const desired = remove ? null : entryShape(client.shape, launch, env, existingShapeMode(client, file));
  if (!existsSync(file)) {
    if (remove) return { ...base, status: 'absent', changed: false, summary: 'config file does not exist' };
    const seeded = editJsonEntry('{}\n', client.containerKey, ENTRY_NAME, desired);
    return { ...base, status: 'planned', changed: true, next: seeded.text, summary: 'would create the config file with our entry' };
  }

  const { raw } = readConfigFile(file);
  let r;
  try {
    r = editJsonEntry(raw, client.containerKey, ENTRY_NAME, desired, {
      dropEmptyContainer: remove === true,
      preserveEnvFor: !ctx.resetEnv && client.shape,
      replaceBin: Boolean(env?.DSH_BIN),
      replaceDaemon: ctx.replaceDaemon !== false,
    });
  } catch (e) {
    const summary = e.code === 'EJSONSCAN'
      ? 'existing file is not valid JSON (' + e.message + '); it was left untouched'
      : 'refusing to edit: ' + e.message;
    return { ...base, status: 'failed', changed: false, summary };
  }
  if (!r.changed) {
    return { ...base, status: 'unchanged', changed: false, summary: remove ? 'not present' : 'already up to date' };
  }
  if (remove) {
    const kept = editJsonEntry(raw, client.containerKey, ENTRY_NAME, null).text;
    const settled = settleRemoval(file, r.text, kept, (t) => stripWs(t) === '{}');
    return { ...base, status: 'planned', changed: true, ...settled, summary: 'entry would be removed' + (settled.deleteFile ? DELETES_FILE : '') };
  }
  return { ...base, status: 'planned', changed: true, next: r.text, summary: 'entry would be written' };
}

/** @returns {import('../types.mjs').ClientPlan} */
export function applyClient(plan, ctx, stamp) {
  if (!plan || !plan.changed || !ctx.write) return plan;

  const { remove } = ctx;
  const client = ctx.byId.get(plan.id);

  if (typeof plan.next !== 'string' && !plan.deleteFile) return plan;

  if (sourceHashOf(plan.path) !== plan.sourceHash) {
    if (ctx.replanned) {
      return { ...plan, status: 'failed', changed: false, summary: 'config file keeps changing while we edit it; left untouched, re-run setup' };
    }
    const fresh = planClient(client, ctx);
    if (!fresh.changed) return fresh;
    return applyClient(fresh, { ...ctx, replanned: true }, stamp);
  }

  let originalMode = null;
  if (!isWritable(plan.path)) {
    if (!ctx.force) {
      return {
        ...plan,
        status: 'failed',
        changed: false,
        summary: 'config file is read-only, refusing to overwrite it (use --force to override)',
      };
    }
    try {
      originalMode = statSync(plan.path).mode;
      chmodSync(plan.path, 0o644);
    } catch (e) {
      return { ...plan, status: 'failed', changed: false, summary: 'could not clear the read-only bit: ' + e.message };
    }
  }

  try {
    let backup;
    if (existsSync(plan.path)) backup = backupFile(plan.path, stamp);
    mkdirSync(dirname(plan.path), { recursive: true });
    if (plan.deleteFile) unlinkSync(plan.path);
    else atomicWrite(plan.path, plan.next);
    if (originalMode !== null && !plan.deleteFile) {
      try { chmodSync(plan.path, originalMode); } catch { /* 尽力而为 */ }
    }
    return {
      ...plan,
      status: remove ? 'removed' : 'applied',
      summary: (plan.deleteFile ? 'entry removed; the file held nothing else and was deleted' : remove ? 'entry removed' : 'entry written') + (originalMode !== null ? ' (read-only file overridden by --force)' : ''),
      backup,
    };
  } catch (e) {
    if (originalMode !== null) {
      try { chmodSync(plan.path, originalMode); } catch { /* 尽力而为 */ }
    }
    return { ...plan, status: 'failed', changed: false, summary: 'write failed: ' + e.message };
  }
}
