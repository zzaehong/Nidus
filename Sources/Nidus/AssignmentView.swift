import SwiftUI

/// The assignment table: which model each role, and each worker difficulty, uses.
struct AssignmentView: View {
    @EnvironmentObject private var store: VaultStore
    let overview: Overview
    @State private var adding: Slot?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                Text("역할과 Worker 작업 난이도마다 사용할 모델을 우선순위 순서로 정합니다. 위에서부터 쓸 수 있는 첫 모델이 선택되고, 쓸 수 있는 후보가 없으면 다른 칸의 모델로 대신하지 않고 실패합니다.")
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                ForEach(overview.slots) { slot in
                    SlotCard(slot: slot, onAdd: { adding = slot })
                }
            }
            .padding(20)
        }
        .sheet(item: $adding) { slot in
            CandidatePicker(slot: slot, providers: overview.providers.filter(\.connected))
        }
    }
}

private struct SlotCard: View {
    @EnvironmentObject private var store: VaultStore
    let slot: Slot
    let onAdd: () -> Void

    private func update(_ candidates: [String]) {
        Task { await store.setCandidates(slot, candidates) }
    }

    private func move(_ index: Int, by offset: Int) {
        var list = slot.candidates
        list.swapAt(index, index + offset)
        update(list)
    }

    var body: some View {
        GroupBox {
            VStack(alignment: .leading, spacing: 8) {
                HStack(alignment: .firstTextBaseline) {
                    Text(slot.title).font(.headline)
                    Text(slot.summary).font(.callout).foregroundStyle(.secondary)
                    Spacer()
                    Button("후보 추가…", action: onAdd).disabled(store.busy)
                }

                if let resolved = slot.resolved {
                    Label("현재 선택: \(resolved)", systemImage: "checkmark.circle.fill")
                        .foregroundStyle(.green)
                        .help(slot.reason ?? "")
                } else {
                    Label(slot.candidates.isEmpty ? "후보가 없습니다. 이 역할로는 호출할 수 없습니다." : "쓸 수 있는 후보가 없습니다.", systemImage: "exclamationmark.triangle.fill")
                        .foregroundStyle(.orange)
                        .help(slot.problem ?? "")
                }

                ForEach(Array(slot.candidates.enumerated()), id: \.element) { index, candidate in
                    HStack {
                        Text("\(index + 1)").monospacedDigit().foregroundStyle(.secondary).frame(width: 18, alignment: .trailing)
                        Text(candidate).font(.system(.body, design: .monospaced)).textSelection(.enabled)
                        if candidate == slot.resolved { Text("선택됨").font(.caption).foregroundStyle(.green) }
                        Spacer()
                        Button { move(index, by: -1) } label: { Image(systemName: "arrow.up") }
                            .disabled(index == 0 || store.busy).help("우선순위 올리기")
                        Button { move(index, by: 1) } label: { Image(systemName: "arrow.down") }
                            .disabled(index == slot.candidates.count - 1 || store.busy).help("우선순위 내리기")
                        Button(role: .destructive) { update(slot.candidates.filter { $0 != candidate }) } label: { Image(systemName: "trash") }
                            .disabled(store.busy).help("후보에서 제거")
                    }
                    .buttonStyle(.borderless)
                }

                if let detail = slot.resolved == nil ? slot.problem : slot.reason, !slot.candidates.isEmpty {
                    Text(detail).font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
                }
            }
            .padding(6)
        }
    }
}

/// Picks a model from a connected provider's cached list and appends it to the slot.
private struct CandidatePicker: View {
    @EnvironmentObject private var store: VaultStore
    @Environment(\.dismiss) private var dismiss
    let slot: Slot
    let providers: [ProviderInfo]
    @State private var provider = ""
    @State private var models: [ModelChoice] = []
    @State private var search = ""

    private var visible: [ModelChoice] {
        let listed = models.filter { !slot.candidates.contains("\(provider):\($0.id)") }
        guard !search.isEmpty else { return listed }
        return listed.filter { $0.id.localizedCaseInsensitiveContains(search) || $0.name.localizedCaseInsensitiveContains(search) }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("\(slot.title)에 후보 추가").font(.headline)
            if providers.isEmpty {
                Text("연결된 Provider가 없습니다. Provider 탭에서 API 키를 먼저 등록하세요.").foregroundStyle(.secondary)
            } else {
                Picker("Provider", selection: $provider) {
                    ForEach(providers) { Text($0.name).tag($0.id) }
                }
                TextField("모델 검색", text: $search)
                List(visible) { model in
                    HStack {
                        VStack(alignment: .leading) {
                            Text(model.id).font(.system(.body, design: .monospaced))
                            if model.name != model.id { Text(model.name).font(.caption).foregroundStyle(.secondary) }
                        }
                        Spacer()
                        Text(model.toolsLabel).font(.caption)
                            .foregroundStyle(model.tools == "unsupported" ? .red : model.tools == "unknown" ? .secondary : .green)
                        Button("추가") {
                            Task {
                                await store.setCandidates(slot, slot.candidates + ["\(provider):\(model.id)"])
                                dismiss()
                            }
                        }
                        .disabled(store.busy)
                    }
                }
                .frame(minHeight: 280)
                Text("텍스트 모델만 표시합니다. '도구 미확인' 모델은 Provider 탭에서 도구 검사를 하면 확인됨으로 바뀝니다.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            HStack {
                Spacer()
                Button("닫기") { dismiss() }.keyboardShortcut(.cancelAction)
            }
        }
        .padding(20)
        .frame(width: 560)
        .task(id: provider) {
            if provider.isEmpty { provider = providers.first?.id ?? "" }
            if !provider.isEmpty { models = await store.models(provider) }
        }
    }
}
