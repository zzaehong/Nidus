import SwiftUI
import AppKit

/// Masked key entry. No credential content type or completion, so the system does not offer to save or fill it.
struct APIKeyField: NSViewRepresentable {
    @Binding var value: String

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeNSView(context: Context) -> NSSecureTextField {
        let field = NSSecureTextField()
        field.placeholderString = "API Key 붙여넣기"
        field.delegate = context.coordinator
        field.contentType = nil
        field.isAutomaticTextCompletionEnabled = false
        field.setAccessibilityLabel("API Key")
        return field
    }

    func updateNSView(_ field: NSSecureTextField, context: Context) {
        context.coordinator.parent = self
        if field.stringValue != value { field.stringValue = value }
    }

    final class Coordinator: NSObject, NSTextFieldDelegate {
        var parent: APIKeyField
        init(_ parent: APIKeyField) { self.parent = parent }
        func controlTextDidChange(_ notification: Notification) {
            parent.value = (notification.object as? NSTextField)?.stringValue ?? ""
        }
    }
}

struct ProvidersView: View {
    @EnvironmentObject private var store: VaultStore
    let overview: Overview
    @AppStorage("provider") private var storedProvider = ""
    @State private var connecting: ProviderInfo?
    @State private var disconnecting: ProviderInfo?

    private var selectedProvider: ProviderInfo? { overview.providers.first { $0.id == storedProvider } }

    var body: some View {
        HSplitView {
            List(overview.providers, selection: Binding<String?>(get: { storedProvider.isEmpty ? nil : storedProvider }, set: { storedProvider = $0 ?? "" })) { provider in
                HStack {
                    Image(systemName: provider.connected ? "checkmark.circle.fill" : "circle")
                        .foregroundStyle(provider.connected ? .green : .secondary)
                    VStack(alignment: .leading) {
                        Text(provider.name)
                        Text(provider.connected ? "모델 \(provider.models)개" : "키 없음").font(.caption).foregroundStyle(.secondary)
                    }
                }
                .tag(provider.id)
            }
            .frame(minWidth: 200, idealWidth: 220, maxWidth: 280)

            Group {
                if let provider = selectedProvider {
                    ProviderDetail(provider: provider, onConnect: { connecting = provider }, onDisconnect: { disconnecting = provider })
                        .id(provider.id)
                } else {
                    Text("Provider를 선택하세요.\nAPI 키는 이 Mac의 Keychain에 저장되고 모든 Vault가 함께 씁니다.")
                        .multilineTextAlignment(.center).foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
            .frame(minWidth: 420)
        }
        .sheet(item: $connecting) { ConnectSheet(provider: $0) }
        .confirmationDialog("\(disconnecting?.name ?? "") 연결을 해제할까요?", isPresented: Binding(get: { disconnecting != nil }, set: { if !$0 { disconnecting = nil } }), presenting: disconnecting) { provider in
            Button("연결 해제", role: .destructive) { Task { await store.disconnect(provider) } }
            Button("취소", role: .cancel) {}
        } message: { _ in
            Text("Keychain에서 이 Provider의 API 키를 지웁니다. 다른 Vault에서도 이 키를 쓸 수 없게 됩니다.")
        }
    }
}

/// Small pass/fail marker for one checked ability.
private struct CheckBadge: View {
    let label: String
    let state: String

    var body: some View {
        let (icon, color): (String, Color) = state == "passed" ? ("checkmark.circle.fill", .green)
            : state == "failed" ? ("xmark.circle.fill", .red) : ("minus.circle", .secondary)
        Label(label, systemImage: icon).font(.caption).foregroundStyle(color)
            .help(state == "passed" ? "\(label) 검사 통과" : state == "failed" ? "\(label) 검사 실패" : "\(label) 미검사")
    }
}

private struct ProviderDetail: View {
    @EnvironmentObject private var store: VaultStore
    let provider: ProviderInfo
    let onConnect: () -> Void
    let onDisconnect: () -> Void
    @State private var models: [ModelChoice] = []
    @State private var search = ""
    @State private var checking: ModelChoice?
    @State private var askingBatch = false

    /// Usable models first: tools passed, text passed, untested, then failed.
    private var visible: [ModelChoice] {
        let listed = search.isEmpty ? models : models.filter { $0.id.localizedCaseInsensitiveContains(search) }
        return listed.sorted { ($0.rank, $0.id) < ($1.rank, $1.id) }
    }
    private var untested: [ModelChoice] { models.filter(\.untested) }
    private var batch: BatchProgress? { store.batch?.provider == provider.id ? store.batch : nil }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(provider.name).font(.title2.bold()).lineLimit(1)
            HStack {
                if provider.connected {
                    Button("일괄 검사…") { askingBatch = true }.disabled(models.isEmpty)
                    Button("모델 새로고침") { Task { await store.refresh(provider); models = await store.models(provider.id) } }
                    Button("키 변경…", action: onConnect)
                    Button("연결 해제…", role: .destructive, action: onDisconnect)
                } else {
                    Button("API 키 등록…", action: onConnect).keyboardShortcut(.defaultAction)
                }
                Spacer()
            }
            .fixedSize(horizontal: false, vertical: true)
            .disabled(store.busy)

            if let batch {
                GroupBox {
                    VStack(alignment: .leading, spacing: 6) {
                        HStack {
                            ProgressView(value: Double(batch.done), total: Double(batch.total))
                            Text("\(batch.done)/\(batch.total)").monospacedDigit()
                            if batch.running {
                                Button("중지") { store.stopBatch() }.help("지금 검사 중인 모델까지만 끝내고 멈춥니다.")
                            } else {
                                Button("닫기") { store.dismissBatch() }
                            }
                        }
                        Text(batch.running ? "검사 중: \(batch.current)" : "일괄 검사가 끝났습니다.").font(.caption).foregroundStyle(.secondary)
                        Text(batch.summary).font(.caption)
                    }
                    .padding(4)
                }
            }

            if provider.connected {
                Text("모델 목록 조회: \(provider.fetchedAt ?? "없음") · 검사하지 않은 모델 \(untested.count)개").font(.caption).foregroundStyle(.secondary)
                TextField("모델 검색", text: $search)
                List(visible) { model in
                    HStack {
                        VStack(alignment: .leading) {
                            Text(model.id).font(.system(.body, design: .monospaced)).lineLimit(1).truncationMode(.middle).help(model.id)
                            if let note = model.note { Text(note).font(.caption).foregroundStyle(.secondary).lineLimit(1) }
                        }
                        Spacer()
                        CheckBadge(label: "텍스트", state: model.text)
                        CheckBadge(label: "도구", state: model.tools)
                        Button(model.untested ? "검사" : "다시 검사") { checking = model }
                            .disabled(store.busy)
                            .help("실제 API를 호출해 텍스트 응답과 도구 호출을 확인합니다. 요금이 발생할 수 있습니다.")
                    }
                }
                Text("텍스트 모델만 표시합니다. 텍스트 검사를 통과하면 Main·Manager 후보로, 도구 검사까지 통과하면 Worker 후보로 넣을 수 있습니다.")
                    .font(.caption).foregroundStyle(.secondary)
            } else {
                Text("API 키를 등록하면 모델 목록을 조회해 확인한 뒤 Keychain에 저장합니다.")
                    .foregroundStyle(.secondary)
                if let url = URL(string: provider.keyURL) { Link("\(provider.name) 키 발급 페이지 열기", destination: url) }
                Spacer()
            }
        }
        .padding(20)
        // Reload when the provider changes and after every recorded check.
        .task(id: "\(provider.id)/\(provider.connected)/\(store.checksRevision)") {
            models = provider.connected ? await store.models(provider.id) : []
        }
        .confirmationDialog("\(checking?.id ?? "") 검사", isPresented: Binding(get: { checking != nil }, set: { if !$0 { checking = nil } }), presenting: checking) { model in
            Button("검사 실행") { Task { await store.check(provider: provider.id, model: model.id) } }
            Button("취소", role: .cancel) {}
        } message: { _ in
            Text("실제 API를 최대 세 번 호출합니다. 짧은 요청이지만 요금이 발생할 수 있습니다.")
        }
        .confirmationDialog("\(provider.name) 모델 일괄 검사", isPresented: $askingBatch) {
            if !untested.isEmpty {
                Button("검사하지 않은 \(untested.count)개만 검사") { store.startBatch(provider: provider.id, models: untested.map(\.id)) }
            }
            Button("전체 \(models.count)개 다시 검사") { store.startBatch(provider: provider.id, models: models.map(\.id)) }
            Button("취소", role: .cancel) {}
        } message: {
            Text("모델마다 실제 API를 최대 세 번 호출하며 요금이 발생할 수 있습니다. 한 번에 하나씩 순서대로 검사하고, 언제든 중지할 수 있습니다. 속도 제한이나 서버 오류로 판정하지 못한 모델은 미검사로 남습니다.")
        }
    }
}

private struct ConnectSheet: View {
    @EnvironmentObject private var store: VaultStore
    @Environment(\.dismiss) private var dismiss
    let provider: ProviderInfo
    @State private var key = ""
    @State private var accountId = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("\(provider.name) API 키").font(.headline)
            APIKeyField(value: $key).frame(height: 22)
            if provider.needsAccountId { TextField("Account ID (32자리 16진수)", text: $accountId) }
            Text("키로 모델 목록을 조회해 확인한 뒤 이 Mac의 Keychain에 저장합니다. Vault 폴더에는 저장하지 않습니다.")
                .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            HStack {
                if store.busy { ProgressView().controlSize(.small) }
                Spacer()
                Button("취소") { dismiss() }.keyboardShortcut(.cancelAction)
                Button("확인 후 저장") {
                    Task {
                        if await store.connect(provider, key: key, accountId: accountId) { dismiss() }
                        key = ""
                    }
                }
                .keyboardShortcut(.defaultAction)
                .disabled(key.trimmingCharacters(in: .whitespaces).isEmpty || store.busy)
            }
        }
        .padding(20)
        .frame(width: 440)
    }
}
