/**
 * V0.2 suggestions — request-level product flow.
 *
 * Drives the real api-client.js calls through the real Pages handlers against an
 * in-memory D1 database, with a fake model. This is the closest end-to-end proof
 * available without wrangler/browser (not installed in this workspace), and it is
 * explicitly not a browser rendering test.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { onRequestPost as generate } from "../functions/api/formal/projects/[projectId]/diagnosis-suggestions.js";
import { onRequestPost as createDraft } from "../functions/api/formal/projects/[projectId]/decision-packets/draft.js";
import { onRequestGet as getConfirmedFacts } from "../functions/api/formal/projects/[projectId]/confirmed-facts.js";
import { onRequestGet as getDecisionPacket } from "../functions/api/formal/projects/[projectId]/decision-packet.js";
import { onRequestGet as getOwnerPacket } from "../functions/api/formal/projects/[projectId]/owner-packet.js";
import { onRequestPost as verifyPacket } from "../functions/api/formal/decision-packets/[packetId]/verify.js";
import { onRequestPost as publishPacket } from "../functions/api/formal/decision-packets/[packetId]/publish.js";
import { D1Harness } from "./d1_harness.mjs";

const P = "PRJ-FLOW";
const BLD = "BLD-F", VER = "VER-F", OWN = "OWN-F", EMP = "EMP-F";
const TOK_B = "TOK-F-B", TOK_V = "TOK-F-V", TOK_O = "TOK-F-O", TOK_E = "TOK-F-E";

function fixture() {
  const db = new D1Harness();
  db.exec(`
    INSERT INTO accounts(id,email,name,status) VALUES
      ('${BLD}','b@flow.invalid','改造方','active'),('${VER}','v@flow.invalid','核验人','active'),
      ('${OWN}','o@flow.invalid','负责人','active'),('${EMP}','e@flow.invalid','员工','active');
    INSERT INTO projects(id,name,scope,stage,status,evidence_level,created_by_role,created_by_account_id)
      VALUES ('${P}','流程项目','选品到发布','decision','active','L2','external_builder','${BLD}');
    INSERT INTO enterprise_authorizations(id,project_id,name,authorizer_name,authorizer_email,scope,reference,status,created_by_account_id,creation_idempotency_key,confirmation_token_nonce,confirmation_token_hash,confirmation_token_expires_at)
      VALUES ('AUTH-F','${P}','授权','王总','o@flow.invalid','诊断','DOC','authorized','${BLD}','K','n','h','2099-01-01T00:00:00Z');
    INSERT INTO project_memberships(project_id,account_id,role,status) VALUES
      ('${P}','${BLD}','external_builder','active'),('${P}','${VER}','verifier','active'),
      ('${P}','${OWN}','owner','active'),('${P}','${EMP}','employee','active');
    INSERT INTO sessions(token,account_id,project_id,expires_at,refresh_token) VALUES
      ('${TOK_B}','${BLD}','${P}','2099-01-01T00:00:00Z','R1'),('${TOK_V}','${VER}','${P}','2099-01-01T00:00:00Z','R2'),
      ('${TOK_O}','${OWN}','${P}','2099-01-01T00:00:00Z','R3'),('${TOK_E}','${EMP}','${P}','2099-01-01T00:00:00Z','R4');
    INSERT INTO work_items(id,project_id,title,description,stage,status,assignee_role,assignee_label,evidence_completeness,blocking_reason,next_action,judgment_status,assigned_verifier_id)
      VALUES ('WI-F','${P}','任务','任务','facts','awaiting_verification','employee','员工',100,'','','confirmed','${VER}');
    INSERT INTO evidence_materials(id,project_id,material_key,version,source_type,authorization_status,integrity_status,visibility,created_by_account_id,work_item_id,label,reference)
      VALUES ('MAT-F','${P}','MAT-F',1,'pdf','authorized','verified','project','${BLD}','WI-F','证据','REF');
    INSERT INTO candidate_facts(id,project_id,work_item_id,fact_type,claim,source_field,required,impact_level,second_confirmation_status,material_status,status,source_refs_json,evidence_level) VALUES
      ('FG','${P}','WI-F','workflow','每天重复确认库存','stock',1,'normal','not_required','same','confirmed','["MAT-F"]','E2'),
      ('FU','${P}','WI-F','workflow','尚未核验的候选事实','open',0,'normal','not_required','unverified','open','[]',NULL);
  `);
  return db;
}

const modelQueue = [];
const modelResponse = () => new Response(JSON.stringify({
  choices: [{ message: { content: JSON.stringify({ suggestions: modelQueue.shift() || [] }) } }],
}), { status: 200, headers: { "Content-Type": "application/json" } });

let db = fixture();
let activeToken = TOK_B;
const handlers = {
  [`/api/formal/projects/${P}/diagnosis-suggestions`]: { POST: generate },
  [`/api/formal/projects/${P}/decision-packets/draft`]: { POST: createDraft },
  [`/api/formal/projects/${P}/confirmed-facts`]: { GET: getConfirmedFacts },
  [`/api/formal/projects/${P}/decision-packet`]: { GET: getDecisionPacket },
  [`/api/formal/projects/${P}/owner-packet`]: { GET: getOwnerPacket },
};

async function route(pathWithQuery, init) {
  const url = new URL(`http://127.0.0.1${pathWithQuery}`);
  const entry = handlers[url.pathname];
  if (entry) {
    const handler = entry[(init.method || "GET").toUpperCase()];
    if (!handler) return new Response("{}", { status: 405 });
    const headers = new Headers(init.headers || {});
    headers.set("Cookie", `__Host-diagnostic_session=${activeToken}`);
    const request = new Request(url.toString(), { ...init, headers });
    return handler({ request, env: { DB: db, DEEPSEEK_API_KEY: "test-key" }, params: { projectId: P } });
  }
  const verifyMatch = url.pathname.match(/^\/api\/formal\/decision-packets\/([^/]+)\/(verify|publish)$/);
  if (verifyMatch) {
    const headers = new Headers(init.headers || {});
    headers.set("Cookie", `__Host-diagnostic_session=${activeToken}`);
    const request = new Request(url.toString(), { ...init, headers });
    return (verifyMatch[2] === "verify" ? verifyPacket : publishPacket)({ request, env: { DB: db }, params: { packetId: verifyMatch[1] } });
  }
  return new Response(JSON.stringify({ detail: `unrouted ${url.pathname}` }), { status: 404 });
}

async function routeFetch(input, init = {}) {
  const url = String(input);
  if (url.includes("api.deepseek.com")) return modelResponse();
  return route(url.replace(/^https?:\/\/[^/]+/, ""), init);
}
globalThis.fetch = routeFetch;

const context = {
  URL, URLSearchParams, Headers, Request, Response, setTimeout, clearTimeout,
  crypto: { randomUUID: () => `key-${Math.random()}` },
  fetch: routeFetch,
  window: { location: { protocol: "https:", hostname: "example.invalid" }, crypto: { randomUUID: () => `key-${Math.random()}` } },
};
context.window.window = context.window;
context.window.fetch = context.fetch;
context.globalThis = context.window;
vm.createContext(context);
vm.runInContext(readFileSync(new URL("../formal-ui-contract.js", import.meta.url), "utf8"), context);
vm.runInContext(readFileSync(new URL("../api-client.js", import.meta.url), "utf8"), context);
const api = context.window.diagnosticApi;

const results = [];
const check = (id, name, pass, note = "") => { results.push({ id, pass }); console.log(`${pass ? "✔" : "✘"} [${id}] ${name}${note ? " | " + note : ""}`); };

const suggestion = (factIds) => ({
  problem: "库存确认依赖人工重复核对", opportunity: "整理成自动提醒", factIds,
  priority: "high", priorityReason: "每天重复且影响交付", pendingConditions: [],
});
const packetFields = {
  riskSummary: "重复确认造成等待", pilotScope: "一个班组试运行", constraints: ["不影响现有节奏"],
  successMetrics: ["不再重复确认"], stopConditions: ["出现无法追溯引用即停止"], downstreamOwner: "运营负责人",
};
const strip = (items) => items.map(({ problem, opportunity, factIds, priority, priorityReason, pendingConditions }) => ({ problem, opportunity, factIds, priority, priorityReason, pendingConditions }));

// ① 改造方：生成正式建议 → 保存草稿 → 内容审核
modelQueue.push([suggestion(["FG"])]);
const generated = await api.generateDiagnosisSuggestions(P, "formal", "FLOW-G1");
check("FLOW-1", "改造方生成正式建议", generated.suggestions?.length === 1 && generated.suggestions[0].evidence[0].factId === "FG", `count=${generated.suggestions?.length}`);

const created = await api.createFormalDecisionPacket(P, { ...packetFields, suggestions: strip(generated.suggestions), draftKind: "formal", basisDigest: generated.generation.basisDigest }, "FLOW-D1");
const packetId = created.packet.id;
check("FLOW-2", "正式建议保存为草稿且引用并集正确",
  created.packet.status === "draft" && JSON.stringify(created.packet.factRefs.map((ref) => ref.factId)) === JSON.stringify(["FG"]),
  `status=${created.packet.status}`);

const reviewed = await api.reviewFormalSuggestionContent(P, packetId, created.packet.version, created.packet.contentKey);
check("FLOW-3", "改造方完成显式内容审核", Boolean(reviewed.contentReview?.contentHash), `hash=${Boolean(reviewed.contentReview?.contentHash)}`);

// ② 核验人：确认事实引用
activeToken = TOK_V;
const verified = await api.verifyFormalDecisionPacket(packetId, created.packet.factRefs, created.packet.contentKey);
check("FLOW-4", "核验人确认事实引用", verified.packet?.status === "verifier_checked", `status=${verified.packet?.status}`);

// ③ 改造方发布 → 负责人看到建议
activeToken = TOK_B;
const published = await api.publishFormalDecisionPacket(packetId);
check("FLOW-5", "发布成功", published.packet?.status === "published", `status=${published.packet?.status}`);

activeToken = TOK_O;
const ownerView = await api.getFormalOwnerPacket(P);
check("FLOW-6", "负责人看到正式建议、优先级理由与依据",
  ownerView.packet?.suggestions?.length === 1
    && ownerView.packet.suggestions[0].priorityReason
    && ownerView.packet.suggestionReview?.reviewedBy === BLD
    && ownerView.packet.suggestionsInvalidated === null,
  `count=${ownerView.packet?.suggestions?.length}`);

// ④ 无材料内部稿：改造方可见，负责人不可见
db = fixture();
activeToken = TOK_B;
modelQueue.push([{ ...suggestion(["FU"]), pendingConditions: ["确认员工所述口径"] }]);
const internalGenerated = await api.generateDiagnosisSuggestions(P, "internal", "FLOW-G2");
const internalCreated = await api.createFormalDecisionPacket(P, {
  ...packetFields, suggestions: strip(internalGenerated.suggestions), draftKind: "internal",
  basisDigest: internalGenerated.generation.basisDigest,
}, "FLOW-D2");
const internalId = internalCreated.packet.id;
check("FLOW-7", "内部待核实初稿建立且标记未核实",
  internalCreated.packet.status === "internal_draft" && internalCreated.packet.suggestions[0].unverified === true,
  `status=${internalCreated.packet.status}`);

const builderReread = await api.getFormalDecisionPacket(P, "internal");
check("FLOW-8", "改造方刷新后仍能打开内部稿", builderReread.packet?.id === internalId, `id=${builderReread.packet?.id}`);

activeToken = TOK_V;
let internalVerifyStatus = 0;
try { await api.verifyFormalDecisionPacket(internalId, internalCreated.packet.factRefs); } catch (error) { internalVerifyStatus = error.status; }
activeToken = TOK_O;
let ownerInternalStatus = 0;
try { await api.getFormalOwnerPacket(P); } catch (error) { ownerInternalStatus = error.status; }
check("FLOW-9", "核验人不能核验内部稿，负责人看不到", internalVerifyStatus === 409 && ownerInternalStatus === 404,
  `verify=${internalVerifyStatus} owner=${ownerInternalStatus}`);

// ⑤ 未审核/已失效不能作为有效结果
db = fixture();
activeToken = TOK_B;
modelQueue.push([suggestion(["FG"])]);
const g2 = await api.generateDiagnosisSuggestions(P, "formal", "FLOW-G3");
const c2 = await api.createFormalDecisionPacket(P, { ...packetFields, suggestions: strip(g2.suggestions), draftKind: "formal", basisDigest: g2.generation.basisDigest }, "FLOW-D3");
activeToken = TOK_V;
await api.verifyFormalDecisionPacket(c2.packet.id, c2.packet.factRefs, c2.packet.contentKey);
activeToken = TOK_B;
let publishStatus = 0;
try { await api.publishFormalDecisionPacket(c2.packet.id); } catch (error) { publishStatus = error.status; }
check("FLOW-10", "未完成内容审核不能发布", publishStatus === 409, `status=${publishStatus}`);

const pass = results.filter((result) => result.pass).length;
console.log(`\nFLOW PASS=${pass} FAIL=${results.length - pass}`);
process.exit(pass === results.length ? 0 : 1);
