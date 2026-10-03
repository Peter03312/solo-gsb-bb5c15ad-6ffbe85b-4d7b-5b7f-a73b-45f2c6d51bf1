'use strict';

// 并行整理年表草稿的只读编辑会话（staging + 三方合并提交）。
//
// 开启会话（openSession）只做一件事：把当时草稿的事件 / 主张 / 先于关系与
// 草稿修订号冻结进 edit_sessions.baseline_json。会话内的一切修改只暂存到
// changes_json（整组替换），草稿区在提交前完全不变。
//
// 暂存（stageChanges）先做结构（400）与语义（422 SESSION_CHANGESET_INVALID）
// 校验：未知正式编号、临时编号重复 / 缺失、引用了本会话已删事件、日期或出处非法、
// 自环关系、同一对象同时改删等都会一次性列出且不保存暂存。
//
// 提交（commitSession）在单个事务内以「会话基线 baseline vs 当前草稿 current
// vs 拟提交值 proposed」做三方合并：
//   - 双方都没碰、或只有一方改动（含双方改成同值）的对象 / 字段自动合并；
//   - 同一字段被双方改成不同值、编辑与删除相撞、拟改 / 拟建关系的端点已删除、
//     拟建主张的事件已删除等 → 整次拒绝：草稿一字不写，会话置 conflict（只读），
//     逐项冲突附 {baseline,current,proposed}，须基于最新草稿重开会话；
//   - 无冲突时原子应用全部增删改，修订号只推进一次，返回新修订号与
//     临时编号 → 正式编号映射。
// 已 committed / conflict 的会话再次提交为重放：直接返回首次结果（成功或冲突），
// 绝不重复写入。放弃（abandonSession）仅 open 会话可操作，重复放弃幂等。

const crypto = require('crypto');
const { getDb } = require('./db');
const { parseClaimDate, claimInterval, formatClaimDate } = require('./dates');
const { draftRevisionNo } = require('./restore');

const STATUSES = ['open', 'committed', 'conflict', 'abandoned'];
const MAX = { editor: 200, note: 1000, tempId: 100, title: 200, description: 5000, source: 1000, noteField: 2000 };

// ---------- 草稿快照（与 /api/editor/state 同构；会话基线用） ----------
function snapshotDraft(db = getDb()) {
  const events = db
    .prepare('SELECT * FROM events ORDER BY id')
    .all()
    .map((e) => ({
      id: e.id,
      title: e.title,
      description: e.description,
      claims: db
        .prepare('SELECT * FROM claims WHERE event_id = ? ORDER BY id')
        .all(e.id)
        .map((c) => claimRowApi(c)),
    }));
  const relations = db
    .prepare('SELECT * FROM relations ORDER BY id')
    .all()
    .map((r) => ({ id: r.id, earlierId: r.earlier_id, laterId: r.later_id, source: r.source, note: r.note }));
  return {
    events,
    relations,
    counts: {
      eventCount: events.length,
      claimCount: events.reduce((n, e) => n + e.claims.length, 0),
      relationCount: relations.length,
    },
  };
}

function claimRowApi(c) {
  return {
    id: c.id,
    eventId: c.event_id,
    precision: c.precision,
    year: c.year,
    month: c.month,
    day: c.day,
    dateLabel: c.date_label,
    intervalStart: c.interval_start,
    intervalEnd: c.interval_end,
    source: c.source,
    note: c.note,
  };
}

function emptyChanges() {
  return {
    events: { create: [], update: [], delete: [] },
    claims: { create: [], update: [], delete: [] },
    relations: { create: [], update: [], delete: [] },
  };
}

function canonDate(c) {
  return JSON.stringify([c.precision, c.year, c.month, c.day]);
}

// ---------- 会话行读写 ----------
function rowToSession(row) {
  if (!row) return null;
  const baseline = JSON.parse(row.baseline_json);
  const changes = JSON.parse(row.changes_json);
  return {
    sessionNo: row.id,
    status: row.status,
    editor: row.editor,
    note: row.note,
    baselineRevisionNo: row.baseline_revision,
    currentRevisionNo: draftRevisionNo(),
    stale: row.status === 'open' && row.baseline_revision !== draftRevisionNo(),
    createdAt: row.created_at,
    committedAt: row.committed_at,
    abandonedAt: row.abandoned_at,
    commitKey: row.commit_key,
    baseline,
    changes,
    working: workingCopy(baseline, changes),
    conflicts: row.conflicts_json ? JSON.parse(row.conflicts_json) : null,
    result: row.result_json ? JSON.parse(row.result_json) : null,
  };
}

function getSession(id) {
  return rowToSession(getDb().prepare('SELECT * FROM edit_sessions WHERE id = ?').get(id));
}

function listSessions() {
  return getDb()
    .prepare('SELECT * FROM edit_sessions ORDER BY id DESC')
    .all()
    .map((row) => {
      const s = rowToSession(row);
      // 列表只给摘要（不含完整基线/暂存/工作副本，避免响应过大）
      const { baseline, changes, working, conflicts, result, ...summary } = s;
      return {
        ...summary,
        stale: summary.status === 'open' && summary.baselineRevisionNo !== summary.currentRevisionNo,
        counts: baseline.counts,
        stagedCounts: {
          eventCreate: changes.events.create.length,
          eventUpdate: changes.events.update.length,
          eventDelete: changes.events.delete.length,
          claimCreate: changes.claims.create.length,
          claimUpdate: changes.claims.update.length,
          claimDelete: changes.claims.delete.length,
          relationCreate: changes.relations.create.length,
          relationUpdate: changes.relations.update.length,
          relationDelete: changes.relations.delete.length,
        },
        conflictCount: conflicts ? conflicts.length : 0,
      };
    });
}

// ---------- 开启 / 放弃 ----------
function openSession({ editor = '', note = '' } = {}) {
  const db = getDb();
  const editorStr = typeof editor === 'string' ? editor.slice(0, MAX.editor) : '';
  const noteStr = typeof note === 'string' ? note.slice(0, MAX.note) : '';
  const baseline = snapshotDraft(db);
  const info = db
    .prepare(
      `INSERT INTO edit_sessions (editor, note, status, baseline_revision, baseline_json, changes_json)
       VALUES (?, ?, 'open', ?, ?, ?)`
    )
    .run(editorStr, noteStr, draftRevisionNo(), JSON.stringify(baseline), JSON.stringify(emptyChanges()));
  return getSession(info.lastInsertRowid);
}

function abandonSession(id) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM edit_sessions WHERE id = ?').get(id);
  if (!row) throw { status: 404, message: `编辑会话 ${id} 不存在` };
  if (row.status === 'abandoned') {
    return { abandoned: true, alreadyAbandoned: true, session: rowToSession(row) };
  }
  if (row.status !== 'open') {
    throw {
      status: 409,
      code: 'SESSION_NOT_ABANDONABLE',
      message: `编辑会话 ${id} 已${row.status === 'committed' ? '提交' : '因冲突关闭'}，不能放弃。`,
      sessionNo: id,
      statusNow: row.status,
    };
  }
  db.prepare("UPDATE edit_sessions SET status = 'abandoned', abandoned_at = datetime('now') WHERE id = ?").run(id);
  return { abandoned: true, alreadyAbandoned: false, session: getSession(id) };
}

// ---------- 暂存整组修改（替换式） ----------
function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function badStructure(message) {
  return { status: 400, code: 'SESSION_CHANGESET_INVALID', message };
}

// 结构解析：必须是 {events:{create,update,delete}, claims:{...}, relations:{...}}。
// 结构不对 → 400（请求写法错误）；语义问题由 validateChanges 收集 → 422。
function parseChanges(input) {
  if (!isPlainObject(input)) throw badStructure('changes 必须是对象，含 events / claims / relations 三个分组');
  const out = emptyChanges();
  for (const entity of ['events', 'claims', 'relations']) {
    const g = input[entity];
    if (!isPlainObject(g)) throw badStructure(`changes.${entity} 必须是 {create, update, delete} 对象`);
    if (!Array.isArray(g.create) || !Array.isArray(g.update) || !Array.isArray(g.delete)) {
      throw badStructure(`changes.${entity} 的 create / update / delete 都必须是数组`);
    }
  }
  out.events = { create: input.events.create, update: input.events.update, delete: input.events.delete };
  out.claims = { create: input.claims.create, update: input.claims.update, delete: input.claims.delete };
  out.relations = { create: input.relations.create, update: input.relations.update, delete: input.relations.delete };
  return out;
}

function isPosInt(v) {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1;
}

// 事件引用：正式编号（正整数）或本会话事件临时编号（非空字符串）
function refKind(v) {
  if (isPosInt(v)) return { kind: 'id', value: v };
  if (typeof v === 'string' && v.trim() !== '' && v.length <= MAX.tempId) {
    return { kind: 'temp', value: v };
  }
  return null;
}

function prob(type, message, extra = {}) {
  return { type, message, ...extra };
}

// 语义校验（收集全部问题，空数组 = 通过），通过即返回规整后的暂存结构。
function normalizeChanges(input, baseline) {
  const raw = parseChanges(input);
  const problems = [];

  const baseEventById = new Map(baseline.events.map((e) => [e.id, e]));
  const baseClaimById = new Map();
  baseline.events.forEach((e) => e.claims.forEach((c) => baseClaimById.set(c.id, c)));
  const baseRelById = new Map(baseline.relations.map((r) => [r.id, r]));

  const norm = emptyChanges();
  const tempIds = new Map(); // tempId → 所在分组（临时编号全局唯一）

  const checkTempId = (tempId, where) => {
    if (typeof tempId !== 'string' || tempId.trim() === '') {
      problems.push(prob('invalid_temp_id', `${where} 缺少临时编号 tempId（非空字符串，用于提交后映射正式编号）`));
      return false;
    }
    if (tempId.length > MAX.tempId) {
      problems.push(prob('invalid_temp_id', `${where} 临时编号长度不能超过 ${MAX.tempId} 字符`, { tempId }));
      return false;
    }
    if (tempIds.has(tempId)) {
      problems.push(prob('duplicate_temp_id', `${where} 临时编号「${tempId}」与 ${tempIds.get(tempId)} 重复`, { tempId }));
      return false;
    }
    tempIds.set(tempId, where);
    return true;
  };

  // ---- 事件 ----
  const eventUpdateIds = new Set();
  const eventDeleteIds = new Set();

  raw.events.create.forEach((o, i) => {
    const at = `events.create[${i}]`;
    if (!isPlainObject(o)) { problems.push(prob('invalid_structure', `${at} 必须是对象`)); return; }
    if (!checkTempId(o.tempId, at)) return;
    const title = typeof o.title === 'string' ? o.title.trim() : '';
    if (!title) { problems.push(prob('invalid_title', `${at} 的 title 必须是非空字符串`, { tempId: o.tempId })); return; }
    if (title.length > MAX.title) { problems.push(prob('invalid_title', `${at} 的 title 长度不能超过 ${MAX.title}`, { tempId: o.tempId })); return; }
    const description = typeof o.description === 'string' ? o.description : '';
    if (description.length > MAX.description) {
      problems.push(prob('invalid_description', `${at} 的 description 长度不能超过 ${MAX.description}`, { tempId: o.tempId }));
      return;
    }
    norm.events.create.push({ tempId: o.tempId, title, description });
  });

  raw.events.delete.forEach((v, i) => {
    const at = `events.delete[${i}]`;
    if (!isPosInt(v)) { problems.push(prob('invalid_id', `${at} 必须是基线中的正式事件 id（正整数）`)); return; }
    if (!baseEventById.has(v)) { problems.push(prob('unknown_event', `${at}：事件 ${v} 不在会话基线中（可能已被删除；请基于最新草稿重开会话）`, { eventId: v })); return; }
    if (eventDeleteIds.has(v)) { problems.push(prob('duplicate_op', `${at}：事件 ${v} 重复列入删除`, { eventId: v })); return; }
    eventDeleteIds.add(v);
    norm.events.delete.push(v);
  });

  raw.events.update.forEach((o, i) => {
    const at = `events.update[${i}]`;
    if (!isPosInt(o && o.id)) { problems.push(prob('invalid_id', `${at} 必须含基线中的正式事件 id（正整数）`)); return; }
    const id = o.id;
    if (!baseEventById.has(id)) { problems.push(prob('unknown_event', `${at}：事件 ${id} 不在会话基线中`, { eventId: id })); return; }
    // 以下字段问题即使在「既改又删 / 重复」时也照样收集，保证一次性列全
    const patch = {};
    if (o.title !== undefined) {
      const title = typeof o.title === 'string' ? o.title.trim() : '';
      if (!title) problems.push(prob('invalid_title', `${at} 的 title 必须是非空字符串`, { eventId: id }));
      else if (title.length > MAX.title) problems.push(prob('invalid_title', `${at} 的 title 长度不能超过 ${MAX.title}`, { eventId: id }));
      else patch.title = title;
    }
    if (o.description !== undefined) {
      if (typeof o.description !== 'string' || o.description.length > MAX.description) {
        problems.push(prob('invalid_description', `${at} 的 description 必须是不超过 ${MAX.description} 字符的字符串`, { eventId: id }));
      } else patch.description = o.description;
    }
    if (eventDeleteIds.has(id)) { problems.push(prob('update_and_delete', `${at}：事件 ${id} 在本会话中既改又删，二选一`, { eventId: id })); return; }
    if (eventUpdateIds.has(id)) { problems.push(prob('duplicate_op', `${at}：事件 ${id} 出现多条更新，请合并为一条`, { eventId: id })); return; }
    if (!('title' in patch) && !('description' in patch)) {
      problems.push(prob('empty_patch', `${at} 没有可更新字段（title / description 至少一项）`, { eventId: id }));
      return;
    }
    eventUpdateIds.add(id);
    norm.events.update.push({ id, ...patch });
  });

  // 事件引用解析（正式 id 须在基线且未被本会话删除；字符串须是本会话新建事件的临时编号）
  const resolveEventRef = (ref, where) => {
    const r = refKind(ref);
    if (!r) { problems.push(prob('invalid_event_ref', `${where} 的事件引用必须是正式事件 id 或本会话事件临时编号`, { ref: String(ref) })); return null; }
    if (r.kind === 'temp') {
      if (!tempIds.has(r.value) || !norm.events.create.some((e) => e.tempId === r.value)) {
        problems.push(prob('unknown_temp_id', `${where} 引用了不存在的事件临时编号「${r.value}」`, { tempId: r.value }));
        return null;
      }
      return r;
    }
    if (!baseEventById.has(r.value)) {
      problems.push(prob('unknown_event', `${where} 引用的事件 ${r.value} 不在会话基线中`, { eventId: r.value }));
      return null;
    }
    if (eventDeleteIds.has(r.value)) {
      problems.push(prob('ref_deleted_event', `${where} 引用了本会话已暂存删除的事件 ${r.value}`, { eventId: r.value }));
      return null;
    }
    return r;
  };

  // ---- 主张 ----
  const claimUpdateIds = new Set();
  const claimDeleteIds = new Set();

  const checkSourceNote = (o, where) => {
    const out2 = {};
    if (o.source !== undefined) {
      if (typeof o.source !== 'string' || o.source.trim() === '') {
        problems.push(prob('invalid_source', `${where} 出处 source 必须是非空字符串（注明受访人 / 档案 / 页码）`));
      } else if (o.source.length > MAX.source) {
        problems.push(prob('invalid_source', `${where} 出处长度不能超过 ${MAX.source}`));
      } else out2.source = o.source;
    }
    if (o.note !== undefined) {
      if (typeof o.note !== 'string' || o.note.length > MAX.noteField) {
        problems.push(prob('invalid_note', `${where} 考异 note 必须是不超过 ${MAX.noteField} 字符的字符串`));
      } else out2.note = o.note;
    }
    return out2;
  };

  raw.claims.create.forEach((o, i) => {
    const at = `claims.create[${i}]`;
    if (!isPlainObject(o)) { problems.push(prob('invalid_structure', `${at} 必须是对象`)); return; }
    if (!checkTempId(o.tempId, at)) return;
    // 先做日期 / 出处等自有字段校验（即使引用也有问题，错误也应一次性列出）
    let date = null;
    try {
      date = parseClaimDate(o);
    } catch (err) {
      problems.push(prob('invalid_date', `${at} 日期非法：${err.message}`, { tempId: o.tempId }));
    }
    let sourceOk = true;
    if (typeof o.source !== 'string' || o.source.trim() === '') {
      problems.push(prob('invalid_source', `${at} 缺少出处 source（必填）`, { tempId: o.tempId }));
      sourceOk = false;
    } else if (o.source.length > MAX.source) {
      problems.push(prob('invalid_source', `${at} 出处长度不能超过 ${MAX.source}`, { tempId: o.tempId }));
      sourceOk = false;
    }
    const note = typeof o.note === 'string' ? o.note : '';
    if (note.length > MAX.noteField) {
      problems.push(prob('invalid_note', `${at} 考异 note 长度不能超过 ${MAX.noteField}`, { tempId: o.tempId }));
    }
    // 再校验事件引用
    const ref = resolveEventRef(o.eventId, at);
    if (!ref || !date || !sourceOk || note.length > MAX.noteField) return;
    const item = { tempId: o.tempId, eventId: ref.value, source: o.source, note, date };
    norm.claims.create.push(item);
  });

  raw.claims.delete.forEach((v, i) => {
    const at = `claims.delete[${i}]`;
    if (!isPosInt(v)) { problems.push(prob('invalid_id', `${at} 必须是基线中的正式主张 id（正整数）`)); return; }
    const b = baseClaimById.get(v);
    if (!b) { problems.push(prob('unknown_claim', `${at}：主张 ${v} 不在会话基线中`, { claimId: v })); return; }
    if (eventDeleteIds.has(b.eventId)) {
      problems.push(prob('redundant_op', `${at}：主张 ${v} 所属事件 ${b.eventId} 已在本会话暂存删除（会随事件一并删除，无需单列主张删除）`, { claimId: v }));
      return;
    }
    if (claimDeleteIds.has(v)) { problems.push(prob('duplicate_op', `${at}：主张 ${v} 重复列入删除`, { claimId: v })); return; }
    claimDeleteIds.add(v);
    norm.claims.delete.push(v);
  });

  raw.claims.update.forEach((o, i) => {
    const at = `claims.update[${i}]`;
    if (!isPosInt(o && o.id)) { problems.push(prob('invalid_id', `${at} 必须含基线中的正式主张 id（正整数）`)); return; }
    const id = o.id;
    const b = baseClaimById.get(id);
    if (!b) { problems.push(prob('unknown_claim', `${at}：主张 ${id} 不在会话基线中`, { claimId: id })); return; }
    const refDeleted = eventDeleteIds.has(b.eventId);
    if (refDeleted) {
      problems.push(prob('ref_deleted_event', `${at}：主张 ${id} 所属事件 ${b.eventId} 已在本会话暂存删除，不能再改主张`, { claimId: id }));
    }
    if (claimDeleteIds.has(id)) { problems.push(prob('update_and_delete', `${at}：主张 ${id} 在本会话中既改又删，二选一`, { claimId: id })); return; }
    if (claimUpdateIds.has(id)) { problems.push(prob('duplicate_op', `${at}：主张 ${id} 出现多条更新，请合并为一条`, { claimId: id })); return; }
    // 日期作为一个整体字段：未给任何日期字段则不变；给了任一字段就与基线合并后按精度重算
    let datePatch = null;
    if (['precision', 'year', 'month', 'day'].some((k) => o[k] !== undefined)) {
      const mergedDate = { precision: b.precision, year: b.year, month: b.month, day: b.day };
      for (const k of ['precision', 'year', 'month', 'day']) {
        if (o[k] !== undefined) mergedDate[k] = o[k];
      }
      try {
        const parsed = parseClaimDate(mergedDate);
        claimInterval(parsed.precision, parsed.year, parsed.month, parsed.day);
        datePatch = { precision: parsed.precision, year: parsed.year, month: parsed.month, day: parsed.day };
      } catch (err) {
        problems.push(prob('invalid_date', `${at} 日期非法：${err.message}`, { claimId: id }));
      }
    }
    const sn = checkSourceNote(o, at);
    const patch = { id };
    if (datePatch) patch.date = datePatch;
    if ('source' in sn) patch.source = sn.source;
    if ('note' in sn) patch.note = sn.note;
    if (!patch.date && !('source' in patch) && !('note' in patch)) {
      problems.push(prob('empty_patch', `${at} 没有可更新字段（日期 / source / note 至少一项）`, { claimId: id }));
      return;
    }
    if (refDeleted) return; // 已报 ref_deleted_event，不进入有效暂存
    claimUpdateIds.add(id);
    norm.claims.update.push(patch);
  });

  // ---- 关系 ----
  const relUpdateIds = new Set();
  const relDeleteIds = new Set();

  raw.relations.create.forEach((o, i) => {
    const at = `relations.create[${i}]`;
    if (!isPlainObject(o)) { problems.push(prob('invalid_structure', `${at} 必须是对象`)); return; }
    if (!checkTempId(o.tempId, at)) return;
    // 自环最先判（即使端点同时在删除名单中，自环仍是无效输入，需一次性列出）
    const sameRaw =
      o.earlierId !== undefined && o.earlierId !== null &&
      o.earlierId === o.laterId;
    const earlier = resolveEventRef(o.earlierId, `${at} 的 earlierId`);
    const later = resolveEventRef(o.laterId, `${at} 的 laterId`);
    if (sameRaw) {
      problems.push(prob('self_relation', `${at}：一个事件不能先于自身`, { tempId: o.tempId }));
      return;
    }
    if (!earlier || !later) return;
    const sn = checkSourceNote(o, at);
    norm.relations.create.push({
      tempId: o.tempId,
      earlierId: earlier.value,
      laterId: later.value,
      source: typeof o.source === 'string' ? sn.source || '' : '',
      note: typeof o.note === 'string' ? sn.note || '' : '',
    });
  });

  raw.relations.delete.forEach((v, i) => {
    const at = `relations.delete[${i}]`;
    if (!isPosInt(v)) { problems.push(prob('invalid_id', `${at} 必须是基线中的正式关系 id（正整数）`)); return; }
    const b = baseRelById.get(v);
    if (!b) { problems.push(prob('unknown_relation', `${at}：关系 ${v} 不在会话基线中`, { relationId: v })); return; }
    if (eventDeleteIds.has(b.earlierId) || eventDeleteIds.has(b.laterId)) {
      problems.push(prob('redundant_op', `${at}：关系 ${v} 的端点事件已在本会话暂存删除（会随事件级联删除，无需单列关系删除）`, { relationId: v }));
      return;
    }
    if (relDeleteIds.has(v)) { problems.push(prob('duplicate_op', `${at}：关系 ${v} 重复列入删除`, { relationId: v })); return; }
    relDeleteIds.add(v);
    norm.relations.delete.push(v);
  });

  raw.relations.update.forEach((o, i) => {
    const at = `relations.update[${i}]`;
    if (!isPosInt(o && o.id)) { problems.push(prob('invalid_id', `${at} 必须含基线中的正式关系 id（正整数）`)); return; }
    const id = o.id;
    const b = baseRelById.get(id);
    if (!b) { problems.push(prob('unknown_relation', `${at}：关系 ${id} 不在会话基线中`, { relationId: id })); return; }
    if (eventDeleteIds.has(b.earlierId) || eventDeleteIds.has(b.laterId)) {
      problems.push(prob('ref_deleted_event', `${at}：关系 ${id} 的端点事件已在本会话暂存删除，不能再改关系`, { relationId: id }));
      return;
    }
    if (relDeleteIds.has(id)) { problems.push(prob('update_and_delete', `${at}：关系 ${id} 在本会话中既改又删，二选一`, { relationId: id })); return; }
    if (relUpdateIds.has(id)) { problems.push(prob('duplicate_op', `${at}：关系 ${id} 出现多条更新，请合并为一条`, { relationId: id })); return; }
    const patch = { id };
    if (o.source !== undefined) {
      if (typeof o.source !== 'string' || o.source.length > MAX.source) {
        problems.push(prob('invalid_source', `${at} 出处 source 必须是不超过 ${MAX.source} 字符的字符串`, { relationId: id }));
      } else patch.source = o.source;
    }
    if (o.note !== undefined) {
      if (typeof o.note !== 'string' || o.note.length > MAX.noteField) {
        problems.push(prob('invalid_note', `${at} note 必须是不超过 ${MAX.noteField} 字符的字符串`, { relationId: id }));
      } else patch.note = o.note;
    }
    if (!('source' in patch) && !('note' in patch)) {
      problems.push(prob('empty_patch', `${at} 没有可更新字段（source / note 至少一项；关系端点不可修改，请删旧建新）`, { relationId: id }));
      return;
    }
    relUpdateIds.add(id);
    norm.relations.update.push(patch);
  });

  return { problems, changes: norm };
}

// 提交事务内对规范暂存做纯语义再校验（日期 / 出处 / 自环 / 结构形状）。
// 引用是否仍存在、对象是否已被对方删除等「需要看当前草稿」的问题不在这里判，
// 交给 planMerge 产出逐项三方冲突（409），而不是 422 结构错误。
function validateStoredSemantics(changes) {
  const problems = [];
  if (!isPlainObject(changes)) return [prob('invalid_structure', '暂存结构损坏：根节点不是对象')];
  for (const g of ['events', 'claims', 'relations']) {
    const node = changes[g];
    if (!isPlainObject(node) || !Array.isArray(node.create) || !Array.isArray(node.update) || !Array.isArray(node.delete)) {
      problems.push(prob('invalid_structure', `暂存结构损坏：${g} 分组缺失或不是 {create,update,delete}`));
      return problems;
    }
  }
  const tempEvents = new Set(changes.events.create.map((e) => isPlainObject(e) && e.tempId).filter(Boolean));
  const checkRefShape = (ref, where) => {
    const r = asRef(ref);
    if (!r) { problems.push(prob('invalid_event_ref', `${where} 事件引用非法：${String(ref)}`)); return false; }
    // 字符串临时编号必须在本会话新建事件中（正式编号的存在性由 planMerge 判）
    if (r.kind === 'temp' && !tempEvents.has(r.value)) {
      problems.push(prob('unknown_temp_id', `${where} 引用了不存在的事件临时编号「${r.value}」`));
      return false;
    }
    return true;
  };
  for (const e of changes.events.create) {
    if (!isPlainObject(e) || typeof e.tempId !== 'string' || typeof e.title !== 'string' || e.title.trim() === '') {
      problems.push(prob('invalid_structure', '暂存结构损坏：events.create 项缺少 tempId 或 title'));
    }
  }
  for (const c of changes.claims.create) {
    if (!isPlainObject(c) || typeof c.tempId !== 'string') { problems.push(prob('invalid_structure', '暂存结构损坏：claims.create 项')); continue; }
    try {
      parseClaimDate(c.date);
      claimInterval(c.date.precision, c.date.year, c.date.month, c.date.day);
    } catch (err) {
      problems.push(prob('invalid_date', `主张「${c.tempId}」日期非法：${err.message}`));
    }
    checkRefShape(c.eventId, `主张「${c.tempId}」`);
    if (typeof c.source !== 'string' || c.source.trim() === '') problems.push(prob('invalid_source', `主张「${c.tempId}」缺少出处`));
  }
  for (const p of changes.claims.update) {
    if (p && p.date) {
      try {
        parseClaimDate(p.date);
        claimInterval(p.date.precision, p.date.year, p.date.month, p.date.day);
      } catch (err) {
        problems.push(prob('invalid_date', `主张 ${p.id} 日期非法：${err.message}`));
      }
    }
    if (p && 'source' in p && (typeof p.source !== 'string' || p.source.trim() === '')) {
      problems.push(prob('invalid_source', `主张 ${p.id} 出处非法`));
    }
  }
  for (const r of changes.relations.create) {
    if (!isPlainObject(r) || typeof r.tempId !== 'string') { problems.push(prob('invalid_structure', '暂存结构损坏：relations.create 项')); continue; }
    const a = checkRefShape(r.earlierId, `关系「${r.tempId}」起点`);
    const b = checkRefShape(r.laterId, `关系「${r.tempId}」终点`);
    if (a && b && r.earlierId === r.laterId) problems.push(prob('self_relation', `关系「${r.tempId}」自环`));
  }
  return problems;
}

function stageChanges(id, input) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM edit_sessions WHERE id = ?').get(id);
  if (!row) throw { status: 404, message: `编辑会话 ${id} 不存在` };
  if (row.status !== 'open') {
    throw {
      status: 409,
      code: 'SESSION_NOT_OPEN',
      message: `编辑会话 ${id} 当前状态为 ${row.status}，不能再修改暂存；请基于最新草稿开启新会话。`,
      sessionNo: id,
      statusNow: row.status,
    };
  }
  const baseline = JSON.parse(row.baseline_json);
  const { problems, changes } = normalizeChanges(input, baseline);
  if (problems.length) {
    throw {
      status: 422,
      code: 'SESSION_CHANGESET_INVALID',
      message: `暂存修改有 ${problems.length} 处问题，整组未保存（会话保持打开，可修正后重新暂存）`,
      sessionNo: id,
      problems,
    };
  }
  db.prepare('UPDATE edit_sessions SET changes_json = ? WHERE id = ?').run(JSON.stringify(changes), id);
  return getSession(id);
}

// 事件引用解析：正整数 = 基线正式事件；字符串 = 本会话新建事件临时编号
function asRef(value) {
  if (isPosInt(value)) return { kind: 'id', value };
  if (typeof value === 'string' && value.trim() !== '' && value.length <= MAX.tempId) {
    return { kind: 'temp', value };
  }
  return null;
}

// 主张日期字段 → 展示与区间（工作副本展示用）
function dateMeta(d) {
  const iv = claimInterval(d.precision, d.year, d.month, d.day);
  return {
    precision: d.precision,
    year: d.year,
    month: d.month,
    day: d.day,
    dateLabel: formatClaimDate(d.precision, d.year, d.month, d.day),
    intervalStart: iv.start,
    intervalEnd: iv.end,
  };
}
function workingCopy(baseline, changes) {
  const events = [];
  const deletedEvents = new Set(changes.events.delete);
  const eventPatchById = new Map(changes.events.update.map((p) => [p.id, p]));
  const tempEventIds = new Set(changes.events.create.map((e) => e.tempId));

  for (const ev of baseline.events) {
    if (deletedEvents.has(ev.id)) continue;
    const patch = eventPatchById.get(ev.id) || {};
    const deletedClaims = new Set(changes.claims.delete);
    const claimPatchById = new Map(changes.claims.update.map((p) => [p.id, p]));
    const claims = [];
    for (const c of ev.claims) {
      if (deletedClaims.has(c.id)) continue;
      const cp = claimPatchById.get(c.id);
      if (!cp) { claims.push(c); continue; }
      // 日期是整体字段：改了日期就要重算精度/年月日/标签/区间，避免展示残留旧标签
      const dm = cp.date ? dateMeta(cp.date) : {};
      claims.push({
        ...c,
        ...(cp.date ? dm : {}),
        ...('source' in cp ? { source: cp.source } : {}),
        ...('note' in cp ? { note: cp.note } : {}),
      });
    }
    // 本会话新建的主张（挂在正式事件上）
    for (const c of changes.claims.create) {
      if (isPosInt(c.eventId) && c.eventId === ev.id) {
        claims.push(stagedClaimApi(c, ev.id));
      }
    }
    claims.sort((a, b) => (a.id || Number.MAX_SAFE_INTEGER) - (b.id || Number.MAX_SAFE_INTEGER));
    events.push({
      id: ev.id,
      tempId: null,
      title: patch.title !== undefined ? patch.title : ev.title,
      description: patch.description !== undefined ? patch.description : ev.description,
      claims,
    });
  }
  for (const cr of changes.events.create) {
    const claims = changes.claims.create
      .filter((c) => typeof c.eventId === 'string' && c.eventId === cr.tempId)
      .map((c) => stagedClaimApi(c, null, cr.tempId));
    events.push({ id: null, tempId: cr.tempId, title: cr.title, description: cr.description, claims });
  }

  const deletedRels = new Set(changes.relations.delete);
  const relPatchById = new Map(changes.relations.update.map((p) => [p.id, p]));
  const relations = [];
  for (const r of baseline.relations) {
    if (deletedRels.has(r.id)) continue;
    if (deletedEvents.has(r.earlierId) || deletedEvents.has(r.laterId)) continue;
    const patch = relPatchById.get(r.id) || {};
    relations.push({
      id: r.id,
      tempId: null,
      earlierId: r.earlierId,
      laterId: r.laterId,
      source: patch.source !== undefined ? patch.source : r.source,
      note: patch.note !== undefined ? patch.note : r.note,
    });
  }
  for (const cr of changes.relations.create) {
    relations.push({
      id: null,
      tempId: cr.tempId,
      earlierId: isPosInt(cr.earlierId) ? cr.earlierId : null,
      laterId: isPosInt(cr.laterId) ? cr.laterId : null,
      earlierTempId: typeof cr.earlierId === 'string' ? cr.earlierId : null,
      laterTempId: typeof cr.laterId === 'string' ? cr.laterId : null,
      source: cr.source,
      note: cr.note,
    });
  }
  return {
    events,
    relations,
    tempEventIds: [...tempEventIds],
    counts: {
      eventCount: events.length,
      claimCount: events.reduce((n, e) => n + e.claims.length, 0),
      relationCount: relations.length,
    },
  };
}

function stagedClaimApi(c, eventId, eventTempId = null) {
  return {
    id: null,
    tempId: c.tempId,
    eventId: typeof c.eventId === 'number' ? eventId : null,
    eventTempId: typeof c.eventId === 'string' ? c.eventId : eventTempId,
    ...dateMeta(c.date),
    source: c.source,
    note: c.note,
  };
}

// ---------- 三方合并规划（纯函数；逐项收集全部冲突） ----------
function conflict(type, message, extra) {
  return { type, message, ...extra };
}

function planMerge(baseline, changes, current) {
  const conflicts = [];
  const ops = {
    deleteRelations: [],
    deleteClaims: [],
    deleteEvents: [],
    insertEvents: [],
    updateEvents: new Map(),
    insertClaims: [],
    updateClaims: new Map(),
    insertRelations: [],
    updateRelations: new Map(),
  };

  const curEventById = new Map(current.events.map((e) => [e.id, e]));
  const curClaimById = new Map();
  current.events.forEach((e) => e.claims.forEach((c) => curClaimById.set(c.id, c)));
  const curRelById = new Map(current.relations.map((r) => [r.id, r]));
  const baseEventById = new Map(baseline.events.map((e) => [e.id, e]));
  const baseClaimById = new Map();
  baseline.events.forEach((e) => e.claims.forEach((c) => baseClaimById.set(c.id, c)));
  const baseRelById = new Map(baseline.relations.map((r) => [r.id, r]));

  const EVENT_FIELDS = ['title', 'description'];

  // ---- 事件删除 ----
  const eventDeleteBlocked = new Set();
  for (const id of changes.events.delete) {
    const b = baseEventById.get(id);
    const c = curEventById.get(id);
    if (!c) continue; // 对方也删了 → 自动合并（no-op）
    let blocked = false;
    // 编辑与删除相撞：事件字段被对方改过
    for (const f of EVENT_FIELDS) {
      if (b[f] !== c[f]) {
        blocked = true;
        conflicts.push(conflict('delete_edit_conflict',
          `你在会话中删除事件「${b.title}」（#${id}），但对方修改了其字段 ${f}：整次提交已拒绝，未删除任何内容。`,
          { entity: 'event', id, field: f, baseline: b[f], current: c[f], proposed: null }));
      }
    }
    // 对方在该事件下新增了主张 → 删除会连带销毁对方的新对象
    const baseClaimIds = new Set(b.claims.map((x) => x.id));
    for (const cc of c.claims) {
      if (!baseClaimIds.has(cc.id)) {
        blocked = true;
        conflicts.push(conflict('delete_destroys_new_claim',
          `你删除事件「${b.title}」（#${id}），但对方在该事件下新增了主张 #${cc.id}（${cc.dateLabel}，出处：${cc.source || '未注明'}）：删除会销毁对方的新增，整次提交已拒绝。`,
          { entity: 'claim', id: cc.id, eventId: id, baseline: null, current: cc, proposed: null }));
      }
    }
    // 对方新增了以该事件为端点的关系
    const incidentBase = new Set(baseline.relations.filter((r) => r.earlierId === id || r.laterId === id).map((r) => r.id));
    for (const cr of current.relations) {
      if ((cr.earlierId === id || cr.laterId === id) && !incidentBase.has(cr.id)) {
        blocked = true;
        conflicts.push(conflict('delete_destroys_new_relation',
          `你删除事件「${b.title}」（#${id}），但对方新增了以它为端点的先于关系 #${cr.id}：删除会连带删除对方的新关系，整次提交已拒绝。`,
          { entity: 'relation', id: cr.id, eventId: id, baseline: null, current: cr, proposed: null }));
      }
    }
    if (blocked) eventDeleteBlocked.add(id);
    else ops.deleteEvents.push(id);
  }

  // ---- 事件更新：逐字段三方合并 ----
  for (const patch of changes.events.update) {
    const id = patch.id;
    const b = baseEventById.get(id);
    const c = curEventById.get(id);
    const fields = {};
    if (!c) {
      for (const f of EVENT_FIELDS) {
        if (f in patch) {
          conflicts.push(conflict('edit_delete_conflict',
            `你修改事件 #${id} 的字段 ${f}，但该事件已被对方删除：整次提交已拒绝。`,
            { entity: 'event', id, field: f, baseline: b[f], current: null, proposed: patch[f] }));
        }
      }
      continue;
    }
    for (const f of EVENT_FIELDS) {
      if (!(f in patch)) continue;
      if (c[f] !== b[f] && c[f] !== patch[f]) {
        conflicts.push(conflict('field_conflict',
          `事件「${c.title}」（#${id}）的字段 ${f} 被双方改成了不同值：整次提交已拒绝，请人工重编。`,
          { entity: 'event', id, field: f, baseline: b[f], current: c[f], proposed: patch[f] }));
      } else {
        fields[f] = patch[f];
      }
    }
    if (Object.keys(fields).length) ops.updateEvents.set(id, { id, ...fields });
  }

  // ---- 事件新建：本会话新建事件总是插入（编号在提交后映射） ----
  for (const ev of changes.events.create) ops.insertEvents.push(ev);

  // ---- 主张删除 ----
  for (const id of changes.claims.delete) {
    const b = baseClaimById.get(id);
    const c = curClaimById.get(id);
    if (!c) continue; // 已被对方显式删除或随事件级联删除 → 自动合并
    if (canonDate(b) !== canonDate(c)) {
      conflicts.push(conflict('delete_edit_conflict',
        `你删除主张 #${id}（${b.dateLabel}），但对方修改了其日期：整次提交已拒绝。`,
        { entity: 'claim', id, field: 'date', baseline: { precision: b.precision, year: b.year, month: b.month, day: b.day }, current: { precision: c.precision, year: c.year, month: c.month, day: c.day }, proposed: null }));
    }
    for (const f of ['source', 'note']) {
      if (b[f] !== c[f]) {
        conflicts.push(conflict('delete_edit_conflict',
          `你删除主张 #${id}（${b.dateLabel}），但对方修改了其字段 ${f}：整次提交已拒绝。`,
          { entity: 'claim', id, field: f, baseline: b[f], current: c[f], proposed: null }));
      }
    }
    if (!conflicts.some((x) => x.entity === 'claim' && x.id === id)) ops.deleteClaims.push(id);
  }

  // ---- 主张更新 ----
  for (const patch of changes.claims.update) {
    const id = patch.id;
    const b = baseClaimById.get(id);
    const c = curClaimById.get(id);
    if (!c) {
      const eventAlive = curEventById.has(b.eventId);
      conflicts.push(conflict(eventAlive ? 'edit_delete_conflict' : 'parent_event_deleted',
        eventAlive
          ? `你修改主张 #${id}，但该主张已被对方删除：整次提交已拒绝。`
          : `你修改主张 #${id}，但它所属的事件 #${b.eventId} 已被对方删除：整次提交已拒绝。`,
        {
          entity: 'claim', id,
          baseline: { precision: b.precision, year: b.year, month: b.month, day: b.day, source: b.source, note: b.note },
          current: null,
          proposed: { ...(patch.date || {}), ...('source' in patch ? { source: patch.source } : {}), ...('note' in patch ? { note: patch.note } : {}) },
        }));
      continue;
    }
    const fields = {};
    if (patch.date) {
      const proposed = canonDate({ ...patch.date });
      if (canonDate(c) !== canonDate(b) && canonDate(c) !== proposed) {
        conflicts.push(conflict('field_conflict',
          `主张 #${id} 的日期被双方改成了不同值：整次提交已拒绝，请人工重编。`,
          { entity: 'claim', id, field: 'date', baseline: { precision: b.precision, year: b.year, month: b.month, day: b.day }, current: { precision: c.precision, year: c.year, month: c.month, day: c.day }, proposed: patch.date }));
      } else fields.date = patch.date;
    }
    for (const f of ['source', 'note']) {
      if (!(f in patch)) continue;
      if (c[f] !== b[f] && c[f] !== patch[f]) {
        conflicts.push(conflict('field_conflict',
          `主张 #${id} 的字段 ${f} 被双方改成了不同值：整次提交已拒绝，请人工重编。`,
          { entity: 'claim', id, field: f, baseline: b[f], current: c[f], proposed: patch[f] }));
      } else fields[f] = patch[f];
    }
    ops.updateClaims.set(id, { id, ...fields });
  }

  // ---- 主张新建：所属事件被对方删除则拒绝 ----
  for (const cr of changes.claims.create) {
    if (typeof cr.eventId === 'string') {
      ops.insertClaims.push(cr); // 本会话新建事件，必在
    } else if (!curEventById.has(cr.eventId)) {
      const b = baseEventById.get(cr.eventId);
      conflicts.push(conflict('parent_event_deleted',
        `你在会话中给事件 #${cr.eventId} 新增主张（临时编号「${cr.tempId}」），但该事件已被对方删除：整次提交已拒绝。`,
        { entity: 'claim', tempId: cr.tempId, eventId: cr.eventId, baseline: b ? { id: b.id, title: b.title } : null, current: null, proposed: { tempId: cr.tempId, date: cr.date, source: cr.source, note: cr.note } }));
    } else {
      ops.insertClaims.push(cr);
    }
  }

  // ---- 关系删除 ----
  for (const id of changes.relations.delete) {
    const b = baseRelById.get(id);
    const c = curRelById.get(id);
    if (!c) continue; // 对方显式删除或随端点级联 → 自动合并
    for (const f of ['source', 'note']) {
      if (b[f] !== c[f]) {
        conflicts.push(conflict('delete_edit_conflict',
          `你删除先于关系 #${id}，但对方修改了其字段 ${f}：整次提交已拒绝。`,
          { entity: 'relation', id, field: f, baseline: b[f], current: c[f], proposed: null }));
      }
    }
    if (!conflicts.some((x) => x.entity === 'relation' && x.id === id)) ops.deleteRelations.push(id);
  }

  // ---- 关系更新：端点被对方删除整次拒绝；关系被显式删 → 编辑与删除相撞 ----
  for (const patch of changes.relations.update) {
    const id = patch.id;
    const b = baseRelById.get(id);
    const c = curRelById.get(id);
    if (!c) {
      const missingEndpoints = [b.earlierId, b.laterId].filter((eid) => !curEventById.has(eid));
      if (missingEndpoints.length) {
        conflicts.push(conflict('relation_endpoint_deleted',
          `你修改先于关系 #${id}（事件 #${b.earlierId} → #${b.laterId}），但其端点事件 ${missingEndpoints.map((x) => `#${x}`).join('、')} 已被对方删除：整次提交已拒绝。`,
          { entity: 'relation', id, endpointEventIds: missingEndpoints, baseline: b, current: null, proposed: { source: patch.source, note: patch.note } }));
      } else {
        conflicts.push(conflict('edit_delete_conflict',
          `你修改先于关系 #${id}，但该关系已被对方删除：整次提交已拒绝。`,
          { entity: 'relation', id, baseline: b, current: null, proposed: { ...('source' in patch ? { source: patch.source } : {}), ...('note' in patch ? { note: patch.note } : {}) } }));
      }
      continue;
    }
    const fields = {};
    for (const f of ['source', 'note']) {
      if (!(f in patch)) continue;
      if (c[f] !== b[f] && c[f] !== patch[f]) {
        conflicts.push(conflict('field_conflict',
          `先于关系 #${id} 的字段 ${f} 被双方改成了不同值：整次提交已拒绝，请人工重编。`,
          { entity: 'relation', id, field: f, baseline: b[f], current: c[f], proposed: patch[f] }));
      } else fields[f] = patch[f];
    }
    ops.updateRelations.set(id, { id, ...fields });
  }

  // ---- 关系新建：端点（正式事件）被对方删除整次拒绝 ----
  for (const cr of changes.relations.create) {
    const missing = [];
    for (const [role, ref] of [['earlierId', cr.earlierId], ['laterId', cr.laterId]]) {
      if (isPosInt(ref) && !curEventById.has(ref)) missing.push({ role, eventId: ref });
    }
    if (missing.length) {
      conflicts.push(conflict('relation_endpoint_deleted',
        `你在会话中新建先于关系（临时编号「${cr.tempId}」），但其端点事件 ${missing.map((m) => `#${m.eventId}`).join('、')} 已被对方删除：整次提交已拒绝。`,
        { entity: 'relation', tempId: cr.tempId, missingEndpoints: missing, baseline: null, current: null, proposed: { tempId: cr.tempId, earlierId: cr.earlierId, laterId: cr.laterId, source: cr.source, note: cr.note } }));
      continue;
    }
    ops.insertRelations.push(cr);
  }

  return { conflicts, ops };
}

// ---------- 在事务内应用无冲突计划 ----------
function executePlan(db, ops) {
  const idMap = { events: [], claims: [], relations: [] };

  // 1) 先删关系，再删主张，最后删事件（同时也依赖外键级联兜底）
  for (const id of ops.deleteRelations) db.prepare('DELETE FROM relations WHERE id = ?').run(id);
  for (const id of ops.deleteClaims) db.prepare('DELETE FROM claims WHERE id = ?').run(id);
  for (const id of ops.deleteEvents) db.prepare('DELETE FROM events WHERE id = ?').run(id);

  // 2) 新建事件 → 临时编号映射
  const eventIdByTemp = new Map();
  const insEvent = db.prepare('INSERT INTO events (title, description) VALUES (?, ?)');
  for (const ev of ops.insertEvents) {
    const newId = insEvent.run(ev.title, ev.description).lastInsertRowid;
    eventIdByTemp.set(ev.tempId, newId);
    idMap.events.push({ tempId: ev.tempId, eventId: newId });
  }

  // 3) 事件字段更新
  const updEvent = db.prepare("UPDATE events SET title = COALESCE(?, title), description = COALESCE(?, description), updated_at = datetime('now') WHERE id = ?");
  for (const p of ops.updateEvents.values()) {
    updEvent.run(p.title === undefined ? null : p.title, p.description === undefined ? null : p.description, p.id);
  }

  // 4) 新建主张
  const insClaim = db.prepare(`
    INSERT INTO claims (event_id, precision, year, month, day, date_label, interval_start, interval_end, source, note)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const resolveEventId = (ref) => (typeof ref === 'string' ? eventIdByTemp.get(ref) : ref);
  for (const c of ops.insertClaims) {
    const eventId = resolveEventId(c.eventId);
    const iv = claimInterval(c.date.precision, c.date.year, c.date.month, c.date.day);
    const newId = insClaim.run(
      eventId, c.date.precision, c.date.year, c.date.month, c.date.day,
      formatClaimDate(c.date.precision, c.date.year, c.date.month, c.date.day),
      iv.start, iv.end, c.source, c.note
    ).lastInsertRowid;
    idMap.claims.push({
      tempId: c.tempId,
      claimId: newId,
      eventId,
      ...(typeof c.eventId === 'string' ? { eventTempId: c.eventId } : {}),
    });
  }

  // 5) 主张字段更新（日期作为一个整体字段覆盖；month/day 列可为 NULL，不能用 COALESCE）
  const updClaim = db.prepare(`
    UPDATE claims SET
      precision = ?, year = ?, month = ?, day = ?, date_label = ?,
      interval_start = ?, interval_end = ?, source = ?, note = ?
    WHERE id = ?
  `);
  for (const p of ops.updateClaims.values()) {
    const d = p.date || null;
    const cur = db.prepare('SELECT * FROM claims WHERE id = ?').get(p.id);
    const date = d
      ? { ...d, label: formatClaimDate(d.precision, d.year, d.month, d.day), ...claimInterval(d.precision, d.year, d.month, d.day) }
      : { precision: cur.precision, year: cur.year, month: cur.month, day: cur.day, label: cur.date_label, start: cur.interval_start, end: cur.interval_end };
    updClaim.run(
      date.precision, date.year, date.month, date.day, date.label, date.start, date.end,
      'source' in p ? p.source : cur.source,
      'note' in p ? p.note : cur.note,
      p.id
    );
  }

  // 6) 新建关系
  const insRel = db.prepare('INSERT INTO relations (earlier_id, later_id, source, note) VALUES (?, ?, ?, ?)');
  for (const r of ops.insertRelations) {
    const earlierId = resolveEventId(r.earlierId);
    const laterId = resolveEventId(r.laterId);
    const newId = insRel.run(earlierId, laterId, r.source, r.note).lastInsertRowid;
    idMap.relations.push({
      tempId: r.tempId,
      relationId: newId,
      earlierId,
      laterId,
      ...(typeof r.earlierId === 'string' ? { earlierTempId: r.earlierId } : {}),
      ...(typeof r.laterId === 'string' ? { laterTempId: r.laterId } : {}),
    });
  }

  // 7) 关系字段更新
  const updRel = db.prepare("UPDATE relations SET source = COALESCE(?, source), note = COALESCE(?, note) WHERE id = ?");
  for (const p of ops.updateRelations.values()) {
    updRel.run('source' in p ? p.source : null, 'note' in p ? p.note : null, p.id);
  }

  return idMap;
}

// ---------- 提交：单事务三方合并 + 原子应用 ----------
function commitSession(id, { commitKey } = {}) {
  const db = getDb();
  const key = typeof commitKey === 'string' && commitKey.trim() !== '' ? commitKey.trim().slice(0, 200) : crypto.randomUUID();

  const tx = db.transaction(() => {
    const row = db.prepare('SELECT * FROM edit_sessions WHERE id = ?').get(id);
    if (!row) throw { status: 404, message: `编辑会话 ${id} 不存在` };

    // 重放：同一提交（网络重试 / 重复点击）直接返回首次结果，绝不重复写入
    if (row.status === 'committed') {
      return { replayed: true, committed: JSON.parse(row.result_json) };
    }
    if (row.status === 'conflict') {
      const conflicts = JSON.parse(row.conflicts_json);
      // 冲突重放同样返回逐项冲突，但标记 replayed，且不再翻状态、不写草稿
      return {
        replayed: true,
        conflict: {
          sessionNo: id,
          baselineRevisionNo: row.baseline_revision,
          currentRevisionNo: draftRevisionNo(),
          conflicts,
        },
      };
    }
    if (row.status === 'abandoned') {
      throw { status: 409, code: 'SESSION_NOT_OPEN', message: `编辑会话 ${id} 已放弃，不能提交；请基于最新草稿开启新会话。`, sessionNo: id, statusNow: 'abandoned' };
    }

    // 三方合并始终以「会话原始基线 + 原始暂存 + 当前草稿」进行，不做重定基线：
    // 已被对方删除的对象（含随事件级联删除的主张 / 关系）由 planMerge 逐项判为
    // 自动合并（双方都删）或冲突（编辑与删除相撞），不能提前丢弃暂存操作。
    const baseline = JSON.parse(row.baseline_json);
    const storedChanges = JSON.parse(row.changes_json);
    // 对规范暂存做纯语义再校验（日期 / 出处 / 自环 / 结构形状）；
    // 引用是否仍存在、对象是否已被删除等需要看当前草稿的问题交给 planMerge 报冲突。
    const problems = validateStoredSemantics(storedChanges, baseline);
    if (problems.length) {
      throw { status: 422, code: 'SESSION_CHANGESET_INVALID', message: '暂存修改未通过校验', sessionNo: id, problems };
    }
    const changes = storedChanges;
    const isEmpty =
      changes.events.create.length + changes.events.update.length + changes.events.delete.length +
      changes.claims.create.length + changes.claims.update.length + changes.claims.delete.length +
      changes.relations.create.length + changes.relations.update.length + changes.relations.delete.length === 0;
    if (isEmpty) throw { status: 400, message: '暂存为空，没有可提交的修改' };

    const revisionBefore = draftRevisionNo();
    const current = snapshotDraft(db);
    const { conflicts, ops } = planMerge(baseline, changes, current);

    if (conflicts.length) {
      // 整次拒绝：不写草稿，只把会话置为 conflict（只读），保留逐项冲突供人工重编
      const payload = {
        sessionNo: id,
        baselineRevisionNo: row.baseline_revision,
        currentRevisionNo: revisionBefore,
        conflicts,
      };
      // conflicts_json 只存逐项冲突数组；版本号等随提交响应即时给出
      db.prepare(
        `UPDATE edit_sessions SET status = 'conflict', conflicts_json = ?, commit_key = COALESCE(commit_key, ?)
         WHERE id = ?`
      ).run(JSON.stringify(conflicts), key, id);
      return { conflict: payload, replayed: false };
    }

    const idMap = executePlan(db, ops);

    // 每条增删改都触发了修订号自增；整次会话提交作为一次原子变更，
    // 修订号校正为提交前的值 + 1（与恢复 / 导入同一约定）。
    db.prepare('UPDATE draft_meta SET revision = ? WHERE id = 1').run(revisionBefore + 1);

    const result = {
      sessionNo: id,
      revisionNo: revisionBefore + 1,
      baselineRevisionNo: row.baseline_revision,
      merged: revisionBefore !== row.baseline_revision,
      idMap,
    };
    db.prepare(
      `UPDATE edit_sessions
         SET status = 'committed', result_json = ?, commit_key = COALESCE(commit_key, ?), committed_at = datetime('now')
       WHERE id = ?`
    ).run(JSON.stringify(result), key, id);
    return { committed: result, replayed: false };
  });

  const out = tx();
  if (out.conflict) {
    throw {
      status: 409,
      code: 'SESSION_MERGE_CONFLICT',
      message: `三方合并发现 ${out.conflict.conflicts.length} 处冲突，整次提交已拒绝，草稿未做任何改动。请基于最新草稿重开编辑会话后人工重编。`,
      ...out.conflict,
      replayed: out.replayed,
    };
  }
  return { ok: true, replayed: out.replayed, ...out.committed };
}

module.exports = {
  STATUSES,
  snapshotDraft,
  emptyChanges,
  workingCopy,
  openSession,
  getSession,
  listSessions,
  stageChanges,
  commitSession,
  abandonSession,
  normalizeChanges,
  planMerge,
};
