import SwiftUI

struct HealthChecksView: View {
    @EnvironmentObject var dashboard: Dashboard
    @Environment(\.dismiss) private var dismiss
    let initialProvider: Provider
    var targetModelIDs: Set<String>? = nil
    @State private var allProviders = false
    @State private var allowInferred = false
    @State private var onlyUntested = true
    @State private var limit = 20
    @State private var confirm = false
    @State private var resultsOnly = false
    @State private var resultFilter = "all"
    @State private var search = ""
    @State private var budget = "1.00"
    @State private var allowUnknownPrice = false
    private var budgetValue: Double? { Double(budget).flatMap { $0.isFinite && $0 > 0 ? $0 : nil } }
    private var providers: [Provider] { allProviders ? Provider.allCases : [initialProvider] }
    private var plan: [HealthRow] { dashboard.healthPlan(providers: providers, allowInferred: allowInferred, limit: limit, onlyUntested: targetModelIDs == nil && onlyUntested, allowUnknownPrice: allowUnknownPrice, modelIDs: targetModelIDs) }
    private var count: Int { plan.filter { $0.status == .queued }.count }
    private var showingResults: Bool { resultsOnly || dashboard.healthRunning }
    private var rows: [HealthRow] { showingResults ? dashboard.healthRows : plan }
    private var visibleRows: [HealthRow] { rows.filter {
        (resultFilter == "all" || $0.status.rawValue == resultFilter) && (search.isEmpty || $0.model.localizedCaseInsensitiveContains(search))
    } }
    var body: some View {
        ScrollView {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                Text("모델 일괄 동작 검사").font(.title2.bold())
                Spacer()
                Button("닫기") { dismiss() }.disabled(dashboard.healthRunning)
            }
            Text("텍스트 응답만 검사합니다. 이미지·영상·라이브·음성·임베딩·미확인 모델은 별도 검사기가 필요하며 미검사로 표시됩니다.")
                .font(.callout).foregroundStyle(.secondary)
            HStack {
                Toggle("전체 Provider", isOn: $allProviders).disabled(targetModelIDs != nil)
                Text(allProviders ? "저장된 모든 모델" : initialProvider.name).font(.caption)
                Spacer()
                Stepper("최대 \(limit)회 요청", value: $limit, in: 1...500)
            }.disabled(dashboard.healthRunning)
            Toggle("이름으로 추정한 텍스트 모델도 포함 (엔드포인트 호환성 미확인)", isOn: $allowInferred)
                .disabled(dashboard.healthRunning)
            Toggle("미검사 모델만 검사 (저장된 성공·실패 모델 제외)", isOn: $onlyUntested)
                .disabled(dashboard.healthRunning || targetModelIDs != nil)
                .help("끄면 기존 결과가 있는 모델도 다시 검사하여 최신 결과로 갱신합니다. 미지원 유형은 계속 제외됩니다.")
            if let error = dashboard.healthStorageError {
                Text(error).font(.caption).foregroundStyle(.red)
            }
            HStack {
                Text("검사 예산 (USD)")
                TextField("1.00", text: $budget).frame(width: 100).textFieldStyle(.roundedBorder)
                Text("확인된 가격의 예상 최대 합계: \(usd(plan.filter { $0.status == .queued }.compactMap(\.estimatedMaxUSD).reduce(0, +)))" + (plan.contains { $0.status == .queued && $0.estimatedMaxUSD == nil } ? " + 미확인 비용" : ""))
                    .font(.caption)
            }.disabled(dashboard.healthRunning)
            Toggle("가격 미확인 모델의 과금 위험을 별도로 승인 (한 건 실행 후 배치 중단)", isOn: $allowUnknownPrice)
                .font(.caption).disabled(dashboard.healthRunning)
            Text("미확인 가격 \(plan.filter { $0.estimatedMaxUSD == nil }.count)개는 0달러가 아닙니다. 승인 시 남은 예산 전체를 예약하지만 실제 청구 한도는 보장하지 않습니다.")
                .font(.caption2).foregroundStyle(.orange)
            Text("미리보기: \(plan.count)개 중 \(count)회 요청 예정 · 순차 실행 · 요청 간 1초 · 최대 출력 256토큰/회 · HTTP 제한 30초/회")
                .font(.caption)
            Text("입력 추정 128·출력 최대 256토큰과 최고 가격 구간으로 계산합니다. 캐시·추론·최소 과금·가격 변경 때문에 실제 청구 상한은 보장하지 않습니다. 실패도 예약액을 유지하며 다음 요청이 예산을 넘으면 중단합니다.")
                .font(.caption).foregroundStyle(.orange)
            Text("검사 시작: 대상 텍스트 모델에 각각 한 번 요청합니다. 429·인증·전달 오류 등으로 실패해도 1초 간격으로 다음 모델을 검사합니다. 반복 오류가 보이면 중지할 수 있습니다.")
                .font(.caption).foregroundStyle(.secondary)
            if showingResults {
                if let batch = dashboard.healthBatches.last {
                    Text("예산 \(usd(batch.budgetUSD)) · 누적 예약 \(usd(batch.reservedUSD)) · 보고된 사용량의 비용 추정 합계 \(usd(batch.estimatedUsageUSD)) + 비용 미확인 \(batch.unknownCostRequests)건 · 보고된 토큰 합계 \(batch.inputTokens)/\(batch.outputTokens)")
                        .font(.caption)
                }
                let completed = rows.filter { $0.status != .queued && $0.status != .running }.count
                ProgressView(value: Double(completed), total: Double(max(rows.count, 1)))
                Text("처리 \(completed)/\(rows.count) · 응답 확인 \(rows.filter { $0.status == .passed }.count) · 요청 실패 \(rows.filter { $0.status == .failed }.count) · 미검사 \(rows.filter { $0.status == .skipped }.count) · 중지 \(rows.filter { $0.status == .cancelled }.count)").font(.caption)
            }
            HStack {
                TextField("검사 목록에서 모델 검색", text: $search).textFieldStyle(.roundedBorder)
                Picker("상태", selection: $resultFilter) {
                    Text("전체").tag("all")
                    ForEach([CheckStatus.queued, .running, .passed, .failed, .skipped, .cancelled], id: \.rawValue) { status in
                        Text(status.label).tag(status.rawValue)
                    }
                }.frame(width: 250)
            }
            List(visibleRows) { row in
                VStack(alignment: .leading, spacing: 5) {
                    HStack {
                        Text(row.model).font(.callout.monospaced()).textSelection(.enabled)
                        Spacer()
                        Text(row.status.label).foregroundStyle(row.status == .passed ? .green : row.status == .failed ? .orange : .secondary)
                    }
                    Text("\(row.provider.name) · \(modelKindLabel(row.kind)) · \(row.reason)").font(.caption).foregroundStyle(.secondary)
                    Text("예상 최대 \(usd(row.estimatedMaxUSD)) · 사용량 기반 추정 \(usd(row.estimatedUsageUSD)) · 예약 \(usd(row.reservedUSD))").font(.caption2)
                    if let checked = row.checkedAt {
                        Text("\(checked) · \(row.durationMs ?? 0)ms · 입력 \(row.inputTokens.map(String.init) ?? "미보고") / 출력 \(row.outputTokens.map(String.init) ?? "미보고") 토큰").font(.caption2)
                    }
                }.padding(.vertical, 4)
            }.listStyle(.inset).frame(height: 240)
            HStack {
                if !dashboard.healthRows.isEmpty {
                    Toggle("최근 검사 결과 보기", isOn: $resultsOnly).disabled(dashboard.healthRunning)
                }
                Spacer()
                if dashboard.healthRunning {
                    Button(dashboard.healthStopRequested ? "현재 요청 완료를 기다리는 중…" : "중지 (현재 요청 후)") { dashboard.stopHealthChecks() }
                        .disabled(dashboard.healthStopRequested)
                } else {
                    Button("\(count)개 모델 검사 시작…") { confirm = true }
                        .buttonStyle(.borderedProminent).disabled(budgetValue == nil || count == 0 || !dashboard.ready || !dashboard.healthStoreLoaded || dashboard.states.values.contains { $0.busy })
                        .help("실제 API 요청으로 텍스트 응답을 확인합니다. 실패한 모델은 재시도하지 않고 다음 모델로 진행합니다. 비용이 발생할 수 있습니다.")
                }
            }
            Text("성공·실패의 최신 결과는 로컬에 저장됩니다. 목록 새로고침에는 유지하고 키 등록·변경·삭제 시 초기화합니다. 기존 결과도 함께 표시되며, 과거 성공은 현재 동작을 보장하지 않습니다.")
                .font(.caption2).foregroundStyle(.secondary)
        }.padding(24)
        }.frame(width: 920, height: 760)
        .interactiveDismissDisabled(dashboard.healthRunning)
        .confirmationDialog("\(count)회 실제 API 요청을 실행할까요?", isPresented: $confirm) {
            Button("과금 가능성을 확인하고 실행") {
                resultsOnly = true
                let selected = providers, inferred = allowInferred, maximum = limit, untested = targetModelIDs == nil && onlyUntested
                guard let budgetValue else { return }
                Task { await dashboard.runHealthChecks(providers: selected, allowInferred: inferred, limit: maximum, confirmed: true, onlyUntested: untested, budgetUSD: budgetValue, allowUnknownPrice: allowUnknownPrice, modelIDs: targetModelIDs) }
            }
        } message: { Text("모든 요청은 ‘Reply with OK.’를 전송합니다. 이미지·영상·라이브 생성은 실행하지 않습니다. 가격 미확인 모델도 비용이 발생할 수 있습니다.") }
    }
}
