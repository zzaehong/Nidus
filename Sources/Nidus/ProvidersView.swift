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
    @State private var selected: String?
    @State private var connecting: ProviderInfo?
    @State private var disconnecting: ProviderInfo?

    private var selectedProvider: ProviderInfo? { overview.providers.first { $0.id == selected } }

    var body: some View {
        HSplitView {
            List(overview.providers, selection: $selected) { provider in
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

private struct ProviderDetail: View {
    @EnvironmentObject private var store: VaultStore
    let provider: ProviderInfo
    let onConnect: () -> Void
    let onDisconnect: () -> Void
    @State private var models: [ModelChoice] = []
    @State private var search = ""
    @State private var verifying: ModelChoice?
    @State private var verdicts: [String: String] = [:]

    private var visible: [ModelChoice] {
        search.isEmpty ? models : models.filter { $0.id.localizedCaseInsensitiveContains(search) }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text(provider.name).font(.title2.bold())
                Spacer()
                if provider.connected {
                    Button("모델 새로고침") { Task { await store.refresh(provider); models = await store.models(provider.id) } }
                    Button("키 변경…", action: onConnect)
                    Button("연결 해제…", role: .destructive, action: onDisconnect)
                } else {
                    Button("API 키 등록…", action: onConnect).keyboardShortcut(.defaultAction)
                }
            }
            .disabled(store.busy)

            if provider.connected {
                Text("모델 목록 조회: \(provider.fetchedAt ?? "없음")").font(.caption).foregroundStyle(.secondary)
                TextField("모델 검색", text: $search)
                List(visible) { model in
                    HStack {
                        VStack(alignment: .leading) {
                            Text(model.id).font(.system(.body, design: .monospaced)).textSelection(.enabled)
                            if let verdict = verdicts[model.id] { Text(verdict).font(.caption).foregroundStyle(.secondary) }
                        }
                        Spacer()
                        Text(model.toolsLabel).font(.caption)
                            .foregroundStyle(model.tools == "unsupported" ? .red : model.tools == "unknown" ? .secondary : .green)
                        Button("도구 검사") { verifying = model }
                            .disabled(store.busy)
                            .help("이 모델에 실제 도구 호출을 한 번 왕복시켜 확인합니다. 요금이 발생할 수 있습니다.")
                    }
                }
                Text("텍스트 모델만 표시합니다. 목록에 있어도 계정 권한에 따라 호출이 거부될 수 있습니다.")
                    .font(.caption).foregroundStyle(.secondary)
            } else {
                Text("API 키를 등록하면 모델 목록을 조회해 확인한 뒤 Keychain에 저장합니다.")
                    .foregroundStyle(.secondary)
                if let url = URL(string: provider.keyURL) { Link("\(provider.name) 키 발급 페이지 열기", destination: url) }
                Spacer()
            }
        }
        .padding(20)
        .task(id: provider) { models = provider.connected ? await store.models(provider.id) : [] }
        .confirmationDialog("\(verifying?.id ?? "") 도구 검사", isPresented: Binding(get: { verifying != nil }, set: { if !$0 { verifying = nil } }), presenting: verifying) { model in
            Button("검사 실행") {
                Task {
                    if let result = await store.verify(provider: provider.id, model: model.id) {
                        verdicts[model.id] = result.supported ? "검사 통과" : "검사 실패: \(result.detail)"
                        models = await store.models(provider.id)
                    } else {
                        verdicts[model.id] = "검사 중 호출 실패"
                    }
                }
            }
            Button("취소", role: .cancel) {}
        } message: { _ in
            Text("실제 API를 두 번 호출합니다. 짧은 요청이지만 요금이 발생할 수 있습니다.")
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
