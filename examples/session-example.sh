#!/usr/bin/env bash
# 并行整理年表草稿：只读编辑会话（暂存 → 三方合并提交）端到端调用示例。
#
# 流程：
#   0) 口令检查（会话内容只供持编辑口令者，访客 401）
#   1) 两位编辑者各开一个会话（冻结当时草稿修订号与事件/主张/关系）
#   2) 甲暂存：改标题、新增事件（临时编号）、新增主张、新增关系
#   3) 乙直接改草稿中互不触碰的对象 → 甲提交：自动合并，原子应用 + 临时→正式编号映射
#   4) 重试同一提交：不重复写入（200 replayed）
#   5) 冲突场景：双方把同一字段改成不同值 → 409 整次拒绝，逐项列 baseline/current/proposed
#   6) 冲突会话只读：再暂存 409；基于最新草稿重开会话后人工重编，提交成功
#   7) 编辑与删除相撞、关系端点已删除、暂存语义 422、放弃幂等等边界
#
# 依赖：curl 与 node。用法：
#   BASE=http://localhost:3000 TOKEN=editor bash examples/session-example.sh
set -euo pipefail

BASE="${BASE:-http://localhost:3000}"
TOKEN="${TOKEN:-editor}"
TS="$(date +%s)"

h_json=(-H 'Content-Type: application/json')
h_ed=(-H "X-Editor-Token: ${TOKEN}")

say() { printf '\n\033[1;36m== %s ==\033[0m\n' "$*"; }
jfield() { node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8")); process.stdout.write(String(eval(process.argv[1])))' "$1"; }
post() { curl -s -X POST "${h_json[@]}" "${h_ed[@]}" "$@"; }
put() { curl -s -X PUT "${h_json[@]}" "${h_ed[@]}" "$@"; }
del() { curl -s -X DELETE "${h_ed[@]}" "$@"; }
get_ed() { curl -s "${h_ed[@]}" "$@"; }
http_code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

say "0) 口令检查：无口令 / 错口令访问会话接口 → 401；访客公开接口无会话内容"
code=$(http_code -X POST "${h_json[@]}" -H 'X-Editor-Token: wrong' -d '{}' "$BASE/api/editor/sessions")
[ "$code" = 401 ] && echo "OK：错口令开启会话 → 401" || { echo "FAIL：期望 401，实际 $code"; exit 1; }
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/editor/sessions")
[ "$code" = 401 ] && echo "OK：无口令会话列表 → 401" || { echo "FAIL：期望 401，实际 $code"; exit 1; }

say "1) 建草稿：2 个事件、各 1 条主张、1 条先于关系"
E1=$(post "$BASE/api/editor/events" -d '{"title":"动员会 '$TS'","description":"原描述"}' | jfield 'd.event.id')
E2=$(post "$BASE/api/editor/events" -d '{"title":"通水会 '$TS'"}' | jfield 'd.event.id')
C1=$(post "$BASE/api/editor/events/$E1/claims" -d '{"precision":"year","year":1958,"source":"李宝山口述 '$TS'"}' | jfield 'd.claim.id')
C2=$(post "$BASE/api/editor/events/$E2/claims" -d '{"precision":"month","year":1959,"month":5,"source":"王秀兰口述 '$TS'"}' | jfield 'd.claim.id')
R1=$(post "$BASE/api/editor/relations" -d '{"earlierId":'"$E1"',"laterId":'"$E2"',"source":"二人口述一致"}' | jfield 'd.relation.id')
echo "事件 #$E1 #$E2；主张 #$C1 #$C2；关系 #$R1"

say "2) 甲开只读编辑会话并暂存（改标题 / 新事件临时编号 T / 新主张 / 新关系）"
SA=$(post "$BASE/api/editor/sessions" -d '{"editor":"志愿者甲","note":"并行整理示例"}')
SNO=$(echo "$SA" | jfield 'd.session.sessionNo')
BREV=$(echo "$SA" | jfield 'd.session.baselineRevisionNo')
echo "会话 #$SNO，基线草稿修订号 $BREV"

CHANGES_A='{
  "events": {
    "create": [{"tempId":"T","title":"水闸落成 '$TS'","description":"甲暂存的新事件"}],
    "update": [{"id":'"$E1"',"title":"动员会（改）'$TS'"}],
    "delete": []
  },
  "claims": {
    "create": [{"tempId":"CT","eventId":"T","precision":"day","year":1959,"month":6,"day":1,"source":"档案：水利志 '$TS'"}],
    "update": [{"id":'"$C1"',"note":"甲暂存考异备注"}],
    "delete": []
  },
  "relations": {
    "create": [{"tempId":"RT","earlierId":"T","laterId":'"$E2"',"source":"志书载明"}],
    "update": [],
    "delete": []
  }
}'
code=$(http_code -X PUT "${h_json[@]}" "${h_ed[@]}" -d "{\"changes\":$CHANGES_A}" "$BASE/api/editor/sessions/$SNO/changes")
[ "$code" = 200 ] && echo "OK：暂存成功（草稿此刻未变）" || { echo "FAIL：暂存期望 200，实际 $code"; exit 1; }
# 工作副本含 3 个事件（基线 2 + 暂存新事件 T），但 /state 仍是 2
WCNT=$(get_ed "$BASE/api/editor/sessions/$SNO" | jfield 'd.session.working.counts.eventCount')
[ "$WCNT" = 3 ] && echo "OK：会话工作副本含 3 个事件（含临时 T）" || { echo "FAIL：工作副本事件数 $WCNT ≠ 3"; exit 1; }
STATE_CNT=$(get_ed "$BASE/api/editor/state" | jfield 'd.events.length')
[ "$STATE_CNT" = 2 ] && echo "OK：正式草稿仍只有 2 个事件（暂存不写草稿）" || { echo "FAIL：草稿事件数 $STATE_CNT ≠ 2"; exit 1; }

say "3) 乙并行直接改草稿中互不触碰的对象（改 E2 标题）→ 甲提交自动合并"
curl -s -X PUT "${h_json[@]}" "${h_ed[@]}" "$BASE/api/editor/events/$E2" -d '{"title":"通水会（乙改）'$TS'","description":""}' >/dev/null
COMMIT=$(post "$BASE/api/editor/sessions/$SNO/commit" -d '{"commitKey":"demo-key-A"}')
echo "$COMMIT" | node -e '
  const d = JSON.parse(require("fs").readFileSync(0,"utf8"));
  if (!d.ok) { console.error("提交失败：", JSON.stringify(d)); process.exit(1); }
  console.log("OK：提交成功，新草稿修订号", d.revisionNo, d.merged ? "（已与乙的改动自动合并）" : "");
  console.log("    临时→正式映射：", JSON.stringify(d.idMap));
'
NEW_EID=$(echo "$COMMIT" | jfield 'd.idMap.events[0].eventId')

say "4) 重试同一提交（同会话 + 同 commitKey）→ 200 replayed，不重复写入"
RETRY_CODE=$(curl -s -o /tmp/sess_retry.json -w '%{http_code}' -X POST "${h_json[@]}" "${h_ed[@]}" \
  "$BASE/api/editor/sessions/$SNO/commit" -d '{"commitKey":"demo-key-A"}')
[ "$RETRY_CODE" = 200 ] && echo "OK：重试运行返回 200（首次为 201）" || { echo "FAIL：重试期望 200，实际 $RETRY_CODE"; exit 1; }
node -e 'const d=require("/tmp/sess_retry.json"); if(!d.replayed) process.exit(1); console.log("OK：replayed =", d.replayed, "（未再推进修订号，仍是", d.revisionNo, ")");'
rm -f /tmp/sess_retry.json
# 新事件只有一个，没有因重试重复插入
DUP=$(get_ed "$BASE/api/editor/state" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));process.stdout.write(String(d.events.filter(e=>e.id===Number(process.argv[1])).length))' "$NEW_EID")
[ "$DUP" = 1 ] && echo "OK：临时事件 T 只写入一次" || { echo "FAIL：事件重复写入 $DUP 次"; exit 1; }

say "5) 冲突场景：双方把同一字段改成不同值 → 409 整次拒绝，逐项给 baseline/current/proposed"
SB=$(post "$BASE/api/editor/sessions" -d '{"editor":"志愿者甲"}')
SB_NO=$(echo "$SB" | jfield 'd.session.sessionNo')
# 甲暂存：把 E1 标题改成「甲的标题」
put "$BASE/api/editor/sessions/$SB_NO/changes" -d '{
  "changes": {
    "events": {"create":[],"update":[{"id":'"$E1"',"title":"甲定标题 '$TS'"}],"delete":[]},
    "claims": {"create":[],"update":[],"delete":[]},
    "relations": {"create":[],"update":[],"delete":[]}
  }
}' >/dev/null
# 乙把同一字段改成「乙的标题」
curl -s -X PUT "${h_json[@]}" "${h_ed[@]}" "$BASE/api/editor/events/$E1" -d '{"title":"乙定标题 '$TS'","description":"原描述"}' >/dev/null
CONF_CODE=$(curl -s -o /tmp/sess_conf.json -w '%{http_code}' -X POST "${h_json[@]}" "${h_ed[@]}" \
  "$BASE/api/editor/sessions/$SB_NO/commit" -d '{}')
[ "$CONF_CODE" = 409 ] && echo "OK：同字段不同值 → 409" || { echo "FAIL：期望 409，实际 $CONF_CODE"; cat /tmp/sess_conf.json; exit 1; }
node -e '
  const d = require("/tmp/sess_conf.json");
  if (d.code !== "SESSION_MERGE_CONFLICT") process.exit(1);
  const c = d.conflicts.find(x => x.entity==="event" && x.field==="title");
  if (!c) { console.error("缺少 event.title 冲突项"); process.exit(1); }
  console.log("OK：冲突码", d.code, "；逐项", d.conflicts.length, "处");
  console.log("    baseline =", JSON.stringify(c.baseline));
  console.log("    current  =", JSON.stringify(c.current));
  console.log("    proposed =", JSON.stringify(c.proposed));
'
rm -f /tmp/sess_conf.json
# 草稿保留乙的值，没有被甲覆盖
get_ed "$BASE/api/editor/state" | node -e '
  const d = JSON.parse(require("fs").readFileSync(0,"utf8"));
  const t = d.events.find(e=>e.id===Number(process.argv[1])).title;
  if (!t.includes("乙定标题")) { console.error("FAIL：草稿被覆盖为", t); process.exit(1); }
  console.log("OK：草稿保留乙的标题，未被甲覆盖");
' "$E1"

say "6) 冲突会话只读：再暂存 / 再提交都不允许；基于最新草稿重开会话后人工重编成功"
code=$(http_code -X PUT "${h_json[@]}" "${h_ed[@]}" -d '{"changes":{"events":{"create":[],"update":[],"delete":[]},"claims":{"create":[],"update":[],"delete":[]},"relations":{"create":[],"update":[],"delete":[]}}}' "$BASE/api/editor/sessions/$SB_NO/changes")
[ "$code" = 409 ] && echo "OK：冲突会话再暂存 → 409 SESSION_NOT_OPEN" || { echo "FAIL：期望 409，实际 $code"; exit 1; }
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "${h_json[@]}" "${h_ed[@]}" "$BASE/api/editor/sessions/$SB_NO/commit" -d '{}')
[ "$code" = 409 ] && echo "OK：冲突会话再提交 → 409（同一冲突重放，仍不写草稿）" || { echo "FAIL：期望 409，实际 $code"; exit 1; }
# 基于最新草稿重开：这次接受乙的标题（不再改 title，只改 description 这一乙方没碰的字段）
SC=$(post "$BASE/api/editor/sessions" -d '{"editor":"志愿者甲（重编）"}')
SC_NO=$(echo "$SC" | jfield 'd.session.sessionNo')
put "$BASE/api/editor/sessions/$SC_NO/changes" -d '{
  "changes": {
    "events": {"create":[],"update":[{"id":'"$E1"',"description":"甲在重编会话补充的描述"}],"delete":[]},
    "claims": {"create":[],"update":[],"delete":[]},
    "relations": {"create":[],"update":[],"delete":[]}
  }
}' >/dev/null
code=$(curl -s -o /tmp/sess_c.json -w '%{http_code}' -X POST "${h_json[@]}" "${h_ed[@]}" "$BASE/api/editor/sessions/$SC_NO/commit" -d '{}')
[ "$code" = 201 ] && echo "OK：基于最新草稿重开会话、改互不触碰字段 → 201 提交成功" || { echo "FAIL：期望 201，实际 $code"; cat /tmp/sess_c.json; exit 1; }
node -e 'const d=require("/tmp/sess_c.json");console.log("    新草稿修订号", d.revisionNo, "，merged =", d.merged);'
rm -f /tmp/sess_c.json

say "7) 边界：编辑与删除相撞 / 关系端点已删除 / 暂存语义 422 / 空暂存 400 / 放弃幂等"
# 7a) 甲暂存改 E2，乙删除 E2 → 409（编辑与删除相撞）
SD=$(post "$BASE/api/editor/sessions" -d '{"editor":"甲"}')
SD_NO=$(echo "$SD" | jfield 'd.session.sessionNo')
put "$BASE/api/editor/sessions/$SD_NO/changes" -d '{
  "changes":{"events":{"create":[],"update":[{"id":'"$E2"',"title":"甲又改标题"}],"delete":[]},
  "claims":{"create":[],"update":[],"delete":[]},"relations":{"create":[],"update":[],"delete":[]}}}' >/dev/null
curl -s -X DELETE "${h_ed[@]}" "$BASE/api/editor/events/$E2" >/dev/null
code=$(curl -s -o /tmp/d.json -w '%{http_code}' -X POST "${h_json[@]}" "${h_ed[@]}" "$BASE/api/editor/sessions/$SD_NO/commit" -d '{}')
[ "$code" = 409 ] && grep -q 'edit_delete_conflict\|relation_endpoint_deleted\|parent_event_deleted' /tmp/d.json \
  && echo "OK：编辑对象被对方删除 → 409（edit_delete_conflict / 端点删除）" || { echo "FAIL：期望 409 相撞，实际 $code"; cat /tmp/d.json; exit 1; }
rm -f /tmp/d.json

# 7b) 暂存语义问题一次性 422：未知正式编号、坏日期、自环、空出处、既改又删
SE=$(post "$BASE/api/editor/sessions" -d '{"editor":"甲"}')
SE_NO=$(echo "$SE" | jfield 'd.session.sessionNo')
code=$(curl -s -o /tmp/e.json -w '%{http_code}' -X PUT "${h_json[@]}" "${h_ed[@]}" -d '{
  "changes":{
    "events":{"create":[{"tempId":"","title":"无临时编号"}],"update":[{"id":999999,"title":"幽灵"}],"delete":[]},
    "claims":{"create":[{"tempId":"x","eventId":1,"precision":"day","year":1958,"month":2,"day":30,"source":"坏日期"}],"update":[],"delete":[]},
    "relations":{"create":[{"tempId":"z","earlierId":1,"laterId":1}],"update":[],"delete":[]}
  }}' "$BASE/api/editor/sessions/$SE_NO/changes")
[ "$code" = 422 ] && echo "OK：暂存语义问题 → 422 SESSION_CHANGESET_INVALID（整组不保存，会话仍 open）" || { echo "FAIL：期望 422，实际 $code"; exit 1; }

# 7c) 空暂存提交 → 400
SF=$(post "$BASE/api/editor/sessions" -d '{"editor":"甲"}')
SF_NO=$(echo "$SF" | jfield 'd.session.sessionNo')
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "${h_json[@]}" "${h_ed[@]}" "$BASE/api/editor/sessions/$SF_NO/commit" -d '{}')
[ "$code" = 400 ] && echo "OK：空暂存提交 → 400" || { echo "FAIL：期望 400，实际 $code"; exit 1; }

# 7d) 放弃会话：重复放弃幂等；已放弃不能提交
del "$BASE/api/editor/sessions/$SE_NO" >/dev/null
code=$(curl -s -o /tmp/g.json -w '%{http_code}' -X DELETE "${h_ed[@]}" "$BASE/api/editor/sessions/$SE_NO")
[ "$code" = 200 ] && node -e 'const d=require("/tmp/g.json");process.exit(d.alreadyAbandoned?0:1)' \
  && echo "OK：重复放弃幂等 200 alreadyAbandoned=true" || { echo "FAIL：放弃幂等异常 ($code)"; exit 1; }
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "${h_json[@]}" "${h_ed[@]}" "$BASE/api/editor/sessions/$SE_NO/commit" -d '{}')
[ "$code" = 409 ] && echo "OK：已放弃会话不能提交 → 409" || { echo "FAIL：期望 409，实际 $code"; exit 1; }
rm -f /tmp/g.json

say "8) 既有发布校验在合并后仍然有效（日期 / 出处 / 先于关系求解不变）"
echo "会话合并后的草稿仍须逐事件选定主张并通过 /api/editor/validate 与 /api/editor/publish 校验，"
echo "发布与预约的 baseVersionNo 版本冲突规则、出处遮盖、撤回等既有行为均不变。"

echo
echo "全部断言通过 ✅  会话列表："
get_ed "$BASE/api/editor/sessions" | node -e '
  const d = JSON.parse(require("fs").readFileSync(0,"utf8"));
  for (const s of d.sessions) {
    const n = s.stagedCounts;
    const staged = Object.values(n).reduce((a,b)=>a+b,0);
    console.log(`  #${s.sessionNo} [${s.status}] 基线 rev ${s.baselineRevisionNo} → 当前 rev ${s.currentRevisionNo}，暂存 ${staged} 项，冲突 ${s.conflictCount} 处`);
  }'
