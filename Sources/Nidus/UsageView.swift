import SwiftUI

struct UsageView: View {
    @EnvironmentObject private var store: VaultStore
    let overview: Overview
    @State private var budget = ""

    var body: some View {
        let usage = overview.usage
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 28) {
                Figure(label: "\(usage.month) 호출", value: "\(usage.calls)회")
                Figure(label: "확인된 비용", value: formatUSD(usage.costUSD))
                Figure(label: "비용 미확인 호출", value: "\(usage.unknownCostCalls)회")
                Figure(label: "월 예산", value: overview.budgetUSD.map(formatUSD) ?? "없음")
            }
            if let warning = overview.budgetWarning {
                Label(warning, systemImage: "exclamationmark.triangle.fill").foregroundStyle(.orange)
            }
            if usage.unknownCostCalls > 0 {
                Text("가격표에 없는 모델의 호출은 비용을 0으로 치지 않고 '미확인'으로 두며, 예산 집계에서 빠집니다.")
                    .font(.caption).foregroundStyle(.secondary)
            }

            HStack {
                TextField("월 예산 (USD, 예: 20)", text: $budget).frame(width: 200)
                Button("예산 저장") { Task { await store.setBudget(budget.trimmingCharacters(in: .whitespaces)) } }
                    .disabled(budget.trimmingCharacters(in: .whitespaces).isEmpty || store.busy)
                Button("예산 없애기") { Task { await store.setBudget(nil); budget = "" } }
                    .disabled(overview.budgetUSD == nil || store.busy)
                Text("예산을 넘어도 호출을 막지 않고 경고만 합니다.").font(.caption).foregroundStyle(.secondary)
            }

            if usage.groups.isEmpty {
                Text("이번 달 기록된 호출이 없습니다.")
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                Table(usage.groups) {
                    TableColumn("역할 · 난이도") { Text($0.roleLabel) }
                    TableColumn("모델") { Text("\($0.provider):\($0.model)").font(.system(.body, design: .monospaced)) }.width(min: 220)
                    TableColumn("호출") { Text($0.failed > 0 ? "\($0.calls) (실패 \($0.failed))" : "\($0.calls)").monospacedDigit() }.width(90)
                    TableColumn("입력 토큰") { Text("\($0.inputTokens)").monospacedDigit() }.width(90)
                    TableColumn("출력 토큰") { Text("\($0.outputTokens)").monospacedDigit() }.width(90)
                    TableColumn("비용") { Text($0.unknownCostCalls == $0.calls - $0.failed && $0.unknownCostCalls > 0 ? "미확인" : formatUSD($0.costUSD)).monospacedDigit() }.width(100)
                }
            }
        }
        .padding(20)
    }
}

private struct Figure: View {
    let label: String
    let value: String

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label).font(.caption).foregroundStyle(.secondary)
            Text(value).font(.title2.monospacedDigit())
        }
    }
}
