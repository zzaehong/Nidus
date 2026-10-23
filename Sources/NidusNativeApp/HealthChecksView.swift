import SwiftUI

struct HealthChecksView: View {
    @EnvironmentObject var dashboard: Dashboard
    @Environment(\.dismiss) private var dismiss
    let initialProvider: Provider
    @State private var allProviders = false
    @State private var allowInferred = false
    @State private var limit = 20
    @State private var confirm = false
    @State private var resultsOnly = false
    @State private var resultFilter = "all"
    @State private var search = ""
    private var providers: [Provider] { allProviders ? Provider.allCases : [initialProvider] }
    private var plan: [HealthRow] { dashboard.healthPlan(providers: providers, allowInferred: allowInferred, limit: limit) }
    private var count: Int { plan.filter { $0.status == .queued }.count }
    private var showingResults: Bool { resultsOnly || dashboard.healthRunning }
    private var rows: [HealthRow] { showingResults ? dashboard.healthRows : plan }
    private var visibleRows: [HealthRow] { rows.filter {
        (resultFilter == "all" || $0.status.rawValue == resultFilter) && (search.isEmpty || $0.model.localizedCaseInsensitiveContains(search))
    } }
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                Text("모델 일괄 동작 검사").font(.title2.bold())
                Spacer()
                Button("닫기") { dismiss() }.disabled(dashboard.healthRunning)
            }
            Text("텍스트 응답만 검사합니다. 이미지·영상·라이브·음성·임베딩·미확인 모델은 별도 검사기가 필요하며 미검사로 표시됩니다.")
                .font(.callout).foregroundStyle(.secondary)
            HStack {
                Toggle("전체 Provider", isOn: $allProviders)
                Text(allProviders ? "저장된 모든 모델" : initialProvider.name).font(.caption)
                Spacer()
                Stepper("최대 \(limit)회 요청", value: $limit, in: 1...500)
            }.disabled(dashboard.healthRunning)
            Toggle("이름으로 추정한 텍스트 모델도 포함 (엔드포인트 호환성 미확인)", isOn: $allowInferred)
                .disabled(dashboard.healthRunning)
            Text("미리보기: \(plan.count)개 중 \(count)회 요청 예정 · 순차 실행 · 요청 간 1초 · 최대 출력 256토큰/회 · HTTP 제한 30초/회")
                .font(.caption)
            Text("실제 과금이 발생할 수 있으며 금액 상한은 보장하지 않습니다. 자동 재시도는 하지 않습니다. 추론 토큰 예산 부족·권한·호환성 문제도 실패로 나타날 수 있습니다.")
                .font(.caption).foregroundStyle(.orange)
            if showingResults {
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
                    if let checked = row.checkedAt {
                        Text("\(checked) · \(row.durationMs ?? 0)ms · 입력 \(row.inputTokens.map(String.init) ?? "미보고") / 출력 \(row.outputTokens.map(String.init) ?? "미보고") 토큰").font(.caption2)
                    }
                }.padding(.vertical, 4)
            }.listStyle(.inset)
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
                        .buttonStyle(.borderedProminent).disabled(count == 0 || !dashboard.ready || dashboard.states.values.contains { $0.busy })
                }
            }
            Text("결과는 현재 앱 세션에만 유지됩니다. 키 변경·모델 새로고침 시 해당 Provider 결과를 지웁니다. 응답 확인은 모델의 모든 기능이 정상이라는 뜻이 아닙니다.")
                .font(.caption2).foregroundStyle(.secondary)
        }.padding(24).frame(width: 850, height: 690)
        .interactiveDismissDisabled(dashboard.healthRunning)
        .confirmationDialog("\(count)회 실제 API 요청을 실행할까요?", isPresented: $confirm) {
            Button("과금 가능성을 확인하고 실행") {
                resultsOnly = true
                let selected = providers, inferred = allowInferred, maximum = limit
                Task { await dashboard.runHealthChecks(providers: selected, allowInferred: inferred, limit: maximum, confirmed: true) }
            }
        } message: { Text("모든 요청은 ‘Reply with OK.’를 전송합니다. 이미지·영상·라이브 생성은 실행하지 않습니다. 가격 미확인 모델도 비용이 발생할 수 있습니다.") }
    }
}
