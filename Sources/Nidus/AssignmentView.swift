import SwiftUI

/// The assignment table: which model each role, and each worker difficulty, uses.
struct AssignmentView: View {
    @EnvironmentObject private var store: VaultStore
    let overview: Overview
    @State private var adding: Slot?
    @State private var plan: AutoFillPlan?
    @State private var planning = false

    var body: some View {
        ScrollingPage {
            PageHeader(title: "모델 배정", subtitle: "역할과 Worker 작업 난이도마다 사용할 모델을 우선순위 순서로 정합니다. 위에서부터 쓸 수 있는 첫 모델이 선택되고, 쓸 수 있는 후보가 없으면 다른 칸의 모델로 대신하지 않고 실패합니다. Main과 Manager 칸에는 텍스트 검사를 통과한 모델을, Worker 칸에는 도구 호출 검사까지 통과한 모델을 넣을 수 있습니다.")
            HStack(spacing: 10) {
                Button {
                    Task { planning = true; plan = await store.autoFill(apply: false); planning = false }
                } label: { Label("자동 채우기…", systemImage: "wand.and.stars") }
                    .disabled(store.busy || planning)
                    .help("연결된 Provider의 검사를 통과한 모델로 모든 칸의 후보를 채웁니다. 적용하기 전에 무엇을 넣을지 먼저 보여 줍니다.")
                if planning { ProgressView().controlSize(.small) }
                Text("직접 넣은 후보는 그대로 두고 그 뒤에 더합니다. 제외한 모델은 넣지 않습니다.").font(.caption).foregroundStyle(.secondary)
                Spacer()
            }
            ForEach(overview.slots) { slot in
                SlotCard(slot: slot, health: overview.health ?? [:], auto: overview.auto?[slot.id] ?? [], onAdd: { adding = slot })
            }
            if let excluded = overview.excluded, !excluded.isEmpty { ExcludedList(excluded: excluded) }
        }
        .sheet(item: $adding) { slot in
            CandidatePicker(slot: slot, providers: overview.providers.filter(\.connected))
        }
        .sheet(isPresented: Binding(get: { plan != nil }, set: { if !$0 { plan = nil } })) {
            if let plan { AutoFillSheet(plan: plan) }
        }
    }
}

/// What auto-fill is about to do, slot by slot, before it does it.
private struct AutoFillSheet: View {
    @EnvironmentObject private var store: VaultStore
    @Environment(\.dismiss) private var dismiss
    let plan: AutoFillPlan

    private var addsAnything: Bool { plan.slots.contains { !$0.added.isEmpty } }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("자동 채우기").font(.headline)
            Text("검사를 통과한 모델 \(plan.eligible)개로 아래처럼 채웁니다. 순서는 Provider의 가격표(모델의 급), 문맥 크기, 여기서 잰 속도로 정했고, 한 칸에 서로 다른 Provider를 섞습니다. 적용한 뒤에도 보통 때처럼 순서를 바꾸거나 뺄 수 있습니다.")
                .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            if plan.untested > 0 {
                Label("아직 검사하지 않은 모델이 \(plan.untested)개 있어 이번에는 빠집니다. Provider 탭의 \"일괄 검사…\"를 먼저 돌리면 후보가 늘어납니다.", systemImage: "info.circle")
                    .font(.caption).foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true)
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    ForEach(plan.slots) { slot in
                        VStack(alignment: .leading, spacing: 4) {
                            Text(slotTitle(slot.slot)).font(.subheadline.bold())
                            ForEach(Array(slot.kept.enumerated()), id: \.offset) { i, ref in
                                HStack(spacing: 6) { Text("\(i + 1).").monospacedDigit().foregroundStyle(.secondary); Text(ref).font(.system(.callout, design: .monospaced)); Text("직접 넣음 · 그대로").font(.caption).foregroundStyle(.secondary) }
                            }
                            ForEach(Array(slot.added.enumerated()), id: \.offset) { i, add in
                                HStack(spacing: 6) { Text("\(slot.kept.count + i + 1).").monospacedDigit().foregroundStyle(.secondary); Text(add.ref).font(.system(.callout, design: .monospaced)); Text(add.why).font(.caption).foregroundStyle(.secondary) }
                            }
                            if slot.kept.isEmpty && slot.added.isEmpty { Text("넣을 모델이 없습니다" + (slot.role == "worker" ? " (도구 호출 검사를 통과한 모델이 없음)" : "")).font(.caption).foregroundStyle(.orange) }
                            if !slot.excluded.isEmpty { Text("제외돼서 뺌: \(slot.excluded.joined(separator: ", "))").font(.caption2).foregroundStyle(.tertiary) }
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(maxHeight: 420)
            HStack {
                if store.busy { ProgressView().controlSize(.small) }
                Spacer()
                Button("취소") { dismiss() }.keyboardShortcut(.cancelAction)
                Button("이대로 채우기") { Task { if await store.autoFill(apply: true) != nil { dismiss() } } }
                    .buttonStyle(.borderedProminent).keyboardShortcut(.defaultAction).disabled(!addsAnything || store.busy)
            }
        }
        .padding(Layout.margin)
        .frame(width: 640)
    }
}

/// Models the user took out after seeing their work; each can be allowed again.
private struct ExcludedList: View {
    @EnvironmentObject private var store: VaultStore
    let excluded: [Exclusion]

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("제외한 모델").font(.headline)
            Text("\"이 AI의 작업이 마음에 들지 않나요?\"로 뺀 모델입니다. 자동 채우기가 다시 넣지 않고, 직접 추가하려 해도 막습니다. 다시 허용해도 칸에 저절로 들어가지는 않습니다.")
                .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            ForEach(excluded) { x in
                HStack(alignment: .firstTextBaseline, spacing: 10) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(x.ref).font(.system(.body, design: .monospaced))
                        Text("\(x.scope == "vault" ? "이 Vault 전체" : slotTitle(x.slot ?? "")) · 계기: \(roleName(x.role))\(x.role == "worker" ? " · 난이도 \(difficultyName(x.difficulty))" : "") · \(clock(x.at))" + (x.note.map { " · \($0)" } ?? ""))
                            .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    }
                    Spacer()
                    Button("다시 허용") { Task { await store.restoreModel(x.ref) } }.controlSize(.small).disabled(store.busy)
                }
            }
        }
        .padding(Layout.inset)
        .frame(maxWidth: .infinity, alignment: .leading)
        .panel()
    }
}

private struct SlotCard: View {
    @EnvironmentObject private var store: VaultStore
    let slot: Slot
    let health: [String: ModelHealth]
    /// Candidates auto-fill placed here.
    let auto: [String]
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
                        if auto.contains(candidate) { Text("자동").font(.caption2).padding(.horizontal, 5).padding(.vertical, 1).background(Capsule().fill(Color.secondary.opacity(0.15))).foregroundStyle(.secondary).help("자동 채우기가 넣은 후보입니다. 다시 자동 채우기를 하면 바뀔 수 있고, 직접 넣은 후보는 그대로 둡니다.") }
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
