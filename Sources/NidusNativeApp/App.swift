import SwiftUI
import AppKit

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
    }
    func applicationWillTerminate(_ notification: Notification) { Runtime.shared.shutdown() }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}

@main struct NidusApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var delegate
    @StateObject private var dashboard = Dashboard(healthStore: .application)
    var body: some Scene {
        WindowGroup("Nidus · API Connections") {
            DashboardView().environmentObject(dashboard)
                .frame(minWidth: 1000, minHeight: 700)
                .task { await dashboard.start() }
        }.defaultSize(width: 1180, height: 820)
    }
}

// Plain AppKit secure input, without a password content type or a SwiftUI credential form.
struct APIKeyInput: NSViewRepresentable {
    @Binding var value: String
    func makeCoordinator() -> Coordinator { Coordinator(self) }
    func makeNSView(context: Context) -> NSSecureTextField {
        let field = NSSecureTextField()
        field.placeholderString = "API Key 붙여넣기"
        field.delegate = context.coordinator
        field.contentType = nil
        field.isAutomaticTextCompletionEnabled = false
        field.font = .monospacedSystemFont(ofSize: 13, weight: .regular)
        field.setAccessibilityLabel("API Key")
        return field
    }
    func updateNSView(_ field: NSSecureTextField, context: Context) {
        context.coordinator.parent = self
        if field.stringValue != value { field.stringValue = value }
    }
    class Coordinator: NSObject, NSTextFieldDelegate {
        var parent: APIKeyInput
        init(_ parent: APIKeyInput) { self.parent = parent }
        func controlTextDidChange(_ notification: Notification) {
            parent.value = (notification.object as? NSTextField)?.stringValue ?? ""
        }
    }
}

struct DashboardView: View {
    @EnvironmentObject var dashboard: Dashboard
    @State private var selected: Provider? = .openai
    @State private var showHealth = false
    @State private var showUsage = false
    @State private var showRouting = false
    @State private var showChat = false
    var body: some View {
        NavigationSplitView {
            VStack(alignment: .leading, spacing: 20) {
                VStack(alignment: .leading, spacing: 5) {
                    Text("NIDUS").font(.title2.bold()).tracking(4)
                    Text("API CONNECTIONS").font(.caption).foregroundStyle(.secondary).tracking(1)
                }.padding(.horizontal).padding(.top, 20)
                List(Provider.allCases, selection: $selected) { provider in
                    HStack(spacing: 12) {
                        Image(systemName: provider.symbol).font(.title3).frame(width: 24)
                        VStack(alignment: .leading, spacing: 4) {
                            Text(provider.name).font(.headline)
                            Text(dashboard.states[provider]?.status ?? "연결 전").font(.caption2).foregroundStyle(.secondary)
                            Text("\(dashboard.states[provider]?.models.count ?? 0)개 모델").font(.caption2)
                        }
                    }.padding(9).frame(maxWidth: .infinity, alignment: .leading).background(.quaternary.opacity(0.3), in: RoundedRectangle(cornerRadius: 10)).tag(provider)
                }.listStyle(.sidebar)
                Label(dashboard.ready ? "연결 엔진 준비됨" : "연결 엔진 준비 중", systemImage: dashboard.ready ? "checkmark.circle" : "circle.dotted")
                    .font(.caption).foregroundStyle(.secondary).padding()
            }.navigationSplitViewColumnWidth(min: 220, ideal: 250)
        } detail: {
            if let selected { ProviderView(provider: selected).id(selected) }
        }
        .toolbar {
            Button("Tier 및 라우팅", systemImage: "arrow.triangle.branch") { showRouting = true }.disabled(!dashboard.ready)
            Button("사용량 및 예산", systemImage: "chart.bar") { showUsage = true }.disabled(!dashboard.ready)
            Button("모델 일괄 검사", systemImage: "checkmark.shield") { showHealth = true }.disabled(!dashboard.ready)
                .help("선택한 범위의 텍스트 모델을 순차 검사합니다. 실패해도 다음 모델로 진행하며 실제 API 비용이 발생할 수 있습니다. 실행 전 대상과 요청 한도를 확인합니다.")
            Button("채팅방", systemImage: "bubble.left.and.bubble.right") { showChat = true }.disabled(!dashboard.ready)
        }
        .sheet(isPresented: $showRouting) { RoutingSettingsView() }
        .sheet(isPresented: $showUsage) { UsageBudgetView() }
        .sheet(isPresented: $showHealth) { HealthChecksView(initialProvider: selected ?? .openai).environmentObject(dashboard) }
        .sheet(isPresented: $showChat) { ChatRoomsView().environmentObject(dashboard) }
        .overlay {
            if let error = dashboard.runtimeError {
                VStack(alignment: .leading, spacing: 16) {
                    Label("실행 환경을 확인해주세요", systemImage: "exclamationmark.triangle").font(.headline)
                    Text(error).textSelection(.enabled)
                    Button("다시 시도") { dashboard.runtimeError = nil; Task { await dashboard.start() } }
                }.padding(28).frame(width: 480).background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16))
            }
        }
    }
}

struct ProviderView: View {
    let provider: Provider
    @EnvironmentObject var dashboard: Dashboard
    @State private var key = ""
    @State private var accountID = ""
    @State private var search = ""
    @State private var kind = "all"
    @State private var showKey = false
    @State private var confirmDisconnect = false
    @State private var tab = 0
    private var state: ProviderState { dashboard.states[provider] ?? ProviderState() }
    private var model: APIModel? { state.models.first { $0.id == state.selectedModel } }
    private var filtered: [APIModel] { state.models.filter {
        (kind == "all" || ($0.classification?.kind ?? "unknown") == kind) && (search.isEmpty || $0.id.localizedCaseInsensitiveContains(search) || $0.name.localizedCaseInsensitiveContains(search))
    } }
    private func binding<T>(_ path: WritableKeyPath<ProviderState, T>) -> Binding<T> {
        Binding(get: { state[keyPath: path] }, set: { dashboard.states[provider]?[keyPath: path] = $0 })
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 8) {
                    Text(provider.name).font(.largeTitle.bold())
                    Text("공식 API로 연결하고, 조회된 모델 카탈로그를 관리하세요.").foregroundStyle(.secondary)
                }
                Spacer()
                Button("API Key 등록 / 변경", systemImage: "key") { showKey = true }
                    .buttonStyle(.borderedProminent)
            }
            HStack(spacing: 16) {
                Label(state.status, systemImage: "network")
                Divider().frame(height: 16)
                Text("\(state.models.count)개 모델").fontWeight(.semibold)
                Spacer()
                if state.busy { ProgressView().controlSize(.small); Text("처리 중…").font(.caption) }
                Button("모델 새로고침", systemImage: "arrow.clockwise") { run("models") }
                Menu {
                    Button("전체 가격 데이터") { tab = 2; run("pricing") }
                    Button("키 및 모델 목록 삭제", role: .destructive) { confirmDisconnect = true }
                } label: { Image(systemName: "ellipsis.circle") }
                    .frame(width: 40)
            }.font(.callout).padding(14).background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 10))
            if let error = state.error {
                Label(error, systemImage: "exclamationmark.triangle.fill").foregroundStyle(.red).font(.callout).textSelection(.enabled)
            }
            if let date = state.fetchedAt { Text("마지막 모델 조회: \(date) · 목록 조회 성공은 개별 모델의 유료 채팅 권한을 보장하지 않습니다.").font(.caption).foregroundStyle(.secondary) }
            HSplitView {
                VStack(alignment: .leading, spacing: 10) {
                    TextField("모델 검색", text: $search).textFieldStyle(.roundedBorder)
                    Picker("용도", selection: $kind) {
                        Text("전체 (\(state.models.count))").tag("all")
                        ForEach(["text", "image", "video", "live", "audio", "embedding", "moderation", "reranking", "document", "detection", "reward", "unknown"], id: \.self) { category in
                            Text("\(modelKindLabel(category)) (\(state.models.filter { ($0.classification?.kind ?? "unknown") == category }.count))").tag(category)
                        }
                    }
                    if state.models.isEmpty {
                        VStack(spacing: 14) {
                            Image(systemName: "square.stack.3d.up").font(.system(size: 34)).foregroundStyle(.secondary)
                            Text("아직 조회된 모델이 없습니다").font(.headline)
                            Text(state.fetchedAt == nil ? "API Key를 등록하면 모델 목록을 자동으로 가져옵니다. 이미 등록했다면 새로고침을 눌러주세요." : "조회 결과가 비어 있습니다. 계정의 API 권한을 확인한 뒤 새로고침하세요.")
                                .foregroundStyle(.secondary).multilineTextAlignment(.center)
                        }.frame(maxWidth: .infinity, maxHeight: .infinity).padding()
                    } else {
                        List(filtered, selection: binding(\.selectedModel)) { item in
                            VStack(alignment: .leading, spacing: 6) {
                                Text(item.name).fontWeight(.medium)
                                Text(item.id).font(.caption.monospaced()).foregroundStyle(.secondary)
                                Text(item.classification?.label ?? "기타/미확인").font(.caption2)
                                if let checked = dashboard.healthHistory[provider.rawValue + ":" + item.id] {
                                    Text(checked.status.label).font(.caption2).foregroundStyle(.secondary)
                                        .help("최근 검사: \(checked.checkedAt ?? "미확인") · \(checked.reason)")
                                }
                            }.padding(.vertical, 5).tag(item.id)
                        }.listStyle(.inset)
                        Text("미확인 모델은 텍스트 응답을 보장하지 않습니다.").font(.caption).foregroundStyle(.secondary)
                    }
                }.frame(minWidth: 260, idealWidth: 320)
                VStack(alignment: .leading, spacing: 14) {
                    Picker("보기", selection: $tab) {
                        Text("모델 정보").tag(0); Text("응답 테스트").tag(1); Text("원본 데이터").tag(2)
                    }.pickerStyle(.segmented).labelsHidden()
                    if tab == 2 {
                        ScrollView { Text(state.detail.isEmpty ? "모델 상세 또는 전체 가격 데이터를 조회하세요." : state.detail).font(.caption.monospaced()).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }
                    } else if let model {
                        if tab == 0 { modelInfo(model) } else { chat(model) }
                    } else {
                        Text("모델 목록에서 모델을 선택하세요.").foregroundStyle(.secondary).frame(maxWidth: .infinity, maxHeight: .infinity)
                    }
                }.padding(.leading, 16).frame(minWidth: 340, maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            }
        }.padding(26)
        .disabled(!dashboard.ready || state.busy || dashboard.healthRunning)
        .onChange(of: state.selectedModel) { _ in
            dashboard.states[provider]?.response = ""
            dashboard.states[provider]?.usage = ""
            dashboard.states[provider]?.detail = ""
        }
        .sheet(isPresented: $showKey, onDismiss: { key = "" }) {
            VStack(alignment: .leading, spacing: 18) {
                Text("\(provider.name) 연결").font(.title2.bold())
                Text("공식 API 키를 입력하세요. 인증 후 모델을 자동 조회하고 macOS Keychain에 저장합니다. 구독형 채팅 서비스 계정과 API 요금은 별개입니다.").foregroundStyle(.secondary)
                Link("API Key 발급 / 관리 페이지", destination: provider.keyURL)
                if provider.requiresAccountID {
                    TextField("Cloudflare Account ID (32자리)", text: $accountID).textFieldStyle(.roundedBorder)
                    Text("Workers AI Read 및 Edit 권한이 필요합니다. Account ID와 토큰은 Keychain에 함께 저장됩니다.").font(.caption)
                }
                APIKeyInput(value: $key).frame(height: 28)
                HStack {
                    Text("키는 로그나 일반 설정 파일에 저장되지 않습니다.").font(.caption).foregroundStyle(.secondary)
                    Spacer()
                    Button("취소") { key = ""; showKey = false }
                    Button("연결 및 모델 조회") {
                        let submitted = key.trimmingCharacters(in: .whitespacesAndNewlines)
                        key = ""; showKey = false
                        run("connect", extra: provider.requiresAccountID ? ["key": submitted, "accountId": accountID] : ["key": submitted])
                    }.buttonStyle(.borderedProminent).disabled(key.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || (provider.requiresAccountID && accountID.count != 32))
                }
            }.padding(28).frame(width: 570)
        }
        .confirmationDialog("Keychain의 API 키와 저장된 모델 목록을 삭제할까요?", isPresented: $confirmDisconnect) {
            Button("삭제", role: .destructive) { run("disconnect") }
        }
    }
    private func modelInfo(_ model: APIModel) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text(model.name).font(.title2.bold())
                Text(model.id).font(.callout.monospaced()).textSelection(.enabled)
                if let classification = model.classification {
                    Text("분류: \(classification.label)").font(.headline)
                    if let source = classification.source, let url = URL(string: source) {
                        Link("분류 근거 · \(classification.checkedAt ?? "미확인")", destination: url).font(.caption)
                    }
                    Text(classification.reason).font(.caption).foregroundStyle(.secondary)
                }
                if let result = dashboard.healthHistory[provider.rawValue + ":" + model.id] {
                    Divider()
                    Label("최근 동작 검사: \(result.status.label)", systemImage: result.status == .passed ? "checkmark.circle.fill" : "exclamationmark.circle.fill")
                        .font(.headline).foregroundStyle(result.status == .passed ? .green : .orange)
                    Text(result.reason).font(.callout).textSelection(.enabled)
                    if let date = result.checkedAt { Text("검사 시각: \(date)").font(.caption).foregroundStyle(.secondary) }
                    if let duration = result.durationMs { Text("응답 시간: \(duration)ms").font(.caption).foregroundStyle(.secondary) }
                    Text("토큰: 입력 \(result.inputTokens.map(String.init) ?? "미보고") · 출력 \(result.outputTokens.map(String.init) ?? "미보고")")
                        .font(.caption).foregroundStyle(.secondary)
                } else {
                    Label("동작 검사 기록 없음", systemImage: "questionmark.circle").font(.callout).foregroundStyle(.secondary)
                    Text("모델 일괄 검사에서 이 모델의 텍스트 응답을 확인할 수 있습니다.").font(.caption).foregroundStyle(.secondary)
                }
                Text("채팅 \(support(model.capabilities.chat)) · Streaming \(support(model.capabilities.streaming))\nTools \(support(model.capabilities.tools)) · Vision \(support(model.capabilities.vision))").font(.callout)
                Text("기능 표시는 API 메타데이터 기준입니다. 이 앱은 텍스트 요청만 실행합니다.").font(.caption).foregroundStyle(.secondary)
                Divider()
                Text("공식 가격 스냅샷 · USD / 100만 토큰").font(.headline)
                if model.pricing.rates.isEmpty { Text("가격 미확인 — 무료를 의미하지 않습니다.").foregroundStyle(.secondary) }
                ForEach(Array(model.pricing.rates.enumerated()), id: \.offset) { _, rate in
                    VStack(alignment: .leading, spacing: 6) {
                        Text(rate.tier).fontWeight(.semibold)
                        Text("입력 $\(rate.input.formatted()) · 출력 $\(rate.output.formatted())")
                        if let cached = rate.cachedInput { Text("캐시 입력 $\(cached.formatted())") }
                        Text(rate.conditions).font(.caption).foregroundStyle(.secondary)
                    }
                }
                if let date = model.pricing.checkedAt { Text("확인: \(date)").font(.caption) }
                Text("무료 티어: \(model.pricing.freeTier == "available" ? "있음 (조건 확인 필요)" : model.pricing.freeTier == "unavailable" ? "없음" : "미확인")").font(.caption)
                if let notes = model.pricing.notes { Text(notes).font(.caption).foregroundStyle(.secondary) }
                if let url = URL(string: model.pricing.sourceUrl) { Link("공식 가격 출처", destination: url) }
                Button("API에서 모델 상세 조회") { tab = 2; run("detail", extra: ["model": model.id]) }
            }.frame(maxWidth: .infinity, alignment: .leading)
        }
    }
    private func chat(_ model: APIModel) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(model.id).font(.caption.monospaced())
            TextField("System prompt (선택)", text: binding(\.system)).textFieldStyle(.roundedBorder)
            TextEditor(text: binding(\.prompt)).font(.body).frame(height: 100).border(.secondary.opacity(0.3))
            HStack {
                Text("최대 출력 토큰").font(.caption)
                TextField("1024", text: binding(\.maxTokens)).frame(width: 80)
                Spacer()
                Button("메시지 전송", systemImage: "paperplane") {
                    run("chat", extra: ["request": ["model": model.id, "system": state.system,
                        "messages": [["role": "user", "content": state.prompt]], "maxOutputTokens": Int(state.maxTokens) ?? 1024]])
                }.buttonStyle(.borderedProminent).disabled(state.prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.capabilities.chat == "unsupported" || (Int(state.maxTokens) ?? 0) <= 0)
            }
            Text("실제 API 요청으로 비용이 발생할 수 있습니다. 각 전송은 독립된 테스트입니다.").font(.caption).foregroundStyle(.secondary)
            Divider()
            ScrollView { Text(state.response.isEmpty ? "응답이 여기에 표시됩니다." : state.response).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }.frame(maxHeight: .infinity)
            Text(state.usage).font(.caption).foregroundStyle(.secondary)
        }
    }
    private func run(_ method: String, extra: [String: Any] = [:]) { Task { await dashboard.operation(method, provider, extra: extra) } }
    private func support(_ value: String) -> String { value == "supported" ? "지원" : value == "unsupported" ? "미지원" : "미확인" }
}
