import SwiftUI

func tierLabel(_ tier: Int) -> String {
    switch tier { case 1: return "Tier 1 · Lightweight"; case 2: return "Tier 2 · General"; case 3: return "Tier 3 · Advanced"; default: return "Unclassified" }
}
struct RoutingSettingsSnapshot: Decodable {
    let accounts: [AccountPermission]?
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
                        Text("계정 과금 유형과 Provider 실행 권한을 적용합니다. 금액 예산과 비용 예약은 사용하지 않습니다.").font(.caption)
                        ForEach(Provider.allCases, id: \.self) { provider in AccountPermissionCard(provider: provider) }
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
            if item.freeUse?.status == "unverified" { Text("무료 할당량 미확인 — Free Only 계정 확인이 필요합니다. Hybrid·Paid Only는 Provider 유료 승인으로 실행합니다.").font(.caption).foregroundStyle(.orange) }
            if let source = item.freeUse?.source, let url = URL(string: source) { Link("무료 사용 공식 조건", destination: url).font(.caption) }
            Button("모델 무료 사용 상태 확인") { freeUseSelection = item }
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
        @State private var accountConfirmed = false
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
            Text("계정 과금 유형은 위의 Provider 설정에서 관리합니다. 모델의 무료 할당량 소진을 unavailable로 기록하면 Free Only 호출에서 제외합니다. 모델별 확인은 Provider 유료 승인을 대신하지 않습니다.").font(.callout)
            if let error = model.error { Text(error).foregroundStyle(.red) }
            HStack {
                Spacer()
                Button("취소") { dismiss() }
                Button("무료 사용 상태 저장") {
                    Task {
                        await model.perform(["method": "free-use-set", "provider": item.provider, "model": item.modelID,
                            "status": status, "approved": false, "accountConfirmed": accountConfirmed, "chargeRiskAccepted": false])
                        if model.error == nil { dismiss() }
                    }
                }.disabled(model.busy || (status != "unverified" && !accountConfirmed))
            }
        }.padding(24).frame(width: 620)
            .onAppear { status = item.freeUse?.status ?? "unverified" }
            .onChange(of: status) { _ in accountConfirmed = false }
    }
}
