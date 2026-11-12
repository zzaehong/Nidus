import SwiftUI
import AppKit

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        // Launched with `swift run`, the process is not a regular app until told so.
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
    }

    /// The workspace VM must be stopped properly (its disk is marked clean only then): quitting waits for it.
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        Task { @MainActor in
            await WorkspaceSession.shared.shutdown()
            sender.reply(toApplicationShouldTerminate: true)
        }
        return .terminateLater
    }

    func applicationWillTerminate(_ notification: Notification) {
        Bridge.shared.shutdown()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}

@main
struct NidusApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @StateObject private var store = VaultStore()

    var body: some Scene {
        WindowGroup("Nidus") {
            RootView()
                .environmentObject(store)
                .environmentObject(WorkspaceSession.shared)
                .frame(minWidth: 880, minHeight: 560)
                .task { await store.restoreLastVault() }
        }
    }
}

/// Asks for a folder. Returns nil when the user cancels.
@MainActor
func chooseVaultFolder() -> String? {
    let panel = NSOpenPanel()
    panel.canChooseDirectories = true
    panel.canChooseFiles = false
    panel.canCreateDirectories = true
    panel.allowsMultipleSelection = false
    panel.prompt = "Vault로 열기"
    panel.message = "Nidus가 작업할 폴더(Agent Vault)를 선택하세요."
    return panel.runModal() == .OK ? panel.url?.path : nil
}

struct RootView: View {
    @EnvironmentObject private var store: VaultStore

    var body: some View {
        Group {
            if store.vault == nil {
                WelcomeView()
            } else {
                VaultView()
            }
        }
        .alert("요청을 처리하지 못했습니다", isPresented: Binding(get: { store.error != nil }, set: { if !$0 { store.error = nil } })) {
            Button("확인", role: .cancel) {}
        } message: {
            Text(store.error ?? "")
        }
        .confirmationDialog("이 폴더를 Vault로 만들까요?", isPresented: Binding(get: { store.pendingInit != nil }, set: { if !$0 { store.pendingInit = nil } }), presenting: store.pendingInit) { path in
            Button("Vault로 만들기") { Task { await store.initialize(path) } }
            Button("취소", role: .cancel) {}
        } message: { path in
            Text("\(path)\n\n.nidus 폴더가 없습니다. 만들면 모델 배정표(models.json), 예산(budget.json), .gitignore가 생깁니다. 폴더의 다른 파일은 건드리지 않습니다.")
        }
    }
}

struct WelcomeView: View {
    @EnvironmentObject private var store: VaultStore

    var body: some View {
        VStack(spacing: 16) {
            Text("Nidus").font(.largeTitle.bold())
            Text("AI가 작업할 폴더(Agent Vault)를 열어 시작합니다.\n모델 배정과 사용량은 Vault마다 따로 관리됩니다.")
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)
            Button("Vault 열기…") {
                if let path = chooseVaultFolder() { Task { await store.open(path) } }
            }
            .keyboardShortcut(.defaultAction)
            .controlSize(.large)
            .disabled(store.busy)
            if store.busy { ProgressView().controlSize(.small) }
        }
        .padding(40)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

enum VaultSection: String, CaseIterable, Identifiable {
    case assignment = "모델 배정"
    case providers = "Provider"
    case usage = "사용량"
    case trial = "시험 호출"
    case work = "작업"

    var id: String { rawValue }
    var icon: String {
        switch self {
        case .assignment: return "person.2"
        case .providers: return "key"
        case .usage: return "chart.bar"
        case .trial: return "paperplane"
        case .work: return "hammer"
        }
    }
}

struct VaultView: View {
    @EnvironmentObject private var store: VaultStore
    /// The last opened section is remembered between launches.
    @AppStorage("section") private var storedSection = VaultSection.assignment.rawValue
    /// Whether the sidebar was closed is remembered too.
    @AppStorage("sidebarHidden") private var sidebarHidden = false

    private var vaultURL: URL { URL(fileURLWithPath: store.vault ?? "") }

    var body: some View {
        NavigationSplitView(columnVisibility: Binding(
            get: { sidebarHidden ? .detailOnly : .all },
            set: { sidebarHidden = $0 == .detailOnly }
        )) {
            List(VaultSection.allCases, selection: Binding(get: { VaultSection(rawValue: storedSection) }, set: { storedSection = ($0 ?? .assignment).rawValue })) { item in
                Label(item.rawValue, systemImage: item.icon).tag(item)
            }
            // The open vault is named here and in each page header, not in the toolbar:
            // a toolbar title sits after the sidebar button and never lines up with the page.
            .safeAreaInset(edge: .top, spacing: 0) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(vaultURL.lastPathComponent).font(.headline).lineLimit(1)
                    Text(vaultURL.deletingLastPathComponent().path).font(.caption).foregroundStyle(.secondary)
                        .lineLimit(1).truncationMode(.head)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 16).padding(.bottom, 10)
                .help(store.vault ?? "")
            }
            .navigationSplitViewColumnWidth(min: 180, ideal: 200, max: 260)
        } detail: {
            if let overview = store.overview {
                switch VaultSection(rawValue: storedSection) ?? .assignment {
                case .assignment: AssignmentView(overview: overview)
                case .providers: ProvidersView(overview: overview)
                case .usage: UsageView(overview: overview)
                case .trial: TrialView(overview: overview)
                case .work: WorkView(overview: overview)
                }
            } else {
                ProgressView("Vault를 읽는 중…").frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .navigationTitle(vaultURL.lastPathComponent)
        .toolbarTitleHidden()
        // The system draws the toolbar's own background a few points past the sidebar
        // edge. Without it the toolbar shares the page background and nothing overlaps.
        .toolbarBackground(.hidden, for: .windowToolbar)
        .toolbar {
            // Flexible space keeps the actions on the trailing side, so they stay put
            // when the sidebar opens and closes.
            ToolbarItem { Spacer() }
            ToolbarItemGroup(placement: .primaryAction) {
                if store.busy { ProgressView().controlSize(.small) }
                Button { Task { await store.reload() } } label: { Label("새로고침", systemImage: "arrow.clockwise") }
                    .disabled(store.busy)
                    .help("Vault의 배정표, Provider 상태, 사용량을 다시 읽습니다.")
                Button {
                    if let path = chooseVaultFolder() { Task { await store.open(path) } }
                } label: { Label("다른 Vault 열기", systemImage: "folder") }
                    .disabled(store.busy)
                    .help("다른 폴더를 Vault로 엽니다.")
            }
        }
    }
}
