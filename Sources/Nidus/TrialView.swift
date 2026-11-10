import SwiftUI

/// Sends one message to whatever model a slot resolves to, to check the assignment end to end.
struct TrialView: View {
    @EnvironmentObject private var store: VaultStore
    let overview: Overview
    @State private var slotID = "roles.main"
    @State private var prompt = ""
    @State private var system = ""
    @State private var result: AskResult?

    private var slot: Slot? { overview.slots.first { $0.id == slotID } }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("역할을 골라 메시지를 한 번 보내 봅니다. 배정표가 고른 모델이 실제로 응답하는지 확인하는 용도이며, 요금이 발생할 수 있습니다.")
                .foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)

            Picker("역할", selection: $slotID) {
                ForEach(overview.slots) { Text($0.title).tag($0.id) }
            }
            .frame(maxWidth: 320)
            if let slot {
                Text(slot.resolved.map { "사용할 모델: \($0)" } ?? "이 역할에는 쓸 수 있는 모델이 없습니다.")
                    .font(.callout).foregroundStyle(slot.resolved == nil ? .orange : .secondary)
            }

            TextField("시스템 프롬프트 (선택)", text: $system)
            TextEditor(text: $prompt)
                .font(.body)
                .frame(minHeight: 80, maxHeight: 140)
                .overlay(RoundedRectangle(cornerRadius: 6).stroke(.quaternary))

            HStack {
                Button("보내기") {
                    guard let slot else { return }
                    Task { result = await store.ask(slot: slot, prompt: prompt, system: system) }
                }
                .keyboardShortcut(.return, modifiers: .command)
                .disabled(prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || slot?.resolved == nil || store.busy)
                if store.busy { ProgressView().controlSize(.small) }
            }

            if let result {
                GroupBox {
                    VStack(alignment: .leading, spacing: 8) {
                        ScrollView {
                            Text(result.text.isEmpty ? "(텍스트 없음, 종료 사유: \(result.stopReason))" : result.text)
                                .textSelection(.enabled)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        Divider()
                        Text("\(result.model) · 입력 \(result.inputTokens.map(String.init) ?? "?") / 출력 \(result.outputTokens.map(String.init) ?? "?") 토큰 · 비용 \(result.costUSD.map(formatUSD) ?? "미확인")")
                            .font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
                        ForEach(result.warnings, id: \.self) { Label($0, systemImage: "exclamationmark.triangle").font(.caption).foregroundStyle(.orange) }
                    }
                    .padding(6)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(20)
    }
}
