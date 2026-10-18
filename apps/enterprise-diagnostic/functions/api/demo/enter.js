import { cors, httpError, json, resolveAuthMode, sessionCookie, withSessionCookie } from "../../_shared.js";

/**
 * POST /api/demo/enter
 *
 * 一键进入演示：选定身份，直接落到对应的三栏工作台。
 *
 * 为什么需要它：演示站的每一条业务路径都要求"先建账号 → 再发起企业授权 →
 * 再邀请 → 再接受邀请"，这条链在真实交付里是必需的，但作为演示入口时，
 * 访客在第一步就被挡住了。这里用一个固定的演示项目把所有前置条件一次建好，
 * 之后只发一个会话。
 *
 * 幂等：所有标识符固定，重复调用只会复用已有行，不会堆数据。
 * 安全：FORMAL_AUTH_MODE=production 时整个端点关闭。
 */

const DEMO_ENTERPRISE_ID = "ENT-DEMO-RUIXIN";
const DEMO_ENTERPRISE_NAME = "锐新科技（演示）";
const DEMO_PROJECT_ID = "PRJ-DEMO-0001";
const DEMO_PROJECT_NAME = "客户交接流程诊断";
const DEMO_PROJECT_SCOPE = "客户交接从收到申请到返回处理结果的实际过程";
const DEMO_AUTHORIZATION_ID = "AUTH-DEMO-0001";
const DEMO_WORK_ITEM_ID = "WI-DEMO-0001";

const DEMO_ACCOUNTS = {
  builder: { id: "ACC-DEMO-BUILDER", email: "builder@demo.local", name: "外部改造方", role: "external_builder" },
  employee: { id: "ACC-DEMO-EMPLOYEE", email: "employee@demo.local", name: "一线员工", role: "employee" },
  verifier: { id: "ACC-DEMO-VERIFIER", email: "verifier@demo.local", name: "流程核验人员", role: "verifier" },
  owner: { id: "ACC-DEMO-OWNER", email: "owner@demo.local", name: "企业负责人", role: "owner" },
};

const ROLE_ALIASES = { "external_builder": "builder", "builder": "builder", "employee": "employee", "verifier": "verifier", "owner": "owner" };

export async function onRequestPost({ request, env }) {
  const preflight = cors(request); if (preflight) return preflight;
  try {
    // B2-01：演示入口的开放条件是"被明确识别的 development"。
    // 生产语义（production 或任何未识别取值）一律关闭——失效保护方向是拒绝。
    const mode = resolveAuthMode(env);
    if (!mode.isDevelopment) {
      return httpError("演示入口在生产模式下已关闭", 403, "demo_disabled");
    }

    const body = await request.json().catch(() => ({}));
    const requested = String(body.role || "employee").trim();
    const key = ROLE_ALIASES[requested];
    if (!key) return httpError("未知的演示身份", 422, "unknown_role");
    const account = DEMO_ACCOUNTS[key];
    const db = env.DB;

    // ── 演示企业 / 项目 / 具名授权 / 成员 / 任务：全部建到可用状态 ──
    const seed = [
      db.prepare("INSERT OR IGNORE INTO enterprises(id,name,authorization_status) VALUES (?,?,'authorized')")
        .bind(DEMO_ENTERPRISE_ID, DEMO_ENTERPRISE_NAME),
      db.prepare("INSERT OR IGNORE INTO projects(id,name,scope,stage,status,evidence_level,created_by_role,created_by_account_id,authorization_stage) VALUES (?,?,?,'facts','active','E5','external_builder',?,'authorized')")
        .bind(DEMO_PROJECT_ID, DEMO_PROJECT_NAME, DEMO_PROJECT_SCOPE, DEMO_ACCOUNTS.builder.id),
      db.prepare("INSERT OR IGNORE INTO enterprise_authorizations(id,project_id,name,authorizer_name,authorizer_email,scope,reference,status,created_by_account_id,creation_idempotency_key,confirmation_token_nonce,confirmation_token_hash,confirmation_token_expires_at,confirmation_delivery_status,confirmed_by_identity,confirmed_at,confirmation_reason) VALUES (?,?,?,?,?,?,?,'authorized',?,?,?,?,?,'manual',?,CURRENT_TIMESTAMP,?)")
        .bind(DEMO_AUTHORIZATION_ID, DEMO_PROJECT_ID, "企业数据处理授权", "张总", "owner@demo.local",
              "客户交接流程诊断所需材料", "DEMO-AUTH-001", DEMO_ACCOUNTS.builder.id, "demo-seed",
              "demo-nonce", "demo-hash", "2099-01-01T00:00:00.000Z",
              "张总 <owner@demo.local>", "演示项目：授权范围与期限已确认"),
    ];
    for (const info of Object.values(DEMO_ACCOUNTS)) {
      seed.push(
        db.prepare("INSERT OR IGNORE INTO accounts(id,email,name,enterprise_id,status,account_role) VALUES (?,?,?,?,'active','member')")
          .bind(info.id, info.email, info.name, DEMO_ENTERPRISE_ID),
        db.prepare("INSERT OR IGNORE INTO project_memberships(project_id,account_id,role,scope,status) VALUES (?,?,?,'project','active')")
          .bind(DEMO_PROJECT_ID, info.id, info.role),
        // 邀请记录不能省。员工提交时是用「已接受的核验人邀请」来挑接收人的
        // （employee-submission.js 里 JOIN invitations i ... i.status='accepted'），
        // 只建成员关系会让提交退回 waiting_assignment，整个演示卡在员工这一步。
        db.prepare("INSERT OR IGNORE INTO invitations(id,token,project_id,inviter_account_id,email,role,scope,status,expires_at,accepted_account_id,idempotency_key) VALUES (?,?,?,?,?,?,'project','accepted','2099-01-01T00:00:00.000Z',?,?)")
          .bind(`INV-DEMO-${info.role.toUpperCase()}`, `demo-token-${info.role}`, DEMO_PROJECT_ID,
                DEMO_ACCOUNTS.builder.id, info.email, info.role, info.id, `demo-${info.role}`),
      );
    }
    seed.push(
      db.prepare("INSERT OR IGNORE INTO work_items(id,project_id,title,description,stage,status,assignee_role,assignee_label,evidence_completeness,blocking_reason,next_action,assignee_account_id) VALUES (?,?,?,?,'mapping','needs_input','employee','一线员工',0,'等待员工完成工作还原','开始还原我的工作',?)")
        .bind(DEMO_WORK_ITEM_ID, DEMO_PROJECT_ID, "还原客户交接工作",
              `还原你亲自参与的${DEMO_PROJECT_SCOPE}。`, DEMO_ACCOUNTS.employee.id),
      // 已登记并可引用的证据材料，让核验一侧有东西可看。
      db.prepare("INSERT OR IGNORE INTO evidence_materials(id,project_id,material_key,version,source_type,authorization_record_id,authorization_status,integrity_status,visibility,created_by_account_id,label,reference,metadata_json) VALUES (?,?,'DEMO-CRM-001',1,'csv',?,'authorized','verified','project',?,?,?,'{}')")
        .bind("MAT-DEMO-0001", DEMO_PROJECT_ID, DEMO_AUTHORIZATION_ID, DEMO_ACCOUNTS.builder.id,
              "CRM 客户档案样例（脱敏）", "MAT-CRM-001"),
    );
    await db.batch(seed);

    // ── 每个身份应当落在流程的不同时刻 ──
    // 员工看到的是"还没开始"；核验人需要员工已经提交；负责人需要决策包已经发布。
    // 只建一种状态会让核验人和负责人进去看到空队列。
    const employeeSubmitted = key === "verifier" || key === "owner";
    // 以员工身份进入时把任务复位到"还没开始"，否则会看到上一次留下的已提交回执。
    // handoff_status 必须一起复位：前端据 receipt.handoffStatus 判定步骤，
    // 只清 status 会让员工一进来就落在"等待分配核验人"的界面里，问答题根本不出现。
    if (!employeeSubmitted) {
      await db.prepare(
        "UPDATE work_items SET stage='mapping', status='needs_input', assignee_role='employee', assignee_label='一线员工', assignee_account_id=?, assigned_verifier_id=NULL, employee_description='', workflow_card_json='{}', employee_draft_json='{}', material_status='undecided', evidence_completeness=0, judgment_status='open', handoff_status='not_submitted', submission_version=0, submitted_at=NULL, last_submission_key=NULL, blocking_reason='等待员工完成工作还原', next_action='开始还原我的工作' WHERE id=?"
      ).bind(DEMO_ACCOUNTS.employee.id, DEMO_WORK_ITEM_ID).run();
      await db.prepare("DELETE FROM candidate_facts WHERE work_item_id=?").bind(DEMO_WORK_ITEM_ID).run();
      await db.prepare("DELETE FROM decision_packets WHERE project_id=?").bind(DEMO_PROJECT_ID).run();
    }
    const card = {
      trigger: "收到客户交接申请，由原对接人发起，含客户编号与交接原因。",
      inputs: "CRM 客户档案、历史跟进记录、关联订单、是否已有他人跟进。",
      steps: "核对客户编号与主体 → 看历史跟进与关联订单 → 把有效信息并入保留记录 → 把客户归属改到接收人 → 通知接收人确认接手。",
      judgments: "客户同属两个业务员、或涉及未结清账期时，必须找主管确认。",
      exceptions: "记录重复时做合并而非删除；资料缺失就挂起并通知申请人补件。",
    };

    // 演示用候选事实：核验人进入时它们等着被判断，负责人进入时已经确认过。
    const DEMO_FACTS = [
      ["FACT-DEMO-0001", "trigger_input", `触发与输入：${card.trigger} ${card.inputs}`, "trigger,inputs", "normal"],
      ["FACT-DEMO-0002", "execution_judgment", `执行与判断：${card.steps} ${card.judgments}`, "steps,judgments", "high"],
      ["FACT-DEMO-0003", "exception_handoff", `例外与交接：${card.exceptions}`, "exceptions", "normal"],
    ];

    if (employeeSubmitted) {      await db.prepare(
        "UPDATE work_items SET stage='facts', status='awaiting_verification', assignee_role='verifier', assignee_label='流程核验人员', assignee_account_id=?, assigned_verifier_id=?, employee_description=?, workflow_card_json=?, material_status='provided', evidence_completeness=65, blocking_reason='等待核验员工描述与佐证材料', next_action='核验员工描述', judgment_status='open' WHERE id=?"
      ).bind(DEMO_ACCOUNTS.verifier.id, DEMO_ACCOUNTS.verifier.id,
             card.steps, JSON.stringify(card), DEMO_WORK_ITEM_ID).run();

      const materialRefs = JSON.stringify(["MAT-DEMO-0001"]);
      // 负责人进入时事实已经确认过；核验人进入时它们还等着被判断。
      const factsConfirmed = key === "owner";
      const facts = DEMO_FACTS;
      // UPSERT：换身份进入时要把事实状态重设到该身份应看到的那一刻，
      // 用 INSERT OR IGNORE 会保留上一次留下的状态。
      const factStatements = facts.map(([id, type, claim, field, impact]) =>
        db.prepare("INSERT INTO candidate_facts(id,project_id,work_item_id,fact_type,claim,source_field,required,impact_level,second_confirmation_status,material_status,status,source_refs_json,flow_card_version,evidence_version) VALUES (?,?,?,?,?,?,1,?,?, 'same', ?,?,1,1) ON CONFLICT(id) DO UPDATE SET status=excluded.status, second_confirmation_status=excluded.second_confirmation_status, material_status='same', source_refs_json=excluded.source_refs_json, claim=excluded.claim")
          .bind(id, DEMO_PROJECT_ID, DEMO_WORK_ITEM_ID, type, claim, field, impact,
                impact === "high" ? "pending" : "not_required",
                factsConfirmed ? "confirmed" : "open", materialRefs));
      await db.batch(factStatements);
    }

    // 负责人需要一份已经发布的决策摘要；核验人需要的是待确认状态，两者互斥。
    if (key === "owner") {
      await db.prepare(
        "UPDATE work_items SET stage='decision', status='awaiting_decision', assignee_role='owner', assignee_label='企业负责人', assignee_account_id=?, judgment_status='confirmed', evidence_completeness=100, blocking_reason='等待负责人决定是否进入影子试点', next_action='审阅核验结论' WHERE id=?"
      ).bind(DEMO_ACCOUNTS.owner.id, DEMO_WORK_ITEM_ID).run();
      await db.prepare(
        "INSERT INTO decision_packets(id,project_id,version,status,drafted_by_account_id,verifier_account_id,fact_refs_json,risk_summary,pilot_scope,constraints_json,success_metrics_json,stop_conditions_json,downstream_owner,verified_at,published_at) VALUES (?,?,1,'published',?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP) ON CONFLICT(id) DO UPDATE SET status='published', published_at=CURRENT_TIMESTAMP, verified_at=CURRENT_TIMESTAMP"
      ).bind("PKT-DEMO-0001", DEMO_PROJECT_ID, DEMO_ACCOUNTS.builder.id, DEMO_ACCOUNTS.verifier.id,
             // 必须是 [{factId}] —— owner-packet 端点用 ref.factId 取值，
             // 写成字符串数组会让负责人的"已确认事实"整栏空掉。
             JSON.stringify(DEMO_FACTS.map(([id]) => ({ factId: id }))),
             "客户交接依赖个人记忆与手工核对，记录重复时靠合并兜底；合并口径若不一致存在归属误判风险。",
             "单门店、单客户交接流程，3–7 天影子试点，仅用已脱敏样本。",
             JSON.stringify(["不接生产 CRM", "不改动真实客户数据", "人工可随时接管"]),
             JSON.stringify(["交接记录完整率", "归属判断一致率"]),
             JSON.stringify(["出现归属误判", "需要写入生产系统"]),
             "企业负责人").run();
    }

    // ── 发一个会话 ──
    const token = crypto.randomUUID().replaceAll("-", "");
    const refresh = crypto.randomUUID().replaceAll("-", "");
    const expiresAt = new Date(Date.now() + 8 * 3600 * 1000).toISOString();
    await db.prepare("INSERT INTO sessions(token,account_id,project_id,expires_at,refresh_token) VALUES (?,?,?,?,?)")
      .bind(token, account.id, key === "builder" ? null : DEMO_PROJECT_ID, expiresAt, refresh).run();

    const payload = {
      role: account.role,
      demoRole: key,
      account: { id: account.id, email: account.email, name: account.name, enterpriseId: DEMO_ENTERPRISE_ID },
      projectId: DEMO_PROJECT_ID,
      projectName: DEMO_PROJECT_NAME,
      expiresAt,
    };
    return withSessionCookie(json(payload), sessionCookie(token));
  } catch (error) {
    return error instanceof Response ? error : httpError(error.message, 500);
  }
}

export async function onRequestGet({ request, env }) {
  const preflight = cors(request); if (preflight) return preflight;
  return json({
    available: resolveAuthMode(env).isDevelopment,
    roles: Object.entries(DEMO_ACCOUNTS).map(([key, info]) => ({ key, label: info.name, role: info.role })),
    projectName: DEMO_PROJECT_NAME,
  });
}
