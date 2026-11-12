import SwiftUI

/// The assignment table: which model each role, and each worker difficulty, uses.
struct AssignmentView: View {
    @EnvironmentObject private var store: VaultStore
    let overview: Overview
    @State private var adding: Slot?

    var body: some View {
        ScrollingPage {
            PageHeader(title: "모델 배정", subtitle: "역할과 Worker 작업 난이도마다 사용할 모델을 우선순위 순서로 정합니다. 위에서부터 쓸 수 있는 첫 모델이 선택되고, 쓸 수 있는 후보가 없으면 다른 칸의 모델로 대신하지 않고 실패합니다. Main과 Manager 칸에는 텍스트 검사를 통과한 모델을, Worker 칸에는 도구 호출 검사까지 통과한 모델을 넣을 수 있습니다.")
            ForEach(overview.slots) { slot in
                SlotCard(slot: slot, health: overview.health ?? [:], onAdd: { adding = slot })
            }
        }
        .sheet(item: $adding) { slot in
            CandidatePicker(slot: slot, providers: overview.providers.filter(\.connected))
        }
    }
}

private struct SlotCard: View {
    @EnvironmentObject private var store: VaultStore
    let slot: Slot
    let health: [String: ModelHealth]
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
        VStack(alignment: .leading, spacing: 8) {
                HStack(alignment: .firstTextBaseline) {
                    Text(slot.title).font(.headline)
                    Text(slot.summary).font(.callout).foregroundStyle(.secondary).lineLimit(1)
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
                        if let state = health[candidate], let note = state.note {
                            Text(note).font(.caption).foregroundStyle(state.restingUntil.map { $0 > Date() } == true ? .orange : .secondary)
                        }
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

                // The first choice needs no explanation; a fallback or a failure does.
                if let detail = slot.resolved == nil ? slot.problem : slot.reason, !slot.candidates.isEmpty,
                   slot.resolved == nil || detail.contains("fallback") {
                    Text(detail).font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
                }
        }
        .padding(Layout.inset)
        .frame(maxWidth: .infinity, alignment: .leading)
        .panel()
    }
}

/// Adds models to a slot. Only models that passed the check this slot needs are offered.
private struct CandidatePicker: View {
    @EnvironmentObject private var store: VaultStore
    @Environment(\.dismiss) private var dismiss
    let slot: Slot
    let providers: [ProviderInfo]
    @State private var provider = ""
    @State private var models: [ModelChoice] = []
    @State private var search = ""
    /// "provider:model" references, kept while switching between providers.
    @State private var chosen: [String] = []

    private func ref(_ model: ModelChoice) -> String { "\(provider):\(model.id)" }

    private var eligible: [ModelChoice] {
        models.filter { $0.qualifies(for: slot) && !slot.candidates.contains(ref($0)) }
    }

    private var visible: [ModelChoice] {
        guard !search.isEmpty else { return eligible }
        return eligible.filter { $0.id.localizedCaseInsensitiveContains(search) || $0.name.localizedCaseInsensitiveContains(search) }
    }

    private var requirement: String { slot.needsTools ? "도구 호출 검사" : "텍스트 검사" }

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
                    Toggle(isOn: Binding(
                        get: { chosen.contains(ref(model)) },
                        set: { on in
                            if on { chosen.append(ref(model)) } else { chosen.removeAll { $0 == ref(model) } }
                        }
                    )) {
                        VStack(alignment: .leading) {
                            Text(model.id).font(.system(.body, design: .monospaced))
                            if model.name != model.id { Text(model.name).font(.caption).foregroundStyle(.secondary) }
                        }
                    }
                }
                .scrollContentBackground(.hidden)
                .frame(minHeight: 280)
                .panel()
                .overlay {
                    if eligible.isEmpty {
                        Text("이 Provider에는 \(requirement)를 통과한 모델이 없습니다.\nProvider 탭에서 모델 검사를 먼저 실행하세요.")
                            .multilineTextAlignment(.center).foregroundStyle(.secondary)
                    }
                }
                let hidden = models.filter(\.untested).count
                Text("\(requirement)를 통과한 모델만 표시합니다." + (hidden > 0 ? " 아직 검사하지 않은 모델이 \(hidden)개 있습니다." : ""))
                    .font(.caption).foregroundStyle(.secondary)
            }
            HStack {
                if !chosen.isEmpty { Text("\(chosen.count)개 선택됨 · 선택한 순서대로 뒤에 추가됩니다").font(.caption).foregroundStyle(.secondary) }
                Spacer()
                Button("닫기") { dismiss() }.keyboardShortcut(.cancelAction)
                Button("선택한 모델 추가") {
                    Task {
                        await store.setCandidates(slot, slot.candidates + chosen)
                        dismiss()
                    }
                }
                .keyboardShortcut(.defaultAction)
                .disabled(chosen.isEmpty || store.busy)
            }
        }
        .padding(Layout.margin)
        .frame(width: 560)
        .task(id: provider) {
            if provider.isEmpty { provider = providers.first?.id ?? "" }
            if !provider.isEmpty { models = await store.models(provider) }
        }
    }
}
