import SwiftUI

/// Under a model's work: "이 AI의 작업이 마음에 들지 않나요?". Opens the sheet that says which role,
/// difficulty and model did the work, so the user judges the right thing, and takes the model out.
struct ModelFeedbackLink: View {
    let judgement: ModelJudgement
    @State private var judging = false

    var body: some View {
        Button("이 AI의 작업이 마음에 들지 않나요?") { judging = true }
            .buttonStyle(.link).font(.caption2)
            .help("\(roleName(judgement.role)) · 난이도 \(difficultyName(judgement.difficulty)) · \(judgement.ref)")
            .sheet(isPresented: $judging) { ModelFeedbackSheet(judgement: judgement) }
    }
}

private struct ModelFeedbackSheet: View {
    @EnvironmentObject private var store: VaultStore
    @Environment(\.dismiss) private var dismiss
    let judgement: ModelJudgement
    @State private var note = ""
    @State private var problem: String?

    private var slotName: String { judgement.role == "worker" ? "Worker · \(difficultyName(judgement.difficulty))" : roleName(judgement.role) }
    private var alreadyExcluded: Exclusion? {
        store.overview?.excluded?.first { $0.ref == judgement.ref && ($0.scope == "vault" || $0.slot == (judgement.role == "worker" ? "worker.\(judgement.difficulty ?? "")" : "roles.\(judgement.role)")) }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("이 AI의 작업이 마음에 들지 않나요?").font(.headline)
            Text("이 일을 한 모델을 배정에서 뺄 수 있습니다. 같은 모델이라도 역할과 난이도에 따라 잘하는 일이 다르니, 어느 칸의 일이었는지 보고 정하세요.")
                .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            Grid(alignment: .leading, horizontalSpacing: 12, verticalSpacing: 6) {
                GridRow { Text("역할").foregroundStyle(.secondary); Text(roleName(judgement.role)).bold() }
                GridRow { Text("난이도").foregroundStyle(.secondary); Text(judgement.role == "worker" ? difficultyName(judgement.difficulty) : "해당 없음 (Worker 작업에만 있음)").bold() }
                GridRow { Text("모델").foregroundStyle(.secondary); Text(judgement.ref).font(.system(.body, design: .monospaced)).textSelection(.enabled) }
                GridRow { Text("배정 칸").foregroundStyle(.secondary); Text(slotName) }
            }
            .padding(10).frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 6).fill(Color.primary.opacity(0.05)))
            if let already = alreadyExcluded {
                Label(already.scope == "vault" ? "이 모델은 이미 이 Vault 전체에서 제외돼 있습니다." : "이 모델은 이미 이 칸에서 제외돼 있습니다.", systemImage: "checkmark.circle").font(.callout).foregroundStyle(.green)
            }
            TextField("메모 (선택) — 무엇이 마음에 들지 않았는지. 배정 탭의 제외 목록에 남습니다.", text: $note, axis: .vertical).lineLimit(1...3)
            Text("빼도 Provider 연결과 모델 검사 결과는 그대로이고, \"자동 채우기\"가 다시 넣지 않습니다. 모델 배정 탭의 \"제외한 모델\"에서 언제든 되돌릴 수 있습니다.")
                .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            if let problem { Label(problem, systemImage: "exclamationmark.triangle").font(.caption).foregroundStyle(.orange) }
            HStack {
                if store.busy { ProgressView().controlSize(.small) }
                Spacer()
                Button("닫기") { dismiss() }.keyboardShortcut(.cancelAction)
                Button("이 Vault 전체에서 빼기", role: .destructive) { Task { await exclude("vault") } }.disabled(store.busy)
                Button("\(slotName) 칸에서만 빼기") { Task { await exclude("slot") } }.buttonStyle(.borderedProminent).keyboardShortcut(.defaultAction).disabled(store.busy)
            }
        }
        .padding(Layout.margin)
        .frame(width: 540)
    }

    private func exclude(_ scope: String) async {
        problem = nil
        if await store.excludeModel(judgement, scope: scope, note: note) { dismiss() }
        else { problem = store.error ?? "빼지 못했습니다."; store.error = nil }
    }
}
