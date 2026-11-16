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
    func recordFreeUse(_ items: [RoutingSettingsSnapshot.TierModel], status: String, confirmed: Bool, completed: Set<String>) async -> Set<String> {
        guard !busy else { return completed }
        busy = true; error = nil
        defer { busy = false }
        var saved = completed
        for item in items where !saved.contains(item.id) {
            do {
                let data = try await call(["method": "free-use-set", "provider": item.provider, "model": item.modelID,
                    "status": status, "approved": false, "accountConfirmed": confirmed, "chargeRiskAccepted": false])
                snapshot = try JSONDecoder().decode(RoutingSettingsSnapshot.self, from: data)
                saved.insert(item.id)
            } catch { self.error = error.localizedDescription; break }
        }
        return saved
    }
    func policy(_ difficulty: String, _ tiers: [Int]) async {
        await perform(["method": "routing-policy-set", "difficulty": difficulty, "tiers": tiers])
    }
    func assign(_ item: RoutingSettingsSnapshot.TierModel, _ tier: Int?) async {
        await perform(["method": "model-tier-set", "provider": item.provider, "model": item.modelID, "tier": tier.map { $0 as Any } ?? NSNull()])
    }
}
struct RoutingSettingsView: View {
    var policyOnly = false
    @Environment(\.dismiss) private var dismiss
    @StateObject private var model = RoutingSettingsModel()
    @State private var search = ""
    @State private var freeUseSelection: RoutingSettingsSnapshot.TierModel?
    @State private var selected = Set<String>()
    @State private var showBulkFreeUse = false
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Text(policyOnly ? "Routing Policy" : "Model Tier").font(.title2.bold()).fixedSize(horizontal: false, vertical: true)
                Spacer()
                Button("로컬 설정 새로고침") { Task { await model.perform() } }.disabled(model.busy)
                Button("닫기") { dismiss() }
            }
            Text("Tier는 작업 적합성 분류이며 벤치마크 순위나 가격 등급이 아닙니다. 모델 탐색 목록과 비용 정보는 별도로 유지합니다.").font(.caption).fixedSize(horizontal: false, vertical: true)
            if let error = model.error { Text(error).foregroundStyle(.red).fixedSize(horizontal: false, vertical: true) }
            if let data = model.snapshot {
                GeometryReader { viewport in
                ScrollView(.vertical) {
                    VStack(alignment: .leading, spacing: 18) {
                        if policyOnly {
                            Text("계정 과금 유형과 Provider 실행 권한을 적용합니다. 금액 예산과 비용 예약은 사용하지 않습니다.").font(.caption).fixedSize(horizontal: false, vertical: true)
                            ForEach(Provider.allCases, id: \.self) { provider in AccountPermissionCard(provider: provider) }
                            ForEach(["simple", "normal", "complex"], id: \.self) { difficulty in
                                policy(difficulty, data.policies[difficulty] ?? [])
                            }
                        } else {
                            Text("Provider에서 발견한 모델 · \(data.models.count)개").font(.headline).fixedSize(horizontal: false, vertical: true)
                            TextField("Provider 또는 Model ID 검색", text: $search).textFieldStyle(.roundedBorder)
                            HStack {
                                Button("무료 지원 모델 전체 선택") {
                                    selected = freeStatusSelection(data.models)
                                }
                                Button("선택 해제") { selected.removeAll() }.disabled(selected.isEmpty)
                                Spacer()
                                Text("전체 목록 중 \(selected.count)개 선택").font(.caption).fixedSize(horizontal: false, vertical: true)
                                Button("선택 모델 무료 상태 기록") { showBulkFreeUse = true }.disabled(selectedModels.isEmpty)
                            }
                            Text("전체 선택은 검색어와 관계없이 조회된 무료 지원 모델에 적용됩니다. 저장 전에 선택 목록을 확인할 수 있습니다.").font(.caption).fixedSize(horizontal: false, vertical: true)
                            if data.models.isEmpty { Text("Provider를 연결해 모델 목록을 조회하세요. 설정 화면은 API를 호출하지 않습니다.").fixedSize(horizontal: false, vertical: true) }
                            LazyVStack(alignment: .leading, spacing: 12) {
                                ForEach(data.models.filter { search.isEmpty || $0.id.localizedCaseInsensitiveContains(search) }) { item in
                                    modelRow(item)
                                }
                            }
                        }
                    }.frame(width: max(0, viewport.size.width - 16), alignment: .leading)
                        .padding(.trailing, 16)
                }.frame(width: viewport.size.width, height: viewport.size.height).clipped()
                }.disabled(model.busy)
            }
            if model.busy { ProgressView().controlSize(.small) }
        }.padding(24).frame(width: min(940, (NSScreen.main?.visibleFrame.width ?? 1040) - 80),
                                  height: min(760, (NSScreen.main?.visibleFrame.height ?? 860) - 100)).task { await model.perform() }
        .sheet(isPresented: $showBulkFreeUse) { FreeUseEditor(items: selectedModels, model: model) }
        .sheet(item: $freeUseSelection) { item in
            FreeUseEditor(items: [item], model: model)
        }
    }
    private var selectedModels: [RoutingSettingsSnapshot.TierModel] {
        (model.snapshot?.models ?? []).filter { selected.contains($0.id) && $0.pricing.freeTier == "available" }
    }
    private func policy(_ difficulty: String, _ order: [Int]) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(difficulty.capitalized + " · " + (order.isEmpty ? "자동 라우팅 비활성" : order.map { "Tier \($0)" }.joined(separator: " → "))).font(.headline).fixedSize(horizontal: false, vertical: true)
            Text("핸들을 드래그해 우선순위를 변경하세요. 위에서부터 후보를 탐색합니다.").font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            ForEach(order, id: \.self) { tier in
                HStack(spacing: 12) {
                    Text("Tier \(tier)").font(.headline).frame(width: 60, alignment: .leading).fixedSize(horizontal: false, vertical: true)
                    HStack(spacing: 12) {
                        Image(systemName: "line.3.horizontal").foregroundStyle(.secondary)
                            .accessibilityLabel("Tier 순서 드래그 핸들")
                        Text(tierDescription(tier)).frame(maxWidth: .infinity, alignment: .leading).fixedSize(horizontal: false, vertical: true)
                        Button(role: .destructive) { Task { await model.policy(difficulty, order.filter { $0 != tier }) } } label: {
                            Image(systemName: "trash")
                        }.buttonStyle(.borderless).help("Tier \(tier) 제외").accessibilityLabel("Tier \(tier) 제외")
                    }.padding(12).background(.background, in: RoundedRectangle(cornerRadius: 8))
                }.contentShape(Rectangle())
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
            Toggle(isOn: Binding(get: { selected.contains(item.id) }, set: { if $0 { selected.insert(item.id) } else { selected.remove(item.id) } })) {
                Text("\(item.provider) / \(item.modelID)").font(.headline).fixedSize(horizontal: false, vertical: true)
            }.disabled(item.pricing.freeTier != "available")
            VStack(alignment: .leading, spacing: 6) {
                Picker("Tier", selection: Binding(get: { item.tierAssignment.tier }, set: { value in Task { await model.assign(item, value) } })) {
                    ForEach(0...3, id: \.self) { Text(tierLabel($0)).tag($0) }
                }.frame(maxWidth: 320)
                Button("기본 분류 복원") { Task { await model.assign(item, nil) } }.disabled(!item.tierAssignment.userModified)
                Text(item.tierAssignment.userModified ? "사용자 지정" : "공식 자료 기반 기본 분류").font(.caption).fixedSize(horizontal: false, vertical: true)
            }
            Text("Chat \(item.capabilities.chat) · Vision \(item.capabilities.vision) · Tools \(item.capabilities.tools) · Streaming \(item.capabilities.streaming)").font(.caption).fixedSize(horizontal: false, vertical: true)
            Text("최근 실행: \(item.health.status) · \(item.health.checkedAt ?? "검사 없음") · \(item.health.available ? "일시 제외 없음 (실행 성공 미보장)" : "일시 제외 중")").font(.caption).fixedSize(horizontal: false, vertical: true)
            if let source = item.tierAssignment.source, source != "user", let url = URL(string: source) { Link("Tier 근거 · \(item.tierAssignment.checkedAt ?? "미확인")", destination: url).font(.caption) }
            if item.tierAssignment.source == nil { Text("공식 Tier 근거 미확인").font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true) }
            if item.pricing.rates.isEmpty { Text("유료 가격 미확인 — 무료 실행은 별도의 계정·모델 조건 확인이 필요합니다.").font(.caption).foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true) }
            ForEach(Array(item.pricing.rates.enumerated()), id: \.offset) { _, rate in
                Text("\(rate.tier): 입력 $\(rate.input.formatted()) / 출력 $\(rate.output.formatted()) · USD/백만 토큰").font(.caption).fixedSize(horizontal: false, vertical: true)
            }
            Text("무료 티어: \(item.pricing.freeTier ?? "unknown") · 확인 상태: \(item.freeUse?.status ?? "unverified")").font(.caption).fixedSize(horizontal: false, vertical: true)
            Text("마지막 확인: \(item.freeUse?.checkedAt ?? "없음") · 확인 방식: \(item.freeUse?.verification ?? "not-verified")").font(.caption).fixedSize(horizontal: false, vertical: true)
            Text(item.freeUse?.conditions ?? "현재 계정의 무료 사용 가능 여부는 미확인입니다.").font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            if item.freeUse?.status == "unverified" { Text("무료 할당량 미확인 — Free Only 계정 확인이 필요합니다. Hybrid·Paid Only는 Provider 유료 승인으로 실행합니다.").font(.caption).foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true) }
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
    let items: [RoutingSettingsSnapshot.TierModel]
    @ObservedObject var model: RoutingSettingsModel
    @Environment(\.dismiss) private var dismiss
    @State private var status = "unverified"
    @State private var completed = Set<String>()
    @State private var accountConfirmed = false
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("무료 사용 상태 기록 · \(items.count)개 모델").font(.headline).fixedSize(horizontal: false, vertical: true)
            ScrollView {
                VStack(alignment: .leading) {
                    ForEach(items) { item in Text("\(item.provider) / \(item.modelID)" + (completed.contains(item.id) ? " · 저장 완료" : "")).fixedSize(horizontal: false, vertical: true) }
                }.frame(maxWidth: .infinity, alignment: .leading)
            }.frame(height: 140)
            Picker("무료 사용 상태", selection: $status) {
                Text("unverified · 현재 계정 미확인").tag("unverified")
                Text("verified · 공식 조건 및 현재 계정 직접 확인").tag("verified")
                Text("unavailable · 무료 소진 또는 사용 불가 확인").tag("unavailable")
            }
            .disabled(model.busy)
            if status != "unverified" {
                Toggle("공식 조건과 현재 API 키의 계정·프로젝트 상태를 직접 확인했습니다", isOn: $accountConfirmed).fixedSize(horizontal: false, vertical: true)
            }
            Text("사용자 확인 기록이며 Provider API 검증 결과가 아닙니다. 남은 무료 요청 수를 자동 조회하지 않습니다.").font(.caption).fixedSize(horizontal: false, vertical: true)
            Text("계정 과금 유형과 실행 권한은 Routing Policy 메뉴에서 관리합니다. 모델의 무료 할당량 소진을 unavailable로 기록하면 Free Only 호출에서 제외합니다. 모델별 확인은 Provider 유료 승인을 대신하지 않습니다.").font(.callout).fixedSize(horizontal: false, vertical: true)
            if let error = model.error { Text("\(completed.count)/\(items.count)개 저장 완료. 나머지는 저장되지 않았습니다. 다시 저장하면 미완료 모델부터 처리합니다.\n\(error)").foregroundStyle(.red).fixedSize(horizontal: false, vertical: true) }
            HStack {
                Spacer()
                Button("취소") { dismiss() }.disabled(model.busy)
                Button("무료 사용 상태 저장") {
                    Task {
                        completed = await model.recordFreeUse(items, status: status, confirmed: accountConfirmed, completed: completed)
                        if model.error == nil { dismiss() }
                    }
                }.disabled(model.busy || items.isEmpty || (status != "unverified" && !accountConfirmed))
            }
        }.padding(24).frame(width: 720).interactiveDismissDisabled(model.busy)
            .onAppear { status = items.count == 1 ? (items.first?.freeUse?.status ?? "unverified") : "unverified" }
            .onChange(of: status) { _ in accountConfirmed = false; completed.removeAll() }
    }
}

func tierDescription(_ tier: Int) -> String {
    switch tier {
    case 1: return "Lightweight · 간단한 작업에 유리"
    case 2: return "General · 일반 작업에 유리"
    case 3: return "Advanced · 복잡한 추론·설계에 유리"
    default: return "Unclassified · 미분류"
    }
}

func freeStatusSelection(_ models: [RoutingSettingsSnapshot.TierModel]) -> Set<String> {
    Set(models.filter { $0.pricing.freeTier == "available" }.map(\.id))
}
