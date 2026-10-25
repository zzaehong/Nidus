import SwiftUI

func tierLabel(_ tier: Int) -> String {
    switch tier { case 1: return "Tier 1 · Lightweight"; case 2: return "Tier 2 · General"; case 3: return "Tier 3 · Advanced"; default: return "Unclassified" }
}
struct RoutingSettingsSnapshot: Decodable {
    let providerPlans: [ProviderPlan]?
    struct ProviderPlan: Decodable, Identifiable {
        var id: String { provider }
        let provider: String; let state: String; let checkedAt: String?; let source: String; let conditions: String
    }
    let geminiBilling: GeminiBilling?
    struct GeminiBilling: Decodable { let state: String; let project: String; let checkedAt: String? }
    let allowPaid: Bool
    let policies: [String: [Int]]
    let models: [TierModel]
    struct TierModel: Decodable, Identifiable {
        var id: String { provider + ":" + modelID }
        let provider: String
        let modelID: String
        let capabilities: APIModel.Capabilities
        let pricing: APIModel.Price
        let tierAssignment: Assignment
        let freeUse: FreeUse?
        let health: Health
        enum CodingKeys: String, CodingKey { case provider, modelID = "id", capabilities, pricing, tierAssignment, health, freeUse }
        struct FreeUse: Decodable {
            let status: String
            let approved: Bool
            let checkedAt: String?
            let source: String
            let conditions: String
            let verification: String
        }
        struct Assignment: Decodable { let tier: Int; let source: String?; let checkedAt: String?; let userModified: Bool }
        struct Health: Decodable { let status: String; let available: Bool; let checkedAt: String? }
    }
}
@MainActor final class RoutingSettingsModel: ObservableObject {
    @Published var snapshot: RoutingSettingsSnapshot?
    @Published var busy = false
    @Published var error: String?
    private let call: ([String: Any]) async throws -> Data
    init(call: @escaping ([String: Any]) async throws -> Data = { try await Runtime.shared.call($0) }) { self.call = call }
    func perform(_ request: [String: Any] = ["method": "routing-settings"]) async {
        guard !busy else { return }
        busy = true; error = nil
        defer { busy = false }
        do { snapshot = try JSONDecoder().decode(RoutingSettingsSnapshot.self, from: await call(request)) }
        catch { self.error = error.localizedDescription }
    }
    func policy(_ difficulty: String, _ tiers: [Int]) async {
        await perform(["method": "routing-policy-set", "difficulty": difficulty, "tiers": tiers])
    }
    func assign(_ item: RoutingSettingsSnapshot.TierModel, _ tier: Int?) async {
        await perform(["method": "model-tier-set", "provider": item.provider, "model": item.modelID, "tier": tier.map { $0 as Any } ?? NSNull()])
    }
}
struct RoutingSettingsView: View {
    @Environment(\.dismiss) private var dismiss
    @StateObject private var model = RoutingSettingsModel()
    @State private var search = ""
    @State private var billingEditor = false
    @State private var planSelection: RoutingSettingsSnapshot.ProviderPlan?
    @State private var freeUseSelection: RoutingSettingsSnapshot.TierModel?
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Text("Model Tier 및 Routing Policy").font(.title2.bold())
                Spacer()
                Button("로컬 설정 새로고침") { Task { await model.perform() } }.disabled(model.busy)
                Button("닫기") { dismiss() }
            }
            Text("Tier는 작업 적합성 분류이며 벤치마크 순위나 가격 등급이 아닙니다. 모델 탐색 목록과 비용 정보는 별도로 유지합니다.").font(.caption)
            if let error = model.error { Text(error).foregroundStyle(.red) }
            if let data = model.snapshot {
                ScrollView {
                    VStack(alignment: .leading, spacing: 18) {
                        Text("무료 상태는 비용 추정에만 사용합니다. 예산이나 무료 승인 여부로 호출 및 모델 전환을 차단하지 않습니다.").font(.caption)
                        Text("Gemini 프로젝트: \(data.geminiBilling?.state ?? "unknown") · \(data.geminiBilling?.project ?? "미설정")").font(.headline)
                        Text("확인 시각: \(data.geminiBilling?.checkedAt ?? "없음") · 남은 무료 할당량은 조회되지 않습니다.").font(.caption)
                        Button("Gemini 프로젝트 결제 상태 설정") { billingEditor = true }
                        ForEach((data.providerPlans ?? []).filter { ["nvidia", "groq", "mistral", "cloudflare"].contains($0.provider) }) { plan in
                            VStack(alignment: .leading, spacing: 6) {
                                Text("\(Provider(rawValue: plan.provider)?.name ?? plan.provider) · \(plan.state)").font(.headline)
                                Text(plan.conditions).font(.caption)
                                Text("사용자 확인: \(plan.checkedAt ?? "없음") · 남은 무료 할당량 미조회").font(.caption)
                                Button("계정 플랜 확인 / 변경") { planSelection = plan }
                            }.padding(12).frame(maxWidth: .infinity, alignment: .leading).background(.quaternary.opacity(0.3), in: RoundedRectangle(cornerRadius: 10))
                        }
                        ForEach(["simple", "normal", "complex"], id: \.self) { difficulty in
                            policy(difficulty, data.policies[difficulty] ?? [])
                        }
                        Divider()
                        Text("Provider에서 발견한 모델 · \(data.models.count)개").font(.headline)
                        TextField("Provider 또는 Model ID 검색", text: $search).textFieldStyle(.roundedBorder)
                        if data.models.isEmpty { Text("Provider를 연결해 모델 목록을 조회하세요. 설정 화면은 API를 호출하지 않습니다.") }
                        LazyVStack(alignment: .leading, spacing: 12) {
                            ForEach(data.models.filter { search.isEmpty || $0.id.localizedCaseInsensitiveContains(search) }) { item in
                                modelRow(item)
                            }
                        }
                    }.frame(maxWidth: .infinity, alignment: .leading)
                }.disabled(model.busy)
            }
            if model.busy { ProgressView().controlSize(.small) }
        }.padding(24).frame(width: 940, height: 760).task { await model.perform() }
        .sheet(item: $planSelection) { ProviderPlanEditor(plan: $0, model: model) }
        .sheet(isPresented: $billingEditor) { GeminiBillingEditor(model: model) }
        .sheet(item: $freeUseSelection) { item in
            FreeUseEditor(item: item, model: model)
        }
    }
    private func policy(_ difficulty: String, _ order: [Int]) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(difficulty.capitalized + " · " + (order.isEmpty ? "자동 라우팅 비활성" : order.map { "Tier \($0)" }.joined(separator: " → "))).font(.headline)
            ForEach(Array(order.enumerated()), id: \.element) { index, tier in
                HStack {
                    Image(systemName: "line.3.horizontal").accessibilityLabel("Tier 순서 드래그 핸들")
                    Text(tierLabel(tier))
                    Button("위로") { var next = order; next.swapAt(index, index - 1); Task { await model.policy(difficulty, next) } }.disabled(index == 0)
                    Button("아래로") { var next = order; next.swapAt(index, index + 1); Task { await model.policy(difficulty, next) } }.disabled(index == order.count - 1)
                    Button("제외") { Task { await model.policy(difficulty, order.filter { $0 != tier }) } }
                }
                .draggable("nidus-tier:\(difficulty):\(tier)")
                .dropDestination(for: String.self) { values, _ in
                    guard !model.busy, let next = reorderedTiers(order, difficulty: difficulty, payloads: values, target: tier) else { return false }
                    Task { await model.policy(difficulty, next) }
                    return true
                }
            }
            HStack {
                ForEach([1, 2, 3].filter { !order.contains($0) }, id: \.self) { tier in
                    Button("Tier \(tier) 추가") { Task { await model.policy(difficulty, order + [tier]) } }
                }
            }
        }.padding(12).frame(maxWidth: .infinity, alignment: .leading).background(.quaternary.opacity(0.3), in: RoundedRectangle(cornerRadius: 10))
    }
    private func modelRow(_ item: RoutingSettingsSnapshot.TierModel) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("\(item.provider) / \(item.modelID)").font(.headline).textSelection(.enabled)
            HStack {
                Picker("Tier", selection: Binding(get: { item.tierAssignment.tier }, set: { value in Task { await model.assign(item, value) } })) {
                    ForEach(0...3, id: \.self) { Text(tierLabel($0)).tag($0) }
                }.frame(width: 320)
                Button("기본 분류 복원") { Task { await model.assign(item, nil) } }.disabled(!item.tierAssignment.userModified)
                Text(item.tierAssignment.userModified ? "사용자 지정" : "공식 자료 기반 기본 분류").font(.caption)
            }
            Text("Chat \(item.capabilities.chat) · Vision \(item.capabilities.vision) · Tools \(item.capabilities.tools) · Streaming \(item.capabilities.streaming)").font(.caption)
            Text("최근 실행: \(item.health.status) · \(item.health.checkedAt ?? "검사 없음") · \(item.health.available ? "일시 제외 없음 (실행 성공 미보장)" : "일시 제외 중")").font(.caption)
            if let source = item.tierAssignment.source, source != "user", let url = URL(string: source) { Link("Tier 근거 · \(item.tierAssignment.checkedAt ?? "미확인")", destination: url).font(.caption) }
            if item.tierAssignment.source == nil { Text("공식 Tier 근거 미확인").font(.caption).foregroundStyle(.secondary) }
            if item.pricing.rates.isEmpty { Text("유료 가격 미확인 — 무료 실행은 별도의 계정·모델 조건 확인이 필요합니다.").font(.caption).foregroundStyle(.orange) }
            ForEach(Array(item.pricing.rates.enumerated()), id: \.offset) { _, rate in
                Text("\(rate.tier): 입력 $\(rate.input.formatted()) / 출력 $\(rate.output.formatted()) · USD/백만 토큰").font(.caption)
            }
            Text("무료 티어: \(item.pricing.freeTier ?? "unknown") · 확인 상태: \(item.freeUse?.status ?? "unverified")").font(.caption)
            Text("마지막 확인: \(item.freeUse?.checkedAt ?? "없음") · 확인 방식: \(item.freeUse?.verification ?? "not-verified")").font(.caption)
            Text(item.freeUse?.conditions ?? "현재 계정의 무료 사용 가능 여부는 미확인입니다.").font(.caption).foregroundStyle(.secondary)
            if item.freeUse?.status == "unverified" { Text("무료 할당량 미확인 — Gemini 프로젝트 Free 설정은 별도 관리됩니다. 모델별 승인 자체는 비용을 0원으로 바꾸지 않습니다.").font(.caption).foregroundStyle(.orange) }
            if let source = item.freeUse?.source, let url = URL(string: source) { Link("무료 사용 공식 조건", destination: url).font(.caption) }
            Button(item.freeUse?.approved == true ? "무료 비용 추정 설정 변경" : "무료 비용 추정 설정") { freeUseSelection = item }
                .disabled(item.pricing.freeTier != "available")
        }.padding(12).frame(maxWidth: .infinity, alignment: .leading).background(.quaternary.opacity(0.3), in: RoundedRectangle(cornerRadius: 10))
    }
}

// Accept only a single tier from this difficulty. Unrelated/external drops never modify policy.
func reorderedTiers(_ order: [Int], difficulty: String, payloads: [String], target: Int) -> [Int]? {
    guard payloads.count == 1, let payload = payloads.first else { return nil }
    let parts = payload.split(separator: ":")
    guard parts.count == 3, parts[0] == "nidus-tier", parts[1] == difficulty,
          let tier = Int(parts[2]), let from = order.firstIndex(of: tier), let to = order.firstIndex(of: target), from != to else { return nil }
    var next = order
    next.remove(at: from); next.insert(tier, at: to)
    return next
}

private struct FreeUseEditor: View {
    let item: RoutingSettingsSnapshot.TierModel
    @ObservedObject var model: RoutingSettingsModel
    @Environment(\.dismiss) private var dismiss
    @State private var status = "unverified"
    @State private var approved = false
    @State private var accountConfirmed = false
    @State private var riskAccepted = false
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("\(item.provider) / \(item.modelID)").font(.headline)
            Picker("무료 사용 상태", selection: $status) {
                Text("unverified · 현재 계정 미확인").tag("unverified")
                Text("verified · 공식 조건 및 현재 계정 직접 확인").tag("verified")
                Text("unavailable · 무료 소진 또는 사용 불가 확인").tag("unavailable")
            }
            if status != "unverified" {
                Toggle("공식 조건과 현재 API 키의 계정·프로젝트 상태를 직접 확인했습니다", isOn: $accountConfirmed)
            }
            Text("사용자 확인 기록이며 Provider API 검증 결과가 아닙니다. 남은 무료 요청 수를 자동 조회하지 않습니다.").font(.caption)
            Toggle("이 모델의 무료 사용 확인을 비용 추정에 반영", isOn: $approved).disabled(status == "unavailable")
            Text("무료 비용 추정에는 계정 플랜과 모델의 무료 사용 확인이 필요합니다. 이 설정은 선택 사항이며 호출 허가나 지출 제한으로 사용하지 않습니다. 실제 과금될 수 있습니다.").font(.callout)
            if approved { Toggle("이 설정이 실제 과금을 보증하지 않음을 이해합니다", isOn: $riskAccepted) }
            if let error = model.error { Text(error).foregroundStyle(.red) }
            HStack {
                Spacer()
                Button("취소") { dismiss() }
                Button("무료 비용 정보 저장") {
                    Task {
                        await model.perform(["method": "free-use-set", "provider": item.provider, "model": item.modelID,
                            "status": status, "approved": approved, "accountConfirmed": accountConfirmed, "chargeRiskAccepted": riskAccepted])
                        if model.error == nil { dismiss() }
                    }
                }.disabled(model.busy || (status != "unverified" && !accountConfirmed) || (approved && !riskAccepted))
            }
        }.padding(24).frame(width: 620)
            .onAppear { status = item.freeUse?.status ?? "unverified"; approved = item.freeUse?.approved ?? false }
            .onChange(of: status) { _ in accountConfirmed = false; if status == "unavailable" { approved = false } }
    }
}

private struct GeminiBillingEditor: View {
    @ObservedObject var model: RoutingSettingsModel
    @Environment(\.dismiss) private var dismiss
    @State private var state = "unknown"
    @State private var project = ""
    @State private var confirmed = false
    @State private var risk = false
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Gemini 프로젝트 결제 상태").font(.headline)
            Picker("결제 상태", selection: $state) {
                Text("Unknown · 미확인").tag("unknown")
                Text("Free · 무료 프로젝트 직접 확인").tag("free")
                Text("Paid · 유료 프로젝트").tag("paid")
            }
            TextField("현재 API 키의 Google 프로젝트 ID", text: $project)
            Link("Google AI Studio에서 프로젝트 확인", destination: URL(string: "https://aistudio.google.com/projects")!)
            Text("Free 설정 시 공식 무료 지원 모델의 비용을 무료로 추정합니다. Paid·Unknown은 유료 단가로 추정하며, 가격을 모르면 미확인으로 기록합니다. 남은 할당량은 알 수 없습니다.")
            if state == "free" {
                Toggle("현재 API 키의 프로젝트가 Google에서 Free Tier임을 확인했습니다", isOn: $confirmed)
                Toggle("실제 Billing 상태를 보증하지 않으며, 설정이 틀리면 과금될 수 있음을 이해합니다", isOn: $risk)
                Text("Google에서 결제를 활성화하거나 프로젝트를 변경하면 이 설정을 즉시 변경하세요. API 키 재연결 시 초기화됩니다.").font(.caption).foregroundStyle(.orange)
            }
            if let error = model.error { Text(error).foregroundStyle(.red) }
            HStack {
                Button("취소") { dismiss() }
                Button("저장") { Task {
                    await model.perform(["method": "gemini-billing-set", "state": state, "project": project, "confirmed": confirmed, "riskAccepted": risk])
                    if model.error == nil { dismiss() }
                }}.disabled(model.busy || (state == "free" && (project.isEmpty || !confirmed || !risk)))
            }
        }.padding(24).frame(width: 650)
        .onAppear { state = model.snapshot?.geminiBilling?.state ?? "unknown"; project = model.snapshot?.geminiBilling?.project ?? "" }
        .onChange(of: state) { _ in confirmed = false; risk = false }
        .onChange(of: project) { _ in confirmed = false; risk = false }
    }
}

private struct ProviderPlanEditor: View {
    let plan: RoutingSettingsSnapshot.ProviderPlan
    @ObservedObject var model: RoutingSettingsModel
    @Environment(\.dismiss) private var dismiss
    @State private var state = "unknown"
    @State private var confirmed = false
    @State private var risk = false
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("\(plan.provider) 계정 플랜").font(.headline)
            Picker("플랜", selection: $state) {
                Text("Unknown · 미확인").tag("unknown")
                Text("Free · 무료 / 실험 플랜").tag("free")
                Text("Paid · 유료 플랜").tag("paid")
            }
            Text(plan.conditions)
            Link("공식 무료 사용 조건", destination: URL(string: plan.source)!)
            Text("무료 비용 추정을 원하면 Free 플랜과 모델별 무료 상태를 확인하세요. 설정하지 않아도 호출할 수 있으며, 무료로 추정하지 않습니다. 자동 라우팅의 Tier는 별도로 배정합니다.")
            if state == "free" {
                Toggle("현재 키의 계정이 무료 플랜이며 유료 초과 과금이 활성화되지 않았음을 확인했습니다", isOn: $confirmed)
                Toggle("사용자 확인은 실제 Billing 보증이 아니며, 잘못 설정하면 과금될 수 있음을 이해합니다", isOn: $risk)
            }
            Text("남은 할당량은 조회하지 않습니다. 플랜 변경 시 이 설정을 변경하세요. 키 재연결 시 무료 확인과 모델별 승인이 해제됩니다.").font(.caption)
            if let error = model.error { Text(error).foregroundStyle(.red) }
            HStack {
                Button("취소") { dismiss() }
                Button("저장") { Task {
                    await model.perform(["method":"provider-plan-set", "provider":plan.provider, "state":state, "confirmed":confirmed, "riskAccepted":risk])
                    if model.error == nil { dismiss() }
                }}.disabled(model.busy || (state == "free" && (!confirmed || !risk)))
            }
        }.padding(24).frame(width: 650)
        .onAppear { state = plan.state }
        .onChange(of: state) { _ in confirmed = false; risk = false }
    }
}
