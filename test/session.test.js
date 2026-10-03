'use strict';

const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert');
process.env.EDITOR_TOKEN = 'test-token';
const Database = require('better-sqlite3');

const mem = new Database(':memory:');
const { SCHEMA, setDb, getDb } = require('../src/db');
mem.exec(SCHEMA);
setDb(mem);

const { app } = require('../src/server');
const { draftRevisionNo } = require('../src/restore');

const TOKEN = 'test-token';
let base;
let server;

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  mem.close();
});

beforeEach(() => {
  mem.exec(`
    DELETE FROM edit_sessions;
    DELETE FROM version_relations;
    DELETE FROM version_events;
    DELETE FROM versions;
    DELETE FROM relations;
    DELETE FROM claims;
    DELETE FROM events;
    DELETE FROM sqlite_sequence;
    UPDATE draft_meta SET revision = 0 WHERE id = 1;
  `);
});
async function call(method, url, { token = TOKEN, body } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'X-Editor-Token': token } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

async function makeEvent(title, description = '') {
  const r = await call('POST', '/api/editor/events', { body: { title, description } });
  assert.strictEqual(r.status, 201);
  return r.json.event.id;
}
async function makeClaim(eventId, payload) {
  const r = await call('POST', `/api/editor/events/${eventId}/claims`, { body: payload });
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));
  return r.json.claim.id;
}
async function makeRel(earlierId, laterId, source = '') {
  const r = await call('POST', '/api/editor/relations', { body: { earlierId, laterId, source } });
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));
  return r.json.relation.id;
}

const dayClaim = (year, month, day, source = 's') => ({ precision: 'day', year, month, day, source });
const yearClaim = (year, source = 's') => ({ precision: 'year', year, source });

async function openSession(body = {}) {
  const r = await call('POST', '/api/editor/sessions', { body });
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));
  return r.json.session;
}
async function stage(no, changes) {
  return call('PUT', `/api/editor/sessions/${no}/changes`, { body: { changes } });
}
async function commit(no, body = {}) {
  return call('POST', `/api/editor/sessions/${no}/commit`, { body });
}

// ---------- 权限与基线 ----------

test('会话接口需要编辑口令；访客公开接口看不到任何会话内容', async () => {
  assert.strictEqual((await call('POST', '/api/editor/sessions', { token: null, body: {} })).status, 401);
  assert.strictEqual((await call('GET', '/api/editor/sessions', { token: null })).status, 401);
  assert.strictEqual((await call('GET', '/api/editor/sessions/1', { token: null })).status, 401);
  const s = await openSession();
  assert.strictEqual((await call('GET', `/api/editor/sessions/${s.sessionNo}`, { token: 'wrong' })).status, 401);
  // 公开接口无会话相关字段
  const chron = await call('GET', '/api/public/chronicle', { token: null });
  assert.strictEqual(chron.status, 200);
  assert.ok(!('sessions' in chron.json));
});

test('开启会话冻结草稿与修订号；暂存期间草稿不变、修订号不变', async () => {
  const e1 = await makeEvent('动员会');
  const c1 = await makeClaim(e1, yearClaim(1958));
  const revBefore = draftRevisionNo();
  const s = await openSession({ editor: '甲', note: '整理冬修' });
  assert.strictEqual(s.status, 'open');
  assert.strictEqual(s.baselineRevisionNo, revBefore);
  assert.deepStrictEqual(s.baseline.events[0].id, e1);
  assert.deepStrictEqual(s.baseline.counts, { eventCount: 1, claimCount: 1, relationCount: 0 });

  const r = await stage(s.sessionNo, {
    events: { create: [{ tempId: 't1', title: '通水会', description: '' }], update: [], delete: [] },
    claims: { create: [{ tempId: 'x1', eventId: 't1', ...yearClaim(1959) }], update: [], delete: [] },
    relations: { create: [], update: [], delete: [] },
  });
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  assert.strictEqual(r.json.session.working.counts.eventCount, 2);
  // 暂存不写草稿
  const st = await call('GET', '/api/editor/state');
  assert.strictEqual(st.json.events.length, 1);
  assert.strictEqual(st.json.draftRevisionNo, revBefore);
  assert.ok(c1 > 0);
});

// ---------- 自动合并 ----------

test('双方互不触碰的对象/字段自动合并，原子应用并返回临时→正式编号映射', async () => {
  const e1 = await makeEvent('甲事件', '描述1');
  const e2 = await makeEvent('乙事件', '描述2');
  const c1 = await makeClaim(e1, yearClaim(1958, '出处1'));
  const r1 = await makeRel(e1, e2, '关系出处');

  const sA = await openSession({ editor: '甲' });
  // 甲暂存：改 e1 标题、给 e1 新增主张、新建事件 T 及其主张、新建关系 T→e2
  const staged = await stage(sA.sessionNo, {
    events: { create: [{ tempId: 'T', title: '丙事件', description: '丙描述' }], update: [{ id: e1, title: '甲事件改' }], delete: [] },
    claims: {
      create: [{ tempId: 'CT', eventId: 'T', ...dayClaim(1960, 1, 1, '新出处') }],
      update: [{ id: c1, note: '甲加注' }],
      delete: [],
    },
    relations: { create: [{ tempId: 'RT', earlierId: 'T', laterId: e2, source: '新关系出处' }], update: [{ id: r1, note: '关系注' }], delete: [] },
  });
  assert.strictEqual(staged.status, 200, JSON.stringify(staged.json));

  // 乙并行直接改草稿：只动 e2（标题）与 e1 的 description（甲只动 title）
  await call('PUT', `/api/editor/events/${e2}`, { body: { title: '乙事件改', description: '描述2' } });
  const revBeforeCommit = draftRevisionNo();

  const ok = await commit(sA.sessionNo, { commitKey: 'k1' });
  assert.strictEqual(ok.status, 201, JSON.stringify(ok.json));
  assert.strictEqual(ok.json.revisionNo, revBeforeCommit + 1); // 整次提交只推进一次修订号
  assert.strictEqual(ok.json.merged, true);
  const map = ok.json.idMap;
  assert.deepStrictEqual(map.events, [{ tempId: 'T', eventId: e2 + 1 }]);
  assert.deepStrictEqual(map.claims[0].claimId, c1 + 1);
  assert.strictEqual(map.claims[0].eventId, e2 + 1);
  assert.strictEqual(map.claims[0].eventTempId, 'T');
  assert.deepStrictEqual(map.relations[0].relationId, r1 + 1);

  // 合并结果：甲的标题 + 乙的描述；乙的 e2 标题保留
  const st = await call('GET', '/api/editor/state');
  const ev1 = st.json.events.find((e) => e.id === e1);
  assert.strictEqual(ev1.title, '甲事件改');
  assert.strictEqual(ev1.description, '描述1');
  const ev2 = st.json.events.find((e) => e.id === e2);
  assert.strictEqual(ev2.title, '乙事件改');
  const evT = st.json.events.find((e) => e.title === '丙事件');
  assert.ok(evT);
  assert.deepStrictEqual(evT.claims.map((c) => [c.source, c.precision]), [['新出处', 'day']]);
  const relNew = st.json.relations.find((r) => r.earlierId === evT.id && r.laterId === e2);
  assert.strictEqual(relNew.source, '新关系出处');
});

test('双方改成相同值也自动合并；无任何并发改动时 merged=false', async () => {
  const e1 = await makeEvent('同题');
  const sA = await openSession();
  await stage(sA.sessionNo, {
    events: { create: [], update: [{ id: e1, title: '同题' }], delete: [] },
    claims: { create: [], update: [], delete: [] },
    relations: { create: [], update: [], delete: [] },
  });
  const ok = await commit(sA.sessionNo);
  assert.strictEqual(ok.status, 201);
  assert.strictEqual(ok.json.merged, false);
});

// ---------- 删除合并 ----------

test('删除方与另一方新增/修改互不相关时自动合并；双方都删同一对象自动合并', async () => {
  const e1 = await makeEvent('留');
  const e2 = await makeEvent('删');
  const e3 = await makeEvent('乙删');
  await makeClaim(e1, yearClaim(1958));
  await makeClaim(e2, yearClaim(1959));
  await makeClaim(e3, yearClaim(1960));

  const sA = await openSession({ editor: '甲' });
  // 甲删 e2；乙删 e3（互不相关）
  await call('DELETE', `/api/editor/events/${e3}`);
  const r = await stage(sA.sessionNo, {
    events: { create: [], update: [], delete: [e2] },
    claims: { create: [], update: [], delete: [] },
    relations: { create: [], update: [], delete: [] },
  });
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  const ok = await commit(sA.sessionNo);
  assert.strictEqual(ok.status, 201, JSON.stringify(ok.json));
  const st = await call('GET', '/api/editor/state');
  assert.deepStrictEqual(st.json.events.map((e) => e.id).sort(), [e1]);
});

// ---------- 冲突 ----------

test('同一字段双方改成不同值 → 整次拒绝，逐项列 baseline/current/proposed，草稿不被覆盖', async () => {
  const e1 = await makeEvent('原标题', '原描述');
  const c1 = await makeClaim(e1, yearClaim(1958, '原出处'));
  const sA = await openSession({ editor: '甲' });

  await stage(sA.sessionNo, {
    events: { create: [], update: [{ id: e1, title: '甲标题' }], delete: [] },
    claims: { create: [], update: [{ id: c1, source: '甲出处' }], delete: [] },
    relations: { create: [], update: [], delete: [] },
  });
  // 乙把事件标题与主张出处都改成不同值
  await call('PUT', `/api/editor/events/${e1}`, { body: { title: '乙标题', description: '原描述' } });
  await call('PUT', `/api/editor/claims/${c1}`, { body: { precision: 'year', year: 1958, source: '乙出处' } });
  const revAtConflict = draftRevisionNo();
  const r = await commit(sA.sessionNo);
  assert.strictEqual(r.status, 409, JSON.stringify(r.json));
  assert.strictEqual(r.json.code, 'SESSION_MERGE_CONFLICT');
  assert.strictEqual(r.json.currentRevisionNo, revAtConflict);
  const types = r.json.conflicts.map((x) => `${x.entity}:${x.field}:${x.type}`);
  assert.ok(types.includes('event:title:field_conflict'));
  assert.ok(types.includes('claim:source:field_conflict'));
  const evConf = r.json.conflicts.find((x) => x.entity === 'event' && x.field === 'title');
  assert.strictEqual(evConf.baseline, '原标题');
  assert.strictEqual(evConf.current, '乙标题');
  assert.strictEqual(evConf.proposed, '甲标题');

  // 整次拒绝：草稿保持乙的状态，甲的任何暂存都没有落库
  const st = await call('GET', '/api/editor/state');
  const ev = st.json.events.find((x) => x.id === e1);
  assert.strictEqual(ev.title, '乙标题');
  assert.strictEqual(ev.claims[0].source, '乙出处');
  assert.strictEqual(st.json.draftRevisionNo, revAtConflict);

  // 会话置 conflict 只读：再提交是同一冲突重放，再暂存 409
  const detail = await call('GET', `/api/editor/sessions/${sA.sessionNo}`);
  assert.strictEqual(detail.json.session.status, 'conflict');
  assert.ok(detail.json.session.conflicts.length >= 2);
  const replay = await commit(sA.sessionNo);
  assert.strictEqual(replay.status, 409);
  assert.strictEqual(replay.json.replayed, true);
  assert.strictEqual(replay.json.conflicts.length, r.json.conflicts.length);
  const restage = await stage(sA.sessionNo, {
    events: { create: [], update: [{ id: e1, title: '甲标题' }], delete: [] },
    claims: { create: [], update: [], delete: [] },
    relations: { create: [], update: [], delete: [] },
  });
  assert.strictEqual(restage.status, 409);
  assert.strictEqual(restage.json.code, 'SESSION_NOT_OPEN');
});

test('编辑与删除相撞（事件/主张/关系）→ 整次拒绝', async () => {
  const e1 = await makeEvent('甲');
  const e2 = await makeEvent('乙');
  const c1 = await makeClaim(e1, yearClaim(1958, 's1'));
  const rel = await makeRel(e1, e2, 'rs');

  const sA = await openSession({ editor: '甲' });
  await stage(sA.sessionNo, {
    events: { create: [], update: [{ id: e1, title: '甲改' }], delete: [] },
    claims: { create: [], update: [{ id: c1, source: 's2' }], delete: [] },
    relations: { create: [], update: [{ id: rel, source: 'rs2' }], delete: [] },
  });
  // 乙删除事件 e1（级联删主张与关系）
  await call('DELETE', `/api/editor/events/${e1}`);
  const r = await commit(sA.sessionNo);
  assert.strictEqual(r.status, 409, JSON.stringify(r.json));
  const entities = r.json.conflicts.map((x) => x.entity);
  assert.ok(entities.includes('event'));
  assert.ok(entities.includes('claim'));
  assert.ok(entities.includes('relation'));
  // 关系冲突类型：端点已删除
  assert.ok(r.json.conflicts.some((x) => x.entity === 'relation' && x.type === 'relation_endpoint_deleted'));
  // 事件编辑冲突：current 为 null
  assert.ok(r.json.conflicts.some((x) => x.entity === 'event' && x.current === null));
});

test('删除方遇对方在对象下新增主张/关系 → 拒绝（不销毁对方改动）', async () => {
  const e1 = await makeEvent('被删');
  const e2 = await makeEvent('端点');
  await makeClaim(e1, yearClaim(1958));
  const sA = await openSession({ editor: '甲' });
  await stage(sA.sessionNo, {
    events: { create: [], update: [], delete: [e1] },
    claims: { create: [], update: [], delete: [] },
    relations: { create: [], update: [], delete: [] },
  });
  // 乙给 e1 新增主张、新增 e2→e1 关系
  const cNew = await makeClaim(e1, yearClaim(1961, '乙新主张'));
  const rNew = await makeRel(e2, e1, '乙新关系');
  const r = await commit(sA.sessionNo);
  assert.strictEqual(r.status, 409);
  assert.ok(r.json.conflicts.some((x) => x.type === 'delete_destroys_new_claim' && x.id === cNew));
  assert.ok(r.json.conflicts.some((x) => x.type === 'delete_destroys_new_relation' && x.id === rNew));
  const st = await call('GET', '/api/editor/state');
  assert.ok(st.json.events.some((e) => e.id === e1));
});

test('拟新建/修改关系的端点事件已被对方删除 → 整次拒绝', async () => {
  const e1 = await makeEvent('甲');
  const e2 = await makeEvent('乙');
  const rel = await makeRel(e1, e2, 'r');
  const sA = await openSession();
  await stage(sA.sessionNo, {
    events: { create: [{ tempId: 'T', title: '新', description: '' }], update: [], delete: [] },
    claims: { create: [], update: [], delete: [] },
    relations: {
      create: [{ tempId: 'R1', earlierId: 'T', laterId: e2 }],
      update: [{ id: rel, note: '改注' }],
      delete: [],
    },
  });
  // 乙删除 e2：新关系的端点 + 旧关系端点都没了
  await call('DELETE', `/api/editor/events/${e2}`);
  const r = await commit(sA.sessionNo);
  assert.strictEqual(r.status, 409);
  assert.ok(r.json.conflicts.some((x) => x.entity === 'relation' && x.type === 'relation_endpoint_deleted'));
  // 事件 T 也没有插入（整次原子拒绝）
  const st = await call('GET', '/api/editor/state');
  assert.ok(!st.json.events.some((e) => e.title === '新'));
});

test('拟新建主张所属事件已被对方删除 → 整次拒绝', async () => {
  const e1 = await makeEvent('甲');
  const sA = await openSession();
  await stage(sA.sessionNo, {
    events: { create: [], update: [], delete: [] },
    claims: { create: [{ tempId: 'C1', eventId: e1, ...yearClaim(1970, '新') }], update: [], delete: [] },
    relations: { create: [], update: [], delete: [] },
  });
  await call('DELETE', `/api/editor/events/${e1}`);
  const r = await commit(sA.sessionNo);
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.json.conflicts[0].type, 'parent_event_deleted');
});

// ---------- 幂等 ----------

test('重试同一提交不重复写入（同会话重放 200）；放弃幂等', async () => {
  const e1 = await makeEvent('甲');
  const sA = await openSession();
  await stage(sA.sessionNo, {
    events: { create: [{ tempId: 'T', title: '新', description: '' }], update: [], delete: [] },
    claims: { create: [], update: [], delete: [] },
    relations: { create: [], update: [], delete: [] },
  });
  const first = await commit(sA.sessionNo, { commitKey: 'abc' });
  assert.strictEqual(first.status, 201);
  const rev1 = first.json.revisionNo;
  const second = await commit(sA.sessionNo, { commitKey: 'abc' });
  assert.strictEqual(second.status, 200);
  assert.strictEqual(second.json.replayed, true);
  assert.strictEqual(second.json.revisionNo, rev1);
  // 没有第二个「新」事件
  const st = await call('GET', '/api/editor/state');
  assert.strictEqual(st.json.events.filter((e) => e.title === '新').length, 1);
  assert.strictEqual(st.json.draftRevisionNo, rev1);

  // 已提交会话不能放弃
  const noAbort = await call('DELETE', `/api/editor/sessions/${sA.sessionNo}`);
  assert.strictEqual(noAbort.status, 409);

  // 放弃：打开的会话可放弃，重复放弃幂等
  const sB = await openSession();
  const a1 = await call('DELETE', `/api/editor/sessions/${sB.sessionNo}`);
  assert.strictEqual(a1.status, 200);
  const a2 = await call('DELETE', `/api/editor/sessions/${sB.sessionNo}`);
  assert.strictEqual(a2.status, 200);
  assert.strictEqual(a2.json.alreadyAbandoned, true);
  // 已放弃不能提交 / 暂存
  assert.strictEqual((await commit(sB.sessionNo)).status, 409);
});

test('空暂存提交 → 400；会话不存在 → 404', async () => {
  const sA = await openSession();
  const r = await commit(sA.sessionNo);
  assert.strictEqual(r.status, 400);
  assert.strictEqual((await call('GET', '/api/editor/sessions/9999')).status, 404);
});

// ---------- 暂存校验 ----------

test('暂存语义问题一次性列出（422）且不保存：日期/出处/引用/自环/既改又删/未知编号', async () => {
  const e1 = await makeEvent('甲');
  const c1 = await makeClaim(e1, yearClaim(1958, 's'));
  const sA = await openSession();
  const r = await stage(sA.sessionNo, {
    events: {
      create: [{ tempId: '', title: '无编号' }],
      update: [{ id: 9999, title: '幽灵' }, { id: e1, title: '' }],
      delete: [e1],
    },
    claims: {
      create: [
        { tempId: 'cbad', eventId: e1, precision: 'day', year: 1958, month: 2, day: 30, source: '坏日期' },
        { tempId: 'cnosrc', eventId: 'ghost', precision: 'year', year: 1958, source: '引用幽灵' },
      ],
      update: [{ id: c1 }],
      delete: [8888],
    },
    relations: {
      create: [{ tempId: 'r1', earlierId: e1, laterId: e1 }],
      update: [{ id: 7777, source: 'x' }],
      delete: [],
    },
  });
  assert.strictEqual(r.status, 422);
  assert.strictEqual(r.json.code, 'SESSION_CHANGESET_INVALID');
  const types = r.json.problems.map((p) => p.type);
  for (const t of ['invalid_temp_id', 'unknown_event', 'invalid_date', 'unknown_temp_id', 'update_and_delete', 'invalid_title', 'unknown_claim', 'self_relation', 'unknown_relation', 'empty_patch']) {
    assert.ok(types.includes(t), `缺少问题类型 ${t}：${JSON.stringify(types)}`);
  }
  // 未保存：会话工作副本仍是空基线
  const detail = await call('GET', `/api/editor/sessions/${sA.sessionNo}`);
  assert.strictEqual(detail.json.session.working.counts.eventCount, 1);
  assert.strictEqual(detail.json.session.status, 'open');
});

test('结构错误（400）：changes 分组缺失 / 编号非整数', async () => {
  const sA = await openSession();
  const r1 = await call('PUT', `/api/editor/sessions/${sA.sessionNo}/changes`, { body: { changes: {} } });
  assert.strictEqual(r1.status, 400);
  const r2 = await stage(sA.sessionNo, { events: { create: [], update: [], delete: ['x'] }, claims: { create: [], update: [], delete: [] }, relations: { create: [], update: [], delete: [] } });
  assert.strictEqual(r2.status, 422); // 结构在、值语义错 → 422
});

test('主张改日期走整体字段：工作副本标签/区间随日期重算，对方未碰该主张时自动合并', async () => {
  const e1 = await makeEvent('甲');
  const c1 = await makeClaim(e1, yearClaim(1958, 's1'));
  const sA = await openSession();
  // 乙并行给另一个无关事件加内容（制造修订号变化），甲改主张日期
  const e2 = await makeEvent('乙的事件');
  const r = await stage(sA.sessionNo, {
    events: { create: [], update: [], delete: [] },
    claims: {
      create: [],
      update: [{ id: c1, precision: 'month', year: 1958, month: 3 }],
      delete: [],
    },
    relations: { create: [], update: [], delete: [] },
  });
  assert.strictEqual(r.status, 200);
  const wc = r.json.session.working.events.find((e) => e.id === e1).claims[0];
  assert.strictEqual(wc.precision, 'month');
  assert.strictEqual(wc.dateLabel, '1958 年 03 月');
  assert.strictEqual(wc.intervalStart, '1958-03-01');
  assert.strictEqual(wc.intervalEnd, '1958-03-31');
  const ok = await commit(sA.sessionNo);
  assert.strictEqual(ok.status, 201, JSON.stringify(ok.json));
  assert.strictEqual(ok.json.merged, true);
  const st = await call('GET', '/api/editor/state');
  const claim = st.json.events.find((e) => e.id === e1).claims[0];
  assert.strictEqual(claim.precision, 'month');
  assert.strictEqual(claim.month, 3);
  assert.strictEqual(claim.day, null);
  assert.strictEqual(claim.dateLabel, '1958 年 03 月');
  // 乙的无关事件也在
  assert.ok(st.json.events.some((e) => e.id === e2));
});

test('既有发布校验（日期/出处/关系求解）在会话提交后的草稿上保持有效', async () => {
  const e1 = await makeEvent('冬月');
  const e2 = await makeEvent('春月');
  await makeClaim(e1, yearClaim(1958));
  await makeClaim(e2, yearClaim(1958));
  const sA = await openSession();
  // 会话中把冬月改 12 月、春月改 1 月并建先于关系 → 合并后发布校验应报 temporal 无解
  await stage(sA.sessionNo, {
    events: { create: [], update: [], delete: [] },
    claims: {
      create: [],
      update: [
        { id: 1, precision: 'month', year: 1958, month: 12 },
        { id: 2, precision: 'month', year: 1958, month: 1 },
      ],
      delete: [],
    },
    relations: { create: [{ tempId: 'r', earlierId: e1, laterId: e2 }], update: [], delete: [] },
  });
  const ok = await commit(sA.sessionNo);
  assert.strictEqual(ok.status, 201, JSON.stringify(ok.json));
  const st = await call('GET', '/api/editor/state');
  const sel = st.json.events.map((e) => ({ eventId: e.id, claimId: e.claims[0].id }));
  const v = await call('POST', '/api/editor/validate', { body: { selection: sel } });
  assert.strictEqual(v.status, 200);
  assert.strictEqual(v.json.ok, false);
  assert.strictEqual(v.json.errors[0].type, 'temporal');
});
