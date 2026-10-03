'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ============ 草稿区（编辑者可随时修改） ============
CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 同一事件可保留多条互相矛盾的时间主张；发布时只选一条
CREATE TABLE IF NOT EXISTS claims (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id    INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  precision   TEXT NOT NULL CHECK (precision IN ('year','month','day')),
  year        INTEGER NOT NULL,
  month       INTEGER,
  day         INTEGER,
  date_label  TEXT NOT NULL,                 -- 供展示：如「1958 年 03 月」
  interval_start TEXT NOT NULL,             -- ISO，覆盖区间起点
  interval_end   TEXT NOT NULL,             -- ISO，覆盖区间终点
  source      TEXT NOT NULL DEFAULT '',     -- 出处（受访人/档案/页码）
  note        TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_claims_event ON claims(event_id);

-- earlier 必须严格先于 later
CREATE TABLE IF NOT EXISTS relations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  earlier_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  later_id   INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  source     TEXT NOT NULL DEFAULT '',
  note       TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (earlier_id <> later_id)
);
CREATE INDEX IF NOT EXISTS idx_rel_earlier ON relations(earlier_id);
CREATE INDEX IF NOT EXISTS idx_rel_later ON relations(later_id);

-- ============ 草稿修订号（恢复草稿时的乐观并发控制） ============
-- 草稿区 events/claims/relations 的任何增删改都由触发器推进 revision；
-- 「预览恢复」与「确认恢复」之间草稿若被改过，确认即报冲突、不改数据。
CREATE TABLE IF NOT EXISTS draft_meta (
  id       INTEGER PRIMARY KEY CHECK (id = 1),
  revision INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO draft_meta (id, revision) VALUES (1, 0);

CREATE TRIGGER IF NOT EXISTS trg_events_rev_ai AFTER INSERT ON events
BEGIN UPDATE draft_meta SET revision = revision + 1 WHERE id = 1; END;
CREATE TRIGGER IF NOT EXISTS trg_events_rev_au AFTER UPDATE ON events
BEGIN UPDATE draft_meta SET revision = revision + 1 WHERE id = 1; END;
CREATE TRIGGER IF NOT EXISTS trg_events_rev_ad AFTER DELETE ON events
BEGIN UPDATE draft_meta SET revision = revision + 1 WHERE id = 1; END;
CREATE TRIGGER IF NOT EXISTS trg_claims_rev_ai AFTER INSERT ON claims
BEGIN UPDATE draft_meta SET revision = revision + 1 WHERE id = 1; END;
CREATE TRIGGER IF NOT EXISTS trg_claims_rev_au AFTER UPDATE ON claims
BEGIN UPDATE draft_meta SET revision = revision + 1 WHERE id = 1; END;
CREATE TRIGGER IF NOT EXISTS trg_claims_rev_ad AFTER DELETE ON claims
BEGIN UPDATE draft_meta SET revision = revision + 1 WHERE id = 1; END;
CREATE TRIGGER IF NOT EXISTS trg_relations_rev_ai AFTER INSERT ON relations
BEGIN UPDATE draft_meta SET revision = revision + 1 WHERE id = 1; END;
CREATE TRIGGER IF NOT EXISTS trg_relations_rev_au AFTER UPDATE ON relations
BEGIN UPDATE draft_meta SET revision = revision + 1 WHERE id = 1; END;
CREATE TRIGGER IF NOT EXISTS trg_relations_rev_ad AFTER DELETE ON relations
BEGIN UPDATE draft_meta SET revision = revision + 1 WHERE id = 1; END;

-- ============ 采访整理包导入批次 ============
-- 记录每一次成功导入的批次标识与内容指纹；同一 batch_id 只允许成功导入一次，
-- 失败的确认（冲突回滚）不留记录，可修正后重试。
CREATE TABLE IF NOT EXISTS import_batches (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id       TEXT NOT NULL UNIQUE,
  fingerprint    TEXT NOT NULL,
  event_count    INTEGER NOT NULL,
  claim_count    INTEGER NOT NULL,
  relation_count INTEGER NOT NULL,
  imported_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============ 发布区（不可变版本快照） ============
CREATE TABLE IF NOT EXISTS versions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  version_no   INTEGER NOT NULL UNIQUE,
  parent_no    INTEGER,                      -- 从哪个版本发起（0 表示首次）
  editor       TEXT NOT NULL DEFAULT '',
  note         TEXT NOT NULL DEFAULT '',
  published_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS version_events (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  version_id        INTEGER NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
  event_id          INTEGER NOT NULL,       -- 草稿事件 id（版本内不可变，仅作溯源）
  title             TEXT NOT NULL,
  description       TEXT NOT NULL DEFAULT '',
  claim_id          INTEGER NOT NULL,
  precision         TEXT NOT NULL,
  date_label        TEXT NOT NULL,
  interval_start    TEXT NOT NULL,
  interval_end      TEXT NOT NULL,
  resolved_date     TEXT NOT NULL,          -- 求解出的具体日 ISO
  source            TEXT NOT NULL DEFAULT '',
  claim_note        TEXT NOT NULL DEFAULT '',
  sort_order        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ve_version ON version_events(version_id);

CREATE TABLE IF NOT EXISTS version_relations (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  version_id   INTEGER NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
  relation_id  INTEGER NOT NULL,
  earlier_event_id INTEGER NOT NULL,
  later_event_id   INTEGER NOT NULL,
  source       TEXT NOT NULL DEFAULT '',
  note         TEXT NOT NULL DEFAULT '',
  sort_order   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_vr_version ON version_relations(version_id);

-- ============ 出处遮盖（编辑者按出处原文撤回公开展示） ============
-- 只追加登记「被遮盖的精确出处文本」：确认后不改写任何历史快照或草稿，
-- 公开接口读出时动态把命中位置的 source 显示为统一的「出处已遮盖」。
-- 持编辑口令的版本详情、从版本恢复草稿仍使用快照原文；
-- 以后新发布的快照只要 source 精确等于登记文本，公开读出同样自动遮盖。
-- 同一文本只登记一次（重复确认幂等返回已遮盖状态）；该表与草稿修订号无关。
CREATE TABLE IF NOT EXISTS source_redactions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  source_text TEXT NOT NULL UNIQUE,             -- 精确出处原文（精确相等才命中）
  editor      TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============ 预约发布（编辑者指定未来 UTC 时间自动生成不可变版本） ============
-- 建立预约时即把当时的草稿内容冻结进本行：事件、每事件所选主张、「先于」关系、
-- 求解日期与当前最新版本号（base_version_no）。此后草稿的任何修改 / 恢复都与本预约无关。
-- 到期由调度器按 (scheduled_at, id) 顺序在各自事务内处理：
--   pending   —— 尚未执行；仅该状态可被编辑者取消；
--   published —— 到期且冻结基准版本号仍等于当前最新版本号，已生成不可变新版本 result_version_no；
--   conflict  —— 到期时基准版本号已落后（期间另有发布），不发布、不改基准，冻结内容保留供查看；
--   cancelled —— 编辑者在到期前取消。
-- 重启 / 重复触发只处理 pending 行；版本写入与状态翻转在同一事务内，杜绝重复发布与半版。
CREATE TABLE IF NOT EXISTS publish_schedules (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,   -- 预约号
  scheduled_at       TEXT NOT NULL,                       -- 到期 UTC 时刻（YYYY-MM-DDTHH:mm:ssZ，等宽可字典序比较）
  status             TEXT NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending','published','conflict','cancelled')),
  base_version_no    INTEGER NOT NULL,                    -- 冻结的当前最新版本号（0 表示尚无版本）
  draft_revision_no  INTEGER NOT NULL,                    -- 预约时草稿修订号（仅溯源）
  selection_json     TEXT NOT NULL,                       -- 冻结：每事件所选主张 [{eventId,claimId}]
  payload_json       TEXT NOT NULL,                       -- 冻结：完整待发布快照（事件/主张/关系/求解日期）
  event_count        INTEGER NOT NULL,
  relation_count     INTEGER NOT NULL,
  editor             TEXT NOT NULL DEFAULT '',
  note               TEXT NOT NULL DEFAULT '',
  result_version_no  INTEGER,                             -- published：生成的新版本号
  result_message     TEXT NOT NULL DEFAULT '',            -- conflict 等执行结果说明
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  attempted_at       TEXT,                                -- 到期执行时刻（UTC ISO）
  cancelled_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_schedules_due
  ON publish_schedules(status, scheduled_at);

-- ============ 版本撤回（编辑者按版本号撤回整版公开展示） ============
-- 只追加审计记录：确认撤回后不改写任何历史快照（versions / version_events /
-- version_relations 原样保留），版本号也不复用；访客读出层动态隐藏撤回版
-- （最新年表指向编号最大的未撤回版，撤回版详情与引用它的路线按不存在处理），
-- 持编辑口令的接口仍可见撤回版原文与撤回原因。
-- 同一版本至多一条记录（UNIQUE）：重复撤回返回首次记录，不覆盖原因。
CREATE TABLE IF NOT EXISTS version_retractions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  version_no   INTEGER NOT NULL UNIQUE,         -- 被撤回的已发布版本号
  reason       TEXT NOT NULL,                   -- 非空撤回原因（编年依据错误说明）
  editor       TEXT NOT NULL DEFAULT '',
  retracted_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============ 专题「先于」脉络路线（不可变，只追加） ============
-- 编辑者从一份已发布年表挑选至少两个互异事件作为锚点（有序），
-- 相邻锚点之间必须在该版「先于」关系图中存在有向路径；
-- 建立时即把所据版本号、锚点顺序与每段见证链（关系数最少、同长度按关系 ID
-- 序列择小）整体冻结进下列各表。此后修改草稿、恢复草稿、发布新版都不改写旧路线。
CREATE TABLE IF NOT EXISTS routes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,   -- 路线号
  title       TEXT NOT NULL,                       -- 专题标题
  version_no  INTEGER NOT NULL,                    -- 所据已发布版本号
  editor      TEXT NOT NULL DEFAULT '',
  note        TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS route_anchors (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  route_id  INTEGER NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
  event_id  INTEGER NOT NULL,                      -- 该版快照中的事件 id
  position  INTEGER NOT NULL                       -- 锚点顺序（0 起）
);
CREATE INDEX IF NOT EXISTS idx_route_anchors_route ON route_anchors(route_id);

-- 每段见证链：连接 anchors[position] 与 anchors[position+1] 的最少有向路径
CREATE TABLE IF NOT EXISTS route_segments (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  route_id          INTEGER NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
  position          INTEGER NOT NULL,              -- 段序号（0 起）
  from_event_id     INTEGER NOT NULL,
  to_event_id       INTEGER NOT NULL,
  event_ids_json    TEXT NOT NULL,                 -- 链上事件 id 序列（含两端锚点与中间事件）
  relation_ids_json TEXT NOT NULL                  -- 链上关系 id 序列（该版快照 relation_id）
);
CREATE INDEX IF NOT EXISTS idx_route_segments_route ON route_segments(route_id);
`;

let db;

function getDb() {
  if (db) return db;
  const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'chronicle.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}

// 测试时可注入独立数据库
function setDb(instance) {
  db = instance;
}

module.exports = { getDb, setDb, SCHEMA };
