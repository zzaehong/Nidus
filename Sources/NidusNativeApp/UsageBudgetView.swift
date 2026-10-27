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
        case "blocked": return "이전 예산 소진"
        case "inherited": return "이전 전체 월간 한도"
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
struct SoftBudgetOverview: Decodable, Identifiable {
    var id: String { provider }
    let provider: String
    let targetUSD: String?
    let updatedAt: String?
    let usage: Usage
    let utilizationPercent: Double?
    let knownUtilizationPercent: Double?
    let state: String
    struct Usage: Decodable {
        let requests: Int
        let inputTokens: Int?
        let outputTokens: Int?
        let estimatedUSD: String?
        let confirmedUSD: String?
        let knownSpendUSD: String?
        let unknownCostRequests: Int
    }
}
struct UsageSnapshot: Decodable {
    let softBudgets: [SoftBudgetOverview]?
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
    func setSoftBudget(_ provider: String, usd: String?) async {
        await perform(["method": "soft-budget-set", "provider": provider, "usd": usd.map { $0 as Any } ?? NSNull()])
    }
    func refresh() async { await perform(["method": "usage"]) }
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
    private func usd(_ value: String?) -> String { value.map { "$" + $0 } ?? "미확인" }
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Text("사용량 및 비용 · USD").font(.title2.bold())
                Spacer()
                Button("새로고침") { Task { await model.refresh() } }.disabled(model.busy)
                Button("닫기") { dismiss() }
            }
            Text("사용량과 추정 비용을 기록합니다. 앱에서 지출을 제한하지 않으므로 제공업체의 과금 설정을 확인하세요.").font(.callout).foregroundStyle(.secondary)
            if let error = model.error { Text(error).foregroundStyle(.red).textSelection(.enabled) }
            if let data = model.snapshot {
                ScrollView {
                    VStack(alignment: .leading, spacing: 18) {
                        Text(data.month + " / USD").font(.headline)
                        Text("Provider별 월간 목표 예산 · 참고용").font(.headline)
                        Text("목표를 초과해도 호출을 차단하거나 모델을 강제로 전환하지 않습니다. 외부 API 사용량은 포함하지 않습니다.")
                            .font(.caption).fixedSize(horizontal: false, vertical: true)
                        ForEach(data.softBudgets ?? []) { item in
                            SoftBudgetCard(item: item, model: model)
                        }
                        DisclosureGroup("기존 Provider 사용량 및 과거 예약 기록") {
                            ForEach(data.providers) { overview($0) }
                        }
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
                        Text("조직 집계는 외부 사용·조회 지연을 포함할 수 있으며 로컬 사용량에 합산하지 않습니다. Anthropic Priority Tier 비용은 제외됩니다.").font(.caption).foregroundStyle(.secondary)
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
                                Text("입력 \(item.inputTokens.map(String.init) ?? "미보고") · 출력 \(item.outputTokens.map(String.init) ?? "미보고") · 추정 \(usd(item.estimatedUSD)) · 확인 \(usd(item.confirmedUSD)) · 이전 예약 기록 \(usd(item.reservedUSD))").font(.caption)
                            }
                        }
                        Divider()
                        Text("요청 기록 · 최근 200건 (전체 기록은 로컬 SQLite에 보관)").font(.headline)
                        ForEach(data.requests) { item in
                            VStack(alignment: .leading, spacing: 4) {
                                Text("\(item.provider) / \(item.model) · \(item.task) · \(item.status)").fontWeight(.medium)
                                Text("\(item.at) · \(item.id)").font(.caption.monospaced())
                                Text("\(item.billingMode == "free" ? "무료 프로젝트 (사용자 확인)" : "유료 또는 비용 미확인") · 비용 \(item.costStatus) · 정산 \(item.settlement) · 추정 \(usd(item.estimatedUSD)) · 확인 \(usd(item.confirmedUSD)) · 이전 예약 기록 \(usd(item.reservedUSD))").font(.caption)
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
                Spacer()
            }
            Text("추정 \(usd(item.estimatedUSD)) / 확인 \(usd(item.confirmedUSD)) / 이전 예약 기록 \(usd(item.reservedUSD))").font(.caption)
            if item.unknownCount > 0 { Text("비용 미확인 \(item.unknownCount)건 — 진행 중·중단·응답 누락 포함").font(.caption).foregroundStyle(.orange) }
            if item.unknownPriceCount > 0 { Text("이전 가격 미확인 차단 기록 \(item.unknownPriceCount)건").font(.caption).foregroundStyle(.orange) }
        }.padding(12).background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: 10))
    }
}

private struct SoftBudgetCard: View {
    let item: SoftBudgetOverview
    @ObservedObject var model: UsageBudgetModel
    @State private var amount = ""
    private func usd(_ value: String?) -> String { value.map { "$" + $0 } ?? "미확인" }
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(item.provider.capitalized).font(.headline)
                Spacer()
                TextField("월간 목표 USD · 미설정 가능", text: $amount).textFieldStyle(.roundedBorder).frame(width: 240)
                Button("저장") { Task { await model.setSoftBudget(item.provider, usd: amount.trimmingCharacters(in: .whitespaces)) } }
                    .disabled(model.busy || amount.trimmingCharacters(in: .whitespaces).isEmpty)
                Button("삭제") { Task { await model.setSoftBudget(item.provider, usd: nil) } }.disabled(model.busy || item.targetUSD == nil)
            }
            Text("현재 목표: \(item.targetUSD.map { "$" + $0 } ?? "미설정") · 이번 달 \(item.usage.requests)회")
            Text("추정 비용 \(usd(item.usage.estimatedUSD)) · 확인된 비용 \(usd(item.usage.confirmedUSD)) · 중복 제외 사용액 \(usd(item.usage.knownSpendUSD))").font(.caption)
            if let percent = item.utilizationPercent {
                Text("기록된 사용액 기준 \(percent.formatted())% · 최종 청구와 다를 수 있음").font(.caption)
            } else if let percent = item.knownUtilizationPercent {
                Text("알려진 비용만 기준 \(percent.formatted())% · 비용 누락으로 전체 사용률 미확정").font(.caption).foregroundStyle(.orange)
            } else { Text("사용률 미확정 · 예산 미설정, 0 USD 목표 또는 사용 기록 없음").font(.caption) }
            if item.state == "exceeded" { Text("목표 예산 초과 · 참고 경고이며 실행을 차단하지 않습니다.").foregroundStyle(.orange) }
            if item.usage.unknownCostRequests > 0 { Text("비용 미확인 \(item.usage.unknownCostRequests)건").font(.caption).foregroundStyle(.orange) }
            Text("입력 \(item.usage.inputTokens.map(String.init) ?? "미확인") · 출력 \(item.usage.outputTokens.map(String.init) ?? "미확인") 토큰 · 설정 변경 \(item.updatedAt ?? "없음")").font(.caption)
        }.fixedSize(horizontal: false, vertical: true).padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: 10))
            .onAppear { amount = item.targetUSD ?? "" }
            .onChange(of: item.targetUSD) { value in amount = value ?? "" }
    }
}
