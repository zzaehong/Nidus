"use strict";
const $ = id => document.getElementById(id);
let state = null, fallbackIds = [], recordsOffset = 0;
const statusLabels = {billing_required: "계정 요금제 확인 필요", free_tier_unavailable: "무료 요금제 미지원", available: "사용 가능", disabled: "비활성", connection_required: "연결 확인 필요", support_required: "호환성 확인 필요", unknown_pricing: "요금 미확인", approval_required: "유료 승인 필요"};
const pricingLabels = {free: "무료", paid: "유료", unknown: "요금 미확인"};
const defaults = {openai: "https://api.openai.com/v1", anthropic: "https://api.anthropic.com/v1", gemini: "https://generativelanguage.googleapis.com/v1beta", compatible: ""};
function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function button(text, action, style = "secondary") {
  const node = el("button", text, style);
  node.type = "button";
  node.addEventListener("click", () => Promise.resolve().then(action).catch(report));
  return node;
}
function option(value, text) {const node = el("option", text); node.value = value; return node;}
function notice(message, error = false) {
  $("notice").textContent = message;
  $("notice").className = error ? "error" : "";
  $("notice").hidden = false;
}
function report(error) {notice(error.message || "요청에 실패했습니다.", true);}
async function api(path, method = "GET", value) {
  const response = await fetch(path, {method, credentials: "same-origin",
    headers: value === undefined ? {} : {"Content-Type": "application/json"},
    body: value === undefined ? undefined : JSON.stringify(value)});
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401) showLogin();
    throw new Error(data.error?.message || `요청 실패 (${response.status})`);
  }
  return data;
}
function showLogin() {$("workspace").hidden = true; $("login-view").hidden = false; $("new-key").textContent = "";}
function page(name) {
  document.querySelectorAll("[data-panel]").forEach(n => n.hidden = n.dataset.panel !== name);
  document.querySelectorAll("[data-page]").forEach(n => n.classList.toggle("selected", n.dataset.page === name));
  if (name === "records") loadRecords(true).catch(report);
}
async function refresh() {
  state = await api("/admin/state");
  $("workspace").hidden = false; $("login-view").hidden = true;
  render();
}
function modelName(id) {return state.models.find(m => m.id === id)?.name || id;}
function render() {
  document.querySelector('[data-go="connections"]').textContent = state.connections.length ? "연결 관리 ↗" : "첫 연결 추가 ↗";
  const enabled = state.models.filter(m => m.enabled && state.connections.find(c => c.id === m.connection_id)?.enabled);
  $("metric-models").textContent = enabled.filter(m => m.status === "available").length;
  $("metric-free").textContent = enabled.filter(m => m.pricing === "free").length;
  $("metric-spend").textContent = "$" + state.budget.used_and_reserved_usd.toFixed(4);
  $("model-readiness").replaceChildren();
  const billingConnections = state.connections.filter(c => enabled.some(m => m.connection_id === c.id && m.status === "billing_required"));
  for (const c of billingConnections) {
    const note = el("div", undefined, "note");
    note.append(el("p", `${c.name}: 공식 모델 요금은 확인되었습니다. 이 API 키의 계정 요금제를 한 번 확인하면 지원 모델에 함께 적용됩니다.`),
      button("계정 요금제 확인", () => editConnection(c)));
    $("model-readiness").append(note);
  }
  if (!enabled.some(m => m.status === "available") && !billingConnections.length) {
    $("model-readiness").append(el("p", "호출 가능한 모델이 없습니다. 연결과 모델에서 표시된 상태를 확인하세요.", "note"));
  }
  const selected = $("test-model").value;
  $("test-model").replaceChildren(option("auto", "자동 선택 · 무료 우선"), ...enabled.map(m => {const o = option(m.id, `${m.name} · ${statusLabels[m.status]}`); o.disabled = m.status !== "available"; return o;}));
  if ([...$("test-model").options].some(o => o.value === selected && !o.disabled)) $("test-model").value = selected;
  $("policy-summary").replaceChildren();
  for (const [key, value] of [["응답 형식", state.settings.output_format === "json" ? "JSON · 전체 응답 검증" : "텍스트 · 스트리밍 가능"],
    ["유료 승인 모델", `${state.settings.approved_model_ids.length}개 / 월 $${state.settings.monthly_budget_usd}`],
    ["본문 저장", state.settings.store_bodies ? "사용 중" : "꺼짐 · 메타데이터만 저장"]]) {
    $("policy-summary").append(el("dt", key), el("dd", value));
  }
  $("connection-list").replaceChildren();
  if (!state.connections.length) $("connection-list").append(el("div", "아직 연결된 서비스가 없습니다. API 키를 등록해 시작하세요.", "empty"));
  for (const connection of state.connections) {
    const card = el("article", undefined, "connection-card"), info = el("div"), actions = el("div", undefined, "actions");
    info.append(el("h3", connection.name + (connection.enabled ? "" : " · 비활성")), el("p", `${connection.provider} · ${connection.base_url}`));
    const tierLabels = {free: "무료 요금제 · 사용자 확인", paid: "유료 요금제 · 승인과 예산 적용", unconfirmed: "계정 요금제 미확인"};
    info.append(el("p", tierLabels[connection.billing_tier || "unconfirmed"]));
    if (billingConnections.some(c => c.id === connection.id)) {
      info.append(el("p", "공식 요금은 확인되었습니다. 계정 요금제를 확인하면 무료 지원 모델의 요금이 함께 적용됩니다."));
      actions.append(button("계정 요금제 확인", () => editConnection(connection)));
    }
    const discovery = connection.discovery;
    info.append(el("p", discovery ? `모델 조회: ${discovery.status === "success" ? "완료" : discovery.status === "pending" ? "대기" : "실패 · 새로고침 또는 수동 등록"} · 마지막 성공: ${discovery.last_success_at ? new Date(discovery.last_success_at).toLocaleString("ko-KR") : "없음"}` : "모델 목록을 새로고침하세요."));
    actions.append(button("모델 새로고침", async () => {
      notice("모델 목록을 조회하는 중…");
      const result = await api(`/admin/connections/${connection.id}/refresh`, "POST");
      await refresh(); notice(result.status === "success" ? "모델 목록을 갱신했습니다." : "목록 조회에 실패했습니다. 연결 설정을 확인하거나 수동 등록하세요.", result.status !== "success");
    }), button("수정", () => editConnection(connection)), button("삭제", async () => {
      if (!confirm(`‘${connection.name}’ 연결과 저장된 키를 삭제할까요? 연결된 모델을 먼저 삭제해야 합니다.`)) return;
      await api(`/admin/connections/${connection.id}`, "DELETE"); await refresh(); notice("연결을 삭제했습니다.");
    }, "danger"));
    card.append(info, actions); $("connection-list").append(card);
  }
  $("model-list").replaceChildren();
  if (!state.models.length) $("model-list").append(el("div", "연결을 등록하거나 모델 목록을 새로고침하세요. 목록 조회를 지원하지 않으면 고급 수동 등록을 사용하세요.", "empty"));
  $("add-model").disabled = !state.connections.length;
  for (const model of state.models) {
    const card = el("article", undefined, "model-card"), actions = el("div", undefined, "actions");
    card.append(el("span", statusLabels[model.status], `badge ${model.pricing}`), el("h3", model.name),
      el("p", `${state.connections.find(c => c.id === model.connection_id)?.name} / ${model.upstream_model}`),
      el("p", `${model.enabled ? "활성" : "비활성"} · 순서 ${model.priority} · ${model.prompt_override === null ? "공통 프롬프트" : "개별 프롬프트"}`));
    if (model.price_source) {
      const source = el("a", `공식 요금 · 확인 ${model.price_verified_at}`);
      source.href = model.price_source; source.target = "_blank"; source.rel = "noopener noreferrer";
      if (model.free_tier_available) card.append(el("p", model.pricing === "free" ? "적용 요금: 무료 ($0) · 확인한 무료 계정 기준" : model.status === "billing_required" ? "무료 계정에서 무료 구간 지원 · 계정 요금제 확인 필요" : "무료 구간은 무료 계정에만 적용됩니다. 현재 설정의 요금을 확인하세요."));
      card.append(source, el("p", `유료 계정 표준: 입력 $${model.input_per_million} / 출력 $${model.output_per_million} (100만 토큰) · ${model.pricing_origin === "manual" ? "사용자 요금" : "표준 요금 추정"}`));
    }
    if (model.status === "billing_required") actions.append(button("계정 요금제 확인", () => editConnection(state.connections.find(c => c.id === model.connection_id))));
    if (model.status === "unknown_pricing") card.append(el("p", "이 모델의 적용 요금 자료가 없습니다. 고급 설정에서 확인한 요금을 등록하세요."));
    if (model.status === "support_required") card.append(el("p", "지원 여부를 확인하지 못한 모델입니다. 표시된다는 이유만으로 호출 가능하지는 않습니다."));
    const test = button("테스트", () => {page("overview"); $("test-model").value = model.id; $("test-input").focus();});
    test.disabled = model.status !== "available";
    actions.append(button("고급 설정", () => editModel(model)), test, button("삭제", async () => {
      if (!confirm(`‘${model.name}’ 모델을 삭제할까요?`)) return;
      await api(`/admin/models/${model.id}`, "DELETE"); await refresh(); notice("모델을 삭제했습니다.");
    }, "danger"));
    card.append(actions); $("model-list").append(card);
  }
  $("system-prompt").value = state.settings.system_prompt;
  $("output-format").value = state.settings.output_format;
  $("max-output").value = state.settings.max_output_tokens;
  $("timeout").value = state.settings.timeout_seconds;
  $("monthly-budget").value = state.settings.monthly_budget_usd;
  $("store-bodies").checked = state.settings.store_bodies;
  $("retention").value = state.settings.retention_days;
  $("prompt-previews").replaceChildren();
  for (const model of state.models) {
    const item = el("details"); item.append(el("summary", `${model.name} · ${model.prompt_override === null ? "공통" : "개별"}`), el("pre", model.effective_prompt));
    $("prompt-previews").append(item);
  }
  $("route-list").replaceChildren();
  const routes = enabled.filter(m => m.status === "available")
    .sort((a, b) => (a.pricing === "paid") - (b.pricing === "paid") || a.priority - b.priority || a.id.localeCompare(b.id));
  for (const model of routes) $("route-list").append(el("li", `${model.name} · ${pricingLabels[model.pricing]} · 순서 ${model.priority}`));
  if (!routes.length) $("route-list").append(el("p", "호출 가능한 모델을 등록하고 요금을 분류하세요.", "muted"));
  $("paid-models").replaceChildren();
  for (const model of state.models.filter(m => m.pricing === "paid")) {
    const label = el("label", undefined, "check"), input = document.createElement("input");
    input.type = "checkbox"; input.value = model.id; input.checked = state.settings.approved_model_ids.includes(model.id);
    const noRates = model.input_per_million === null || model.output_per_million === null;
    input.disabled = noRates;
    label.append(input, document.createTextNode(model.name + (noRates ? " · 요율을 먼저 입력하세요" : ` · 입력 $${model.input_per_million} / 출력 $${model.output_per_million} (100만 토큰)`)));
    $("paid-models").append(label);
  }
  if (!$("paid-models").children.length) $("paid-models").append(el("p", "등록된 유료 모델이 없습니다.", "muted"));
  $("budget-summary").textContent = `${state.budget.month} · 사용·예약 $${state.budget.used_and_reserved_usd.toFixed(6)} / 잔여 $${state.budget.remaining_usd.toFixed(6)} (추정)`;
  $("endpoint").textContent = `${location.origin}/api/v1/generate`;
  $("curl-example").textContent = `curl ${location.origin}/api/v1/generate \\\n  -H "Authorization: Bearer $NIDUS_ROUTER_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '{"input":"안녕하세요","model":"auto","stream":false}'`;
}
function editConnection(connection = null) {
  $("connection-form").reset(); $("connection-form").querySelector(".form-error").textContent = "";
  $("connection-id").value = connection?.id || "";
  $("connection-name").value = connection?.name || "";
  $("connection-provider").value = connection?.provider || "openai";
  $("connection-url").value = connection?.base_url || defaults.openai;
  $("connection-tier").value = connection?.billing_tier || "unconfirmed";
  $("connection-enabled").checked = connection?.enabled ?? true;
  $("connection-key").required = !connection;
  $("connection-dialog").showModal();
}
function editModel(model = null) {
  $("model-form").reset(); $("model-form").querySelector(".form-error").textContent = "";
  $("model-id").value = model?.id || "";
  $("model-name").value = model?.name || "";
  $("model-upstream").value = model?.upstream_model || "";
  $("model-connection").replaceChildren(...state.connections.map(c => option(c.id, c.name)));
  if (model) $("model-connection").value = model.connection_id;
  $("model-pricing").value = model?.pricing || "unknown";
  $("model-priority").value = model?.priority || 0;
  $("model-input-rate").value = model?.input_per_million ?? "";
  $("model-output-rate").value = model?.output_per_million ?? "";
  $("model-override-enabled").checked = model?.prompt_override != null;
  $("override-field").hidden = !$("model-override-enabled").checked;
  $("model-prompt").value = model?.prompt_override ?? state.settings.system_prompt;
  $("model-capability").checked = model?.capability_confirmed || false;
  $("model-enabled").checked = model?.enabled ?? true;
  fallbackIds = [...(model?.fallback_ids || [])]; renderFallbacks();
  $("model-dialog").showModal();
}
function renderFallbacks() {
  $("fallback-rows").replaceChildren();
  fallbackIds.forEach((id, index) => {
    const row = el("div"), select = el("select");
    select.setAttribute("aria-label", `대체 모델 ${index + 1}`);
    select.append(...state.models.filter(m => m.id !== $("model-id").value && (m.id === id || !fallbackIds.includes(m.id))).map(m => option(m.id, m.name)));
    select.value = id; select.addEventListener("change", () => {fallbackIds[index] = select.value; renderFallbacks();});
    const up = button("↑", () => {if (index) [fallbackIds[index - 1], fallbackIds[index]] = [id, fallbackIds[index - 1]]; renderFallbacks();});
    up.setAttribute("aria-label", "대체 순서 올리기"); up.disabled = index === 0;
    row.append(select, up, button("삭제", () => {fallbackIds.splice(index, 1); renderFallbacks();}, "danger"));
    $("fallback-rows").append(row);
  });
  $("add-fallback").disabled = !state.models.some(m => m.id !== $("model-id").value && !fallbackIds.includes(m.id));
}
async function loadRecords(reset = false) {
  if (reset) {recordsOffset = 0; $("records-list").replaceChildren();}
  const {records} = await api(`/admin/records?offset=${recordsOffset}&limit=25`);
  recordsOffset += records.length;
  $("more-records").hidden = records.length < 25;
  if (!recordsOffset) $("records-list").append(el("div", "아직 요청 기록이 없습니다.", "empty"));
  for (const record of records) {
    const item = el("details");
    item.append(el("summary", `${record.status === "success" ? "완료" : "실패"} · ${modelName(record.model || record.requested_model)} · ${new Date(record.timestamp).toLocaleString("ko-KR")} · ${record.latency_ms}ms`), el("pre", JSON.stringify(record, null, 2)));
    $("records-list").append(item);
  }
}
function submit(id, callback) {
  $(id).addEventListener("submit", async event => {
    event.preventDefault();
    const btn = event.submitter, error = $(id).querySelector(".form-error");
    if (btn) btn.disabled = true;
    if (error) error.textContent = "";
    try {await callback();} catch (err) {if (error) error.textContent = err.message; else report(err);}
    finally {if (btn) btn.disabled = false;}
  });
}
submit("login-form", async () => {
  try {await api("/admin/login", "POST", {token: $("login-token").value}); $("login-token").value = ""; $("login-error").textContent = ""; await refresh();}
  catch (err) {$("login-error").textContent = err.message;}
});
submit("connection-form", async () => {
  const id = $("connection-id").value;
  await api("/admin/connections" + (id ? "/" + id : ""), id ? "PUT" : "POST", {
    name: $("connection-name").value, provider: $("connection-provider").value, base_url: $("connection-url").value,
    api_key: $("connection-key").value || null, billing_tier: $("connection-tier").value, enabled: $("connection-enabled").checked});
  $("connection-key").value = ""; $("connection-dialog").close(); await refresh(); notice("연결과 계정 요금제를 저장했습니다. 모델 상태를 확인하고 빠른 테스트에서 호출하세요.");
});
submit("model-form", async () => {
  const id = $("model-id").value;
  await api("/admin/models" + (id ? "/" + id : ""), id ? "PUT" : "POST", {
    connection_id: $("model-connection").value, name: $("model-name").value, upstream_model: $("model-upstream").value,
    capability_confirmed: $("model-capability").checked, enabled: $("model-enabled").checked, pricing: $("model-pricing").value, priority: Number($("model-priority").value),
    input_per_million: $("model-input-rate").value === "" ? null : Number($("model-input-rate").value),
    output_per_million: $("model-output-rate").value === "" ? null : Number($("model-output-rate").value),
    prompt_override: $("model-override-enabled").checked ? $("model-prompt").value : null, fallback_ids: fallbackIds});
  $("model-dialog").close(); await refresh(); notice("모델을 저장했습니다. 유료 모델의 요금·연결을 바꿨다면 다시 승인하세요.");
});
async function saveSettings(changes, message) {await api("/admin/settings", "PUT", {...state.settings, ...changes}); await refresh(); notice(message);}
submit("prompt-form", () => saveSettings({system_prompt: $("system-prompt").value, output_format: $("output-format").value,
  max_output_tokens: Number($("max-output").value), timeout_seconds: Number($("timeout").value)}, "프롬프트와 응답 설정을 저장했습니다."));
submit("budget-form", async () => {
  const ids = [...$("paid-models").querySelectorAll("input:checked")].map(n => n.value);
  await api("/admin/budget", "PUT", {monthly_budget_usd: Number($("monthly-budget").value), approved_model_ids: ids,
    terms: Object.fromEntries(ids.map(id => [id, state.models.find(m => m.id === id).approval_terms]))});
  await refresh(); notice("유료 모델과 월간 예산 승인을 저장했습니다.");
});
submit("logging-form", () => saveSettings({store_bodies: $("store-bodies").checked,
  retention_days: Number($("retention").value)}, "기록 설정을 저장했습니다."));
submit("test-form", async () => {
  $("test-result").hidden = false; $("test-result").textContent = "응답을 기다리는 중…";
  try {const result = await api("/admin/test", "POST", {input: $("test-input").value, model: $("test-model").value, stream: false});
    $("test-result").textContent = JSON.stringify(result, null, 2); await refresh();}
  catch (err) {$("test-result").textContent = err.message; await refresh(); throw err;}
});
document.querySelectorAll("[data-page]").forEach(n => n.addEventListener("click", () => page(n.dataset.page)));
document.querySelectorAll("[data-go]").forEach(n => n.addEventListener("click", () => page(n.dataset.go)));
document.querySelectorAll("[data-close]").forEach(n => n.addEventListener("click", () => $(n.dataset.close).close()));
$("connection-dialog").addEventListener("close", () => {$("connection-key").value = "";});
$("add-connection").addEventListener("click", () => editConnection());
$("add-model").addEventListener("click", () => editModel());
$("select-paid").addEventListener("click", () => {$("paid-models").querySelectorAll("input:not(:disabled)").forEach(n => n.checked = true);});
$("connection-provider").addEventListener("change", () => {$("connection-tier").value = "unconfirmed";$("connection-url").value = defaults[$("connection-provider").value];});
$("model-override-enabled").addEventListener("change", () => {$("override-field").hidden = !$("model-override-enabled").checked;});
$("add-fallback").addEventListener("click", () => {const m = state.models.find(m => m.id !== $("model-id").value && !fallbackIds.includes(m.id)); if (m) fallbackIds.push(m.id); renderFallbacks();});
$("logout").addEventListener("click", () => api("/admin/logout", "POST").then(() => {state = null; showLogin();}).catch(report));
$("refresh-records").addEventListener("click", () => loadRecords(true).catch(report));
$("more-records").addEventListener("click", () => loadRecords().catch(report));
$("clear-records").addEventListener("click", async () => {if (!confirm("입력·출력 본문을 포함한 모든 요청 기록을 삭제할까요?")) return;
  try {await api("/admin/records", "DELETE"); await loadRecords(true); notice("요청 기록을 삭제했습니다.");} catch (err) {report(err);}});
$("rotate-key").addEventListener("click", async () => {if (!confirm("기존 호출용 키를 폐기하고 새 키를 발급할까요?")) return;
  try {const result = await api("/admin/api-key/rotate", "POST"); $("new-key").textContent = result.api_key; $("new-key").hidden = false;} catch (err) {report(err);}});
refresh().catch(() => showLogin());
