#!/usr/bin/env python3
"""本地演示模式 · 端到端走查

对 `scripts/dev.sh` 启动的本地实例跑完整业务闭环，逐角色、逐门禁验证：

  外部改造方 → 企业具名授权 → 邀请四人 → 材料登记与复核 →
  员工流程摸排 → 核验人逐条确认（高影响事实需第二名核验人）→
  决策包草拟/核验/发布 → 企业负责人决策

用法：
    ./scripts/dev.sh                 # 另一个终端
    python3 scripts/walkthrough.py   # 默认 http://127.0.0.1:8788

退出码 0 表示每一步都通过；非 0 表示有步骤未通过，并打印首个失败原因。
只用标准库，不依赖任何第三方包。
"""
from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request
import uuid

BASE = os.environ.get("DEMO_BASE", "http://127.0.0.1:8788")
COOKIE = "__Host-diagnostic_session"
RUN = str(int(time.time()))[-6:]


def _guard_write_target() -> None:
    """限制这个脚本只能写回环或【独立预览项目】。

    这个脚本会**写入**数据：新建企业、项目、账号、工作项、候选事实与决策包。
    它接受 DEMO_BASE 环境变量，因此可以被指向任意地址。

    允许两类目标：
      1. 回环地址 —— 本地开发
      2. 独立预览项目 enterprise-ai-diagnostic-preview 及其部署子域

    永久拒绝：
      · 生产域名 enterprise-ai-diagnostic.pages.dev（含其部署子域）
      · 其他任何主机

    为什么预览可以放行而生产不行：预览项目在 Cloudflare 侧的两个环境都绑定
    独立的预览 D1 与预览 Queue（已用 scripts/check-binding.mjs 验证），
    而生产项目绑定生产资源。放行预览不会碰到生产数据。

    注意域名匹配方向：`xxx.enterprise-ai-diagnostic.pages.dev` 是【生产】
    项目的预览部署（历史上曾因绑定被覆盖而写入生产），必须拒绝；
    `xxx.enterprise-ai-diagnostic-preview.pages.dev` 才是独立预览项目。
    两者只差 `-preview`，所以判断必须按后缀精确匹配，不能靠包含关系。
    """
    from urllib.parse import urlparse

    host = (urlparse(BASE).hostname or "").lower()
    if not host:
        print(f"✗ 无法解析目标主机: {BASE}", file=sys.stderr)
        raise SystemExit(2)
    if host in {"127.0.0.1", "localhost", "::1"}:
        return

    PROD_SUFFIX = "enterprise-ai-diagnostic.pages.dev"
    PREVIEW_SUFFIX = "enterprise-ai-diagnostic-preview.pages.dev"

    # 生产判断必须放在预览之前：两者只差 -preview
    is_production = host == PROD_SUFFIX or host.endswith("." + PROD_SUFFIX)
    is_preview = host == PREVIEW_SUFFIX or host.endswith("." + PREVIEW_SUFFIX)

    if is_preview:
        return
    if is_production:
        reason = "这是【生产】域名（或其预览部署），绑定的是生产数据库"
    else:
        reason = "这不是回环地址，也不是独立预览项目"

    print("=" * 78, file=sys.stderr)
    print("✗ 已拒绝执行：这个脚本会写入数据。", file=sys.stderr)
    print(f"  当前目标: {BASE}  (host={host})", file=sys.stderr)
    print(f"  拒绝原因: {reason}", file=sys.stderr)
    print("", file=sys.stderr)
    print("  允许的目标：", file=sys.stderr)
    print("    · 回环地址（本地开发）", file=sys.stderr)
    print(f"    · *.{PREVIEW_SUFFIX}（独立预览项目）", file=sys.stderr)
    print("", file=sys.stderr)
    print("  只读检查内部文件是否泄露，请用：", file=sys.stderr)
    print("      node scripts/check-exposure.mjs <地址>", file=sys.stderr)
    print("=" * 78, file=sys.stderr)
    raise SystemExit(2)


_guard_write_target()

# 对非回环目标，先跑绑定检查 —— 部署安全的第一道闸。
# 这一步失败就绝不允许写入：历史上的生产误写正是因为跳过了它。
if (os.environ.get("DEMO_BASE") or "").strip() and "127.0.0.1" not in BASE and "localhost" not in BASE:
    project = os.environ.get("DEMO_PREVIEW_PROJECT", "enterprise-ai-diagnostic-preview")
    check = os.path.join(os.path.dirname(os.path.abspath(__file__)), "check-binding.mjs")
    print(f"→ 远程目标，先验证绑定隔离（{project}）…")
    if os.path.exists(check):
        import subprocess

        result = subprocess.run(
            ["node", check, "--project", project, "--strict"],
            capture_output=True, text=True,
        )
        if result.returncode != 0:
            print("✗ 绑定检查未通过，拒绝写入。", file=sys.stderr)
            print(result.stdout or result.stderr, file=sys.stderr)
            raise SystemExit(3)
        print("✓ 绑定检查通过：目标未绑定生产资源\n")
    else:
        print(f"✗ 找不到绑定检查脚本 {check}，拒绝对远程目标写入。", file=sys.stderr)
        raise SystemExit(3)

_ok = 0
_fail = 0
_first_failure = ""


def call(method, path, body=None, token=None, idem=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    # Cloudflare 会拦截默认的 "Python-urllib/3.x" UA 并返回 403。
    # 本地回环不受影响，所以这个问题只在真实环境暴露 —— 实测过。
    req.add_header("User-Agent", "enterprise-ai-diagnostic-acceptance/1.0")
    if token:
        req.add_header("Cookie", f"{COOKIE}={token}")
    if idem:
        req.add_header("Idempotency-Key", idem)
    try:
        with urllib.request.urlopen(req, timeout=25) as r:
            raw = r.read().decode()
            cookie = r.headers.get("Set-Cookie") or ""
            tok = cookie.split(COOKIE + "=", 1)[1].split(";", 1)[0] if COOKIE + "=" in cookie else ""
            return r.status, (json.loads(raw) if raw.strip()[:1] in "{[" else raw), tok
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        try:
            return e.code, json.loads(raw), ""
        except Exception:
            return e.code, raw, ""
    except Exception as e:  # noqa: BLE001 - report any transport failure verbatim
        return 0, f"CONNECT-ERROR {e}", ""


def step(label, status, payload, keep=110):
    global _ok, _fail, _first_failure
    good = 200 <= status < 300
    if good:
        _ok += 1
    else:
        _fail += 1
        body = json.dumps(payload, ensure_ascii=False) if not isinstance(payload, str) else payload
        if not _first_failure:
            _first_failure = f"{label} → HTTP {status} {body[:220]}"
    body = json.dumps(payload, ensure_ascii=False) if not isinstance(payload, str) else payload
    print(f"  {'✔' if good else '✘'} {label:<28} {status:<4} {body[:keep]}")
    return good


def section(title):
    print(f"\n── {title} " + "─" * max(0, 68 - len(title)))


def main() -> int:
    print("=" * 80)
    print(f"本地演示模式 · 端到端走查 · RUN={RUN} · {BASE}")
    print("=" * 80)

    status, payload, _ = call("GET", "/api/health")
    if status != 200:
        print(f"\n✘ 本地实例不可达（{BASE}）。先运行 ./scripts/dev.sh\n")
        return 2

    # ── ① 外部改造方：项目 + 企业具名授权 ──────────────────────────────
    section("① 外部改造方：项目 + 企业具名授权")
    _, payload, builder = call("POST", "/api/auth/authorize",
        {"email": f"builder{RUN}@demo.test", "enterpriseName": f"演示企业{RUN}",
         "name": "外部改造方", "bootstrapToken": "123456"})
    step("开通改造方账号", 200, payload, 70)

    status, payload, _ = call("POST", "/api/projects",
        {"name": "客户交接流程诊断",
         "scope": "客户交接从收到申请到返回处理结果的实际过程"},
        token=builder, idem=str(uuid.uuid4()))
    step("创建诊断项目", status, payload, 80)
    project_id = payload["project"]["id"]

    status, payload, _ = call("POST", f"/api/projects/{project_id}/authorizations",
        {"label": "企业数据处理授权", "authorizerName": "张总",
         "authorizerEmail": f"zhang{RUN}@demo.test",
         "scope": "客户交接流程诊断所需材料", "reference": "REF-001"},
        token=builder, idem=str(uuid.uuid4()))
    step("发起企业授权", status, payload, 70)
    authorization_id = payload["authorization"]["id"]
    capability = payload["confirmationUrl"].split("capability=", 1)[1].split("&", 1)[0]

    status, payload, _ = call("POST",
        f"/api/projects/{project_id}/authorizations/{authorization_id}/confirm",
        {"confirmationToken": capability, "decision": "authorized",
         "reason": "确认用于本次流程诊断，范围与期限已知悉"})
    step("企业具名授权确认", status, payload, 80)

    # ── ② 邀请并接受（真正的账号 / 成员 / 员工任务在此建立）──────────────
    section("② 邀请并接受四人（含第二名核验人）")
    # 高影响事实（涉及客户归属）必须由第二名核验人独立确认，所以需要两名核验人。
    slots = (("employee", "employee"), ("verifier", "verifier"),
             ("verifier2", "verifier"), ("owner", "owner"))
    names = {"employee": "一线员工", "verifier": "核验人甲",
             "verifier2": "核验人乙", "owner": "企业负责人"}
    invites, sessions = {}, {}
    for slot, role in slots:
        status, payload, _ = call("POST", f"/api/projects/{project_id}/invitations",
            {"email": f"{slot}{RUN}@demo.test", "role": role, "expiresInSeconds": 604800},
            token=builder)
        if step(f"邀请 {slot}", status, payload, 40):
            invites[slot] = payload["invitation"]["token"]
    for slot, token in invites.items():
        status, payload, session = call("POST", f"/api/invitations/{token}/accept",
            {"email": f"{slot}{RUN}@demo.test", "name": names[slot]})
        if step(f"{slot} 接受邀请", status, payload, 60) and session:
            sessions[slot] = session

    # ── ③ 材料：登记 → 复核 ─────────────────────────────────────────
    section("③ 材料：登记 → 核验人复核")
    status, payload, _ = call("POST", f"/api/projects/{project_id}/materials",
        {"authorizationRecordId": authorization_id,
         "label": "CRM 客户档案样例（脱敏）", "reference": "MAT-CRM-001",
         "sourceType": "csv", "visibility": "project",
         "metadata": {"note": "脱敏导出，仅含客户编号与归属字段"}},
        token=builder, idem=str(uuid.uuid4()))
    step("登记证据材料", status, payload, 90)
    material_id = (payload.get("material") or {}).get("id", "") if isinstance(payload, dict) else ""

    if material_id:
        status, payload, _ = call("POST",
            f"/api/projects/{project_id}/materials/{material_id}/review",
            {"decision": "verified", "reason": "来源已授权，字段完整，可作证据引用"},
            token=sessions.get("verifier", ""))
        step("核验人复核材料", status, payload, 90)

    # ── ④ 员工：读任务 → 提交流程卡 ─────────────────────────────────
    section("④ 员工：读任务 → 提交六段流程卡")
    employee_token = sessions.get("employee", "")
    status, payload, _ = call("GET", f"/api/projects/{project_id}/employee-task",
                              token=employee_token)
    step("读取员工任务", status, payload, 80)
    item_id = payload["task"]["id"] if isinstance(payload, dict) and payload.get("task") else ""

    if item_id:
        card = {
            "trigger": "收到客户交接申请，由原对接人发起，含客户编号与交接原因。",
            "inputs": "CRM 客户档案、历史跟进记录、关联订单、是否已有他人跟进。",
            "steps": "核对客户编号与主体 → 看历史跟进与关联订单 → 把有效信息并入保留记录 → "
                     "把客户归属改到接收人 → 通知接收人确认接手。",
            "judgments": "客户同属两个业务员、或涉及未结清账期时，必须找主管确认。",
            "exceptions": "记录重复时做合并而非删除；资料缺失就挂起并通知申请人补件。",
            # PILOT-04/N1：流程卡必须包含"交给谁"与"大约耗时"。
            # 这两个维度是报价依据与交接责任来源，缺失时服务端会拒绝提交（422）。
            "handoff": "交接结果交给接收人本人，由其确认接手；争议由业务主管裁定。",
            "burden": "单次交接约 20 分钟，通常 1 人完成；月末高峰期一天约 8 到 12 单。",
            "materialIndex": f"CRM 客户档案样例（脱敏） {material_id}",
        }
        status, payload, _ = call("POST", f"/api/work-items/{item_id}/employee-submission",
            {"text": card["steps"], "workflowCard": card, "materialStatus": "provided",
             "draftAnswers": {k: card[k] for k in
                              ("trigger", "inputs", "steps", "judgments", "exceptions", "handoff", "burden")}},
            token=employee_token, idem=str(uuid.uuid4()))
        step("员工提交工作还原", status, payload, 80)

    # ── ⑤ 核验：逐条确认 + 高影响事实二次确认 ────────────────────────
    section("⑤ 核验人：逐条确认 + 高影响事实二次确认")
    # 任务只分配给其中一名核验人，先找出是哪一位。
    primary, secondary = "", ""
    for slot in ("verifier", "verifier2"):
        _, probe, _ = call("GET", f"/api/formal/projects/{project_id}/verifier-facts",
                           token=sessions.get(slot, ""))
        if isinstance(probe, dict) and probe.get("facts"):
            primary = sessions[slot]
            secondary = sessions["verifier2" if slot == "verifier" else "verifier"]
            print(f"      待核验队列属于 {slot}")
            break

    status, payload, _ = call("GET", f"/api/formal/projects/{project_id}/verifier-facts",
                              token=primary)
    step("读取待核验事实", status, payload, 60)
    facts = payload.get("facts", []) if isinstance(payload, dict) else []
    confirmed_ids = []
    for fact in facts:
        status, payload, _ = call("POST",
            f"/api/work-items/{fact.get('workItemId') or item_id}/verification",
            {"factId": fact.get("factId"), "decision": "same",
             "reason": "与员工描述及流程卡一致，材料可核。",
             "sourceRefs": [material_id] if material_id else []},
            token=primary, idem=str(uuid.uuid4()))
        if step(f"确认 {fact.get('factType', 'fact')}", status, payload, 85):
            confirmed_ids.append(fact.get("factId"))

    # 命中归属/金额/合规等词表的必需要事实，需要第二名核验人独立确认。
    status, payload, _ = call("GET", f"/api/formal/projects/{project_id}/verifier-facts",
                              token=secondary)
    for fact in (payload.get("facts", []) if isinstance(payload, dict) else []):
        if fact.get("secondConfirmationAction") != "second_confirmation":
            continue
        status, payload, _ = call("POST",
            f"/api/work-items/{fact.get('workItemId') or item_id}/verification",
            {"action": "second_confirmation", "factId": fact.get("factId"),
             "secondConfirmationReason":
                 "涉及客户归属，已由第二名核验人独立复核材料与流程卡，结论一致。",
             "decision": "same", "reason": "第二次独立复核，确认与材料一致。",
             "sourceRefs": [material_id] if material_id else []},
            token=secondary, idem=str(uuid.uuid4()))
        step("高影响事实二次确认", status, payload, 85)

    # ── ⑥ 决策包：草拟 → 核验 → 发布 ────────────────────────────────
    section("⑥ 决策包：草拟 → 核验 → 发布")
    refs = [{"factId": fid} for fid in confirmed_ids if fid]
    status, payload, _ = call("POST",
        f"/api/formal/projects/{project_id}/decision-packets/draft",
        {"factRefs": refs,
         "riskSummary": "客户交接依赖个人记忆与手工核对，记录重复时靠合并兜底；"
                        "合并口径若不一致存在归属误判风险。",
         "pilotScope": "单门店、单客户交接流程，3–7 天影子试点，仅用已脱敏样本。",
         "constraints": ["不接生产 CRM", "不改动真实客户数据", "人工可随时接管"],
         "successMetrics": ["交接记录完整率", "归属判断一致率"],
         "stopConditions": ["出现归属误判", "需要写入生产系统"],
         "downstreamOwner": "企业负责人"},
        token=builder, idem=str(uuid.uuid4()))
    step("草拟决策包", status, payload, 80)
    packet_id = (payload.get("packet") or {}).get("id", "") if isinstance(payload, dict) else ""

    if packet_id:
        status, payload, _ = call("POST",
            f"/api/formal/decision-packets/{packet_id}/verify", {"factRefs": refs},
            token=primary)
        step("核验决策包", status, payload, 80)
        status, payload, _ = call("POST",
            f"/api/formal/decision-packets/{packet_id}/publish", None, token=builder)
        step("发布决策包", status, payload, 80)

    # ── ⑦ 企业负责人：读摘要 → 决策 ─────────────────────────────────
    section("⑦ 企业负责人：读摘要 → 决策")
    owner_token = sessions.get("owner", "")
    status, payload, _ = call("GET", f"/api/formal/projects/{project_id}/owner-packet",
                              token=owner_token)
    step("读取决策摘要", status, payload, 90)

    if packet_id:
        status, payload, _ = call("POST",
            f"/api/formal/decision-packets/{packet_id}/owner-decision",
            {"decision": "continue", "reason": "风险与证据已确认，同意进入小范围影子试点。",
             "scope": "单门店客户交接流程", "constraints": ["不接生产系统"],
             "successMetrics": ["交接记录完整率"], "stopConditions": ["出现归属误判"],
             "downstreamOwner": "企业负责人"},
            token=owner_token, idem=str(uuid.uuid4()))
        step("负责人作出决策", status, payload, 100)

    print()
    print("=" * 80)
    print(f"结果：{_ok} 步通过 / {_fail} 步未通过 · 项目 {project_id}")
    if _first_failure:
        print(f"首个失败：{_first_failure}")
    print("=" * 80)
    return 0 if _fail == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
