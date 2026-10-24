import SwiftUI

struct BudgetOverview: Decodable, Identifiable {
    var id: String { scope }
    let scope: String
    let budgetUSD: String?
    let estimatedUSD: String
    let confirmedUSD: String?
    let reservedUSD: String
    let remainingUSD: String?
    let level: String
    let utilizationPercent: Double?
    let unknownCount: Int
    let unknownPriceCount: Int
    var stateLabel: String {
        switch level {
        case "warning": return "80% 경고"
        case "saving": return "90% 절약 모드"
        case "blocked": return "예산 소진 · 신규 요청 차단"
        case "inherited": return "전체 월간 한도 적용"
        case "unconfigured": return "예산 미설정"
        default: return "정상"
        }
    }
}
struct UsageRequest: Decodable, Identifiable {
    let id: String
    let at: String
    let provider: String
    let model: String
    let task: String
    let status: String
    let settlement: String
    let billingMode: String?
    let costStatus: String
    let estimatedUSD: String?
    let confirmedUSD: String?
    let reservedUSD: String
    let inputTokens: Int?
    let outputTokens: Int?
    let cachedTokens: Int?
    let cacheWriteTokens: Int?
    let reasoningTokens: Int?
    let exception: Bool
    let blockReason: String?
    let priceVersion: String
}
struct ModelUsage: Decodable, Identifiable {
    var id: String { provider + ":" + model }
    let provider: String
    let model: String
    let requests: Int
    let inputTokens: Int?
    let outputTokens: Int?
    let estimatedUSD: String?
    let confirmedUSD: String?
    let reservedUSD: String
}
struct ProviderBalance: Decodable, Identifiable {
    var id: String { provider }
    let provider: String
    let usd: String?
    let at: String
    let source: String
}
struct AccountUsageReport: Decodable, Identifiable {
    var id: String { provider }
    let provider: String
    let reportedUSD: String?
    let inputTokens: String?
    let outputTokens: String?
    let syncedAt: String
    let start: String
    let end: String
    let source: String
}
struct UsageSnapshot: Decodable {
    let month: String
    let source: String
    let updatedAt: String?
    let lastProviderSyncAt: String?
    let total: BudgetOverview
    let providers: [BudgetOverview]
    let requestBudgetUSD: String?
    let requests: [UsageRequest]
    let models: [ModelUsage]
    let balances: [ProviderBalance]
    let accountReports: [AccountUsageReport]
}

@MainActor final class UsageBudgetModel: ObservableObject {
    @Published var snapshot: UsageSnapshot?
    @Published var error: String?
    @Published var busy = false
    private let call: ([String: Any]) async throws -> Data
    init(call: @escaping ([String: Any]) async throws -> Data = { try await Runtime.shared.call($0) }) { self.call = call }
    func refresh() async { await perform(["method": "usage"]) }
    func save(scope: String, usd: String) async { await perform(["method": "budget-set", "scope": scope, "usd": usd]) }
    func syncAccount(_ provider: String) async { await perform(["method": "account-sync", "provider": provider]) }
    func syncBalance() async { await perform(["method": "balance-sync", "provider": "deepseek"]) }
    private func perform(_ request: [String: Any]) async {
        guard !busy else { return }
        busy = true; error = nil
        defer { busy = false }
        do { snapshot = try JSONDecoder().decode(UsageSnapshot.self, from: await call(request)) }
        catch { self.error = error.localizedDescription }
    }
}

struct UsageBudgetView: View {
    @Environment(\.dismiss) private var dismiss
    @StateObject private var model = UsageBudgetModel()
    @State private var scope = "openai"
    @State private var advancedScope = "total"
    @State private var advancedAmount = ""
    @State private var amount = ""
    private func usd(_ value: String?) -> String { value.map { "$" + $0 } ?? "미확인" }
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Text("사용량 및 예산 · USD").font(.title2.bold())
                Spacer()
                Button("새로고침") { Task { await model.refresh() } }.disabled(model.busy)
                Button("닫기") { dismiss() }
            }
            Text("Nidus의 로컬 요청 통제입니다. 외부 사용량과 최종 청구는 다를 수 있으며, 제공업체 청구액을 보장하지 않습니다.")
                .font(.callout).foregroundStyle(.secondary)
            HStack {
                Picker("예산", selection: $scope) {
                    ForEach(Provider.allCases) { p in Text(p.name + " 월간").tag(p.rawValue) }
                }.frame(width: 240)
                TextField("USD 금액", text: $amount).textFieldStyle(.roundedBorder).frame(width: 150)
                Button("예산 저장") { Task { await model.save(scope: scope, usd: amount) } }.disabled(model.busy || amount.isEmpty)
                if model.busy { ProgressView().controlSize(.small) }
            }
            DisclosureGroup("고급 설정 · 전체 월간 및 단일 요청 예산") {
                HStack {
                    Picker("범위", selection: $advancedScope) { Text("전체 월간").tag("total"); Text("단일 요청").tag("request") }.frame(width: 240)
                    TextField("USD 금액", text: $advancedAmount).textFieldStyle(.roundedBorder).frame(width: 150)
                    Button("고급 예산 저장") { Task { await model.save(scope: advancedScope, usd: advancedAmount) } }.disabled(model.busy || advancedAmount.isEmpty)
                }
            }
            Text("전체 월간·단일 요청 예산을 설정해야 유료 요청이 가능합니다. Provider 한도는 선택 사항이며 0은 차단입니다. 월 기준은 UTC입니다.").font(.caption)
            Text("안전한 예약을 위해 모델의 최대 입력 용량을 사용합니다. Gemini·DeepSeek는 추론을 포함한 최대 출력도 예약하므로 실제 예상 지출보다 클 수 있습니다. 무료 티어가 있어도 무료 잔량은 미확인입니다.")
                .font(.caption).foregroundStyle(.secondary)
            if let error = model.error { Text(error).foregroundStyle(.red).textSelection(.enabled) }
            if let data = model.snapshot {
                ScrollView {
                    VStack(alignment: .leading, spacing: 18) {
                        Text("\(data.month) · 단일 요청 예산 \(usd(data.requestBudgetUSD))").font(.headline)
                        ForEach(data.providers) { overview($0) }
                        DisclosureGroup("전체 월간 사용량") { overview(data.total) }
                        Divider()
                        Text("데이터 출처: \(data.source)").font(.caption)
                        Text("마지막 로컬 기록: \(data.updatedAt ?? "기록 없음")\n마지막 제공업체 조회: \(data.lastProviderSyncAt ?? "동기화 없음")").font(.caption)
                        Button("DeepSeek 잔여 USD 크레딧 조회") { Task { await model.syncBalance() } }.disabled(model.busy)
                        HStack {
                            Button("OpenAI 조직 사용량/비용 조회") { Task { await model.syncAccount("openai") } }
                            Button("Anthropic 조직 사용량/비용 조회") { Task { await model.syncAccount("anthropic") } }
                        }.disabled(model.busy)
                        Text("조직 조회는 별도 세션 NIDUS_OPENAI_ADMIN_API_KEY / NIDUS_ANTHROPIC_ADMIN_API_KEY가 필요합니다. 관리자 키는 저장하지 않고 추론 키를 재사용하지 않습니다. Gemini Cloud Billing은 미연결입니다.").font(.caption).foregroundStyle(.secondary)
                        Text("조직 집계는 외부 사용·조회 지연을 포함할 수 있으며 로컬 예산에 합산하지 않습니다. Anthropic Priority Tier 비용은 제외됩니다.").font(.caption).foregroundStyle(.secondary)
                        ForEach(data.accountReports) { report in
                            Text("\(report.provider) 조직 보고 금액 \(usd(report.reportedUSD)) · 입력 \(report.inputTokens ?? "미확인") · 출력 \(report.outputTokens ?? "미확인")\n범위: \(report.start) ~ \(report.end) · 조회: \(report.syncedAt)\n출처: \(report.source)").font(.caption).textSelection(.enabled)
                        }
                        ForEach(data.balances) { balance in
                            Text("\(balance.provider) 잔여 크레딧 \(usd(balance.usd)) · \(balance.at)\n출처: \(balance.source)").font(.caption)
                        }
                        Divider()
                        Text("모델별 월간 사용량").font(.headline)
                        ForEach(data.models) { item in
                            VStack(alignment: .leading) {
                                Text("\(item.provider) / \(item.model) · \(item.requests)회")
                                Text("입력 \(item.inputTokens.map(String.init) ?? "미보고") · 출력 \(item.outputTokens.map(String.init) ?? "미보고") · 추정 \(usd(item.estimatedUSD)) · 확인 \(usd(item.confirmedUSD)) · 예약 \(usd(item.reservedUSD))").font(.caption)
                            }
                        }
                        Divider()
                        Text("요청 기록 · 최근 200건 (전체 기록은 로컬 SQLite에 보관)").font(.headline)
                        ForEach(data.requests) { item in
                            VStack(alignment: .leading, spacing: 4) {
                                Text("\(item.provider) / \(item.model) · \(item.task) · \(item.status)").fontWeight(.medium)
                                Text("\(item.at) · \(item.id)").font(.caption.monospaced())
                                Text("\(item.billingMode == "free" ? "무료 프로젝트 (사용자 확인)" : "유료 정책") · 비용 \(item.costStatus) · 정산 \(item.settlement) · 추정 \(usd(item.estimatedUSD)) · 확인 \(usd(item.confirmedUSD)) · 예약 \(usd(item.reservedUSD))").font(.caption)
                                Text("입력 \(item.inputTokens.map(String.init) ?? "미보고") · 출력 \(item.outputTokens.map(String.init) ?? "미보고") · 캐시 읽기 \(item.cachedTokens.map(String.init) ?? "미보고") · 캐시 쓰기 \(item.cacheWriteTokens.map(String.init) ?? "미보고") · 추론 \(item.reasoningTokens.map(String.init) ?? "미보고")").font(.caption)
                                Text("가격 버전: \(item.priceVersion)").font(.caption2.monospaced())
                                if item.exception { Text("사용자 승인 예외").foregroundStyle(.orange) }
                                if let reason = item.blockReason { Text("차단: \(reason)").foregroundStyle(.orange) }
                            }.textSelection(.enabled).padding(10).frame(maxWidth: .infinity, alignment: .leading)
                                .background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: 8))
                        }
                    }.frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }.padding(24).frame(width: 940, height: 760)
            .task { await model.refresh() }
    }
    private func overview(_ item: BudgetOverview) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack {
                Text(item.scope == "total" ? "전체 월간" : item.scope.capitalized).font(.headline)
                Text("\(usd(item.budgetUSD)) · \(item.stateLabel)").foregroundStyle(item.level == "normal" ? Color.secondary : Color.orange)
                Spacer()
                Text(item.utilizationPercent.map { String(format: "%.1f%%", $0) } ?? "—")
            }
            ProgressView(value: min(item.utilizationPercent ?? 0, 100), total: 100)
            Text("Nidus 추정 \(usd(item.estimatedUSD)) · 제공업체 확인 \(usd(item.confirmedUSD)) · 예약 \(usd(item.reservedUSD)) · 사용 가능 \(usd(item.remainingUSD))").font(.caption)
            if item.unknownCount > 0 { Text("비용 미확인 \(item.unknownCount)건 — 예약 유지 (진행 중·중단·응답 누락 포함)").font(.caption).foregroundStyle(.orange) }
            if item.unknownPriceCount > 0 { Text("가격 또는 안전한 상한 미확인으로 차단된 요청 \(item.unknownPriceCount)건").font(.caption).foregroundStyle(.orange) }
        }.padding(12).background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: 10))
    }
}
