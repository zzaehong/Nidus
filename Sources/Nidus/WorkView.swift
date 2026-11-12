import SwiftUI

/// The Work tab: give a Worker a task, watch the VM browser live, take it over, answer network
/// approvals, and review the result before it becomes a branch in the Vault.
struct WorkView: View {
    @EnvironmentObject private var store: VaultStore
    @EnvironmentObject private var session: WorkspaceSession
    let overview: Overview

    @State private var instruction = ""
    @State private var difficulty = "normal"
    @State private var address = ""

    private var vmRunning: Bool { session.vm == "running" }
    private var userControl: Bool { session.control == "user" }
    private func workerSlot(_ difficulty: String) -> Slot? { overview.slots.first { $0.role == "worker" && $0.difficulty == difficulty } }

    var body: some View {
        FixedPage {
            PageHeader(title: "작업", subtitle: "Worker에게 일을 맡깁니다. AI는 VM 안에서 Vault의 복사본과 브라우저로 일하고, 결과는 검토 후 브랜치로 들어갑니다.")
            if session.git != "ready" { gitBanner }
            // The side panel takes a share of the width (300-400 pt); the browser gets the rest.
            GeometryReader { proxy in
                let side = min(400, max(300, proxy.size.width * 0.38))
                HStack(alignment: .top, spacing: Layout.spacing) {
                    browserPanel.frame(width: max(200, proxy.size.width - side - Layout.spacing)).frame(maxHeight: .infinity)
                    sidePanel.frame(width: side).frame(maxHeight: .infinity)
                }
            }
            .frame(maxHeight: .infinity)
        }
        .task(id: store.vault) { if let vault = store.vault { await session.attach(vault) } }
        .alert("작업 공간", isPresented: Binding(get: { session.error != nil }, set: { if !$0 { session.error = nil } })) {
            Button("확인", role: .cancel) {}
        } message: { Text(session.error ?? "") }
    }

    // MARK: git

    private var gitBanner: some View {
        HStack(spacing: 12) {
            Image(systemName: "exclamationmark.triangle").foregroundStyle(.orange)
            VStack(alignment: .leading, spacing: 2) {
                Text(session.git == "no-repository" ? "이 Vault는 Git 저장소가 아닙니다" : "이 Vault에는 아직 커밋이 없습니다").font(.headline)
                Text("AI는 Vault의 커밋된 상태를 복사해 일하고, 결과를 브랜치로 돌려줍니다. 되돌릴 수 있게 하려면 Git이 필요합니다. 만들면 현재 파일이 첫 커밋으로 남습니다(.nidus/local 등 무시 대상은 제외).")
                    .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            Spacer()
            Button(session.git == "no-repository" ? "Git 저장소로 만들기" : "첫 커밋 만들기") { session.gitInit() }
        }
        .padding(Layout.inset).panel()
    }

    // MARK: browser

    private var browserPanel: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                vmStatus
                Spacer()
                if vmRunning {
                    Text(userControl ? "사용자 조작 중" : "AI 조작 중")
                        .font(.caption.weight(.semibold))
                        .padding(.horizontal, 8).padding(.vertical, 3)
                        .foregroundStyle(userControl ? Color.orange : Color.accentColor)
                        .overlay(Capsule().strokeBorder(userControl ? Color.orange : Color.accentColor))
                    Button(userControl ? "AI에게 돌려주기" : "개입") { userControl ? session.handBack() : session.takeOver() }
                        .buttonStyle(.borderedProminent)
                        .tint(userControl ? .orange : .accentColor)
                        .help(userControl ? "브라우저를 AI에게 돌려줍니다. 기다리던 AI 조작이 이어집니다." : "브라우저를 직접 조작합니다. 그동안 AI의 브라우저 조작은 기다립니다.")
                }
            }
            if userControl, let reason = session.controlReason {
                Label(reason == "captcha" ? "CAPTCHA가 나왔습니다. 풀고 나서 AI에게 돌려주세요." : reason, systemImage: "hand.raised")
                    .font(.callout).foregroundStyle(.orange)
            }
            if vmRunning {
                HStack(spacing: 6) {
                    Button { session.input(["type": "history", "direction": "back"]) } label: { Image(systemName: "chevron.left") }
                    Button { session.input(["type": "history", "direction": "forward"]) } label: { Image(systemName: "chevron.right") }
                    Button { session.input(["type": "reload"]) } label: { Image(systemName: "arrow.clockwise") }
                    TextField("주소 (개입 중에 직접 이동)", text: $address)
                        .textFieldStyle(.roundedBorder)
                        .onSubmit { go() }
                    Button("이동") { go() }
                }
                .disabled(!userControl)
                if session.tabs.count > 1 {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 4) {
                            ForEach(session.tabs) { tab in
                                Button(tab.title.isEmpty ? tab.url : tab.title) { session.input(["type": "tab", "tabId": tab.id]) }
                                    .buttonStyle(.bordered).controlSize(.small)
                                    .tint(tab.active ? .accentColor : .secondary)
                                    .lineLimit(1).frame(maxWidth: 200)
                                    .disabled(!userControl)
                            }
                        }
                    }
                }
            }
            BrowserScreen(image: session.frame, frameSize: session.frameSize, interactive: userControl) { session.input($0) }
                .aspectRatio(session.frameSize.width / session.frameSize.height, contentMode: .fit)
                .clipShape(RoundedRectangle(cornerRadius: 6))
                .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(userControl ? Color.orange : Color(nsColor: .separatorColor), lineWidth: userControl ? 2 : 1))
            if userControl {
                Text("화면을 클릭하면 키보드 입력도 VM 브라우저로 갑니다. ⌘ 단축키는 Ctrl로, ⌘V는 Mac 클립보드의 텍스트 입력으로 전달됩니다.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
        }
        .onChange(of: session.tabs) { tabs in
            if let active = tabs.first(where: { $0.active }) { address = active.url }
        }
    }

    private func go() {
        var url = address.trimmingCharacters(in: .whitespaces)
        guard !url.isEmpty else { return }
        if url.range(of: "^[a-zA-Z]+:", options: .regularExpression) == nil { url = "http://" + url }
        session.input(["type": "navigate", "url": url])
    }

    private var vmStatus: some View {
        HStack(spacing: 8) {
            Circle().fill(statusColor).frame(width: 8, height: 8)
            Text(statusText).font(.callout)
            switch session.vm {
            case "stopped", "failed":
                Button("VM 시작") { session.start() }.disabled(session.git != "ready")
            case "running":
                Button("VM 종료") { session.stop() }.disabled(session.running)
            default:
                ProgressView().controlSize(.small)
            }
        }
        .help(session.detail)
    }

    private var statusColor: Color {
        switch session.vm {
        case "running": return .green
        case "failed": return .red
        case "stopped": return .secondary
        default: return .orange
        }
    }

    private var statusText: String {
        switch session.vm {
        case "running": return session.running ? "VM 실행 중 · 작업 중" : "VM 실행 중"
        case "starting": return "VM 시작 중…"
        case "stopping": return "VM 종료 중…"
        case "failed": return "VM 문제: \(session.detail)"
        default: return "VM 꺼짐"
        }
    }

    // MARK: side

    private var sidePanel: some View {
        VStack(alignment: .leading, spacing: Layout.spacing) {
            if !session.approvals.isEmpty { approvals }
            if let review = session.review { ReviewPanel(review: review) } else { composer }
            log
        }
    }

    private var approvals: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("네트워크 승인").font(.headline)
            ForEach(session.approvals) { request in
                VStack(alignment: .leading, spacing: 6) {
                    Text("VM이 \(Text(request.label).bold())에 연결하려 합니다.")
                    if request.target != "mac" {
                        Text("요청: \(request.host) · 승인하면 \(request.site)의 하위 주소 전체에 적용").font(.caption).foregroundStyle(.secondary)
                    }
                    HStack {
                        Button("이번 작업만") { session.answer(request, "once") }.buttonStyle(.borderedProminent)
                        Button("항상 허용") { session.answer(request, "always") }
                        Button("거부", role: .destructive) { session.answer(request, "deny") }
                    }
                    .controlSize(.small)
                }
                .padding(10)
                .background(RoundedRectangle(cornerRadius: 6).strokeBorder(Color.orange))
            }
        }
    }

    private var composer: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(session.task == nil ? "새 작업" : "작업 \(session.task!)").font(.headline).lineLimit(1)
                Spacer()
                Picker("난이도", selection: $difficulty) {
                    Text("단순").tag("simple"); Text("보통").tag("normal"); Text("복잡").tag("complex")
                }
                .labelsHidden().pickerStyle(.segmented).frame(width: 150)
            }
            TextEditor(text: $instruction)
                .font(.body)
                .frame(height: 72)
                .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Color(nsColor: .separatorColor)))
                .disabled(session.running)
            if let slot = workerSlot(difficulty), slot.candidates.isEmpty {
                Label("이 난이도에 배정된 Worker 모델이 없습니다. 모델 배정 탭에서 추가하세요.", systemImage: "exclamationmark.circle")
                    .font(.caption).foregroundStyle(.orange)
            }
            HStack {
                if session.running {
                    ProgressView().controlSize(.small)
                    Text("작업 중").foregroundStyle(.secondary)
                    Spacer()
                    Button("중지", role: .destructive) { session.cancel() }
                } else {
                    Toggle("모든 사이트 허용", isOn: Binding(get: { session.allowAll }, set: { session.setAllowAll($0) }))
                        .toggleStyle(.checkbox).font(.callout)
                        .help("이번 작업 동안 사이트마다 묻지 않습니다. 사설 주소와 Mac 포트는 계속 막거나 묻습니다.")
                    Spacer()
                    if session.task != nil {
                        Button("새 작업으로") { send(fresh: true) }.help("Vault의 최신 커밋에서 새 작업 공간으로 시작합니다.")
                        Button("이어서 지시") { send(fresh: false) }.buttonStyle(.borderedProminent).help("같은 작업 공간과 대화를 이어갑니다.")
                    } else {
                        Button("실행") { send(fresh: true) }.buttonStyle(.borderedProminent)
                    }
                }
            }
            .disabled(!vmRunning && !session.running)
            .disabled(instruction.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !session.running)
            if session.costUSD > 0 || session.costUnknown {
                Text("이번 실행 비용 약 $\(String(format: "%.4f", session.costUSD))\(session.costUnknown ? " (일부 모델은 가격 정보 없음)" : "")")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
        .padding(Layout.inset).panel()
    }

    private func send(fresh: Bool) {
        let text = instruction.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        session.run(text, difficulty: difficulty, fresh: fresh)
        instruction = ""
    }

    private var log: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text("진행 기록").font(.headline)
                Spacer()
                Button("지우기") { session.clearLog() }.controlSize(.small).disabled(session.entries.isEmpty)
            }
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 6) {
                        ForEach(session.entries) { entry in RunEntryRow(entry: entry).id(entry.id) }
                    }
                    .padding(8)
                }
                .onChange(of: session.entries.count) { _ in
                    // After the new row is laid out, or the scroll stops one row short.
                    guard let last = session.entries.last else { return }
                    DispatchQueue.main.async { withAnimation { proxy.scrollTo(last.id, anchor: .bottom) } }
                }
            }
            .frame(maxHeight: .infinity)
            .panel()
        }
        .frame(maxHeight: .infinity)
    }
}

private struct RunEntryRow: View {
    let entry: RunEntry
    @State private var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Image(systemName: icon).foregroundStyle(color).frame(width: 14)
                Text(entry.title)
                    .font(entry.kind == .tool ? .system(.caption, design: .monospaced) : .callout)
                    .lineLimit(expanded ? nil : (entry.kind == .tool ? 2 : 8))
                    .textSelection(.enabled)
                if entry.pending { ProgressView().controlSize(.mini) }
            }
            if !entry.detail.isEmpty && entry.kind != .model {
                Button(expanded ? "접기" : "결과 보기") { expanded.toggle() }.buttonStyle(.link).font(.caption)
                if expanded {
                    Text(entry.detail).font(.system(.caption2, design: .monospaced)).textSelection(.enabled)
                        .padding(6).frame(maxWidth: .infinity, alignment: .leading)
                        .background(Color(nsColor: .textBackgroundColor)).clipShape(RoundedRectangle(cornerRadius: 4))
                }
            }
            if entry.kind == .model, !entry.detail.isEmpty {
                Text(entry.detail).font(.caption2).foregroundStyle(.tertiary)
            }
        }
    }

    private var icon: String {
        switch entry.kind {
        case .instruction: return "person.fill"
        case .model: return "sparkles"
        case .tool: return entry.isError ? "xmark.circle" : "wrench.and.screwdriver"
        case .finished: return "checkmark.seal"
        case .stopped: return "stop.circle"
        case .failed: return "exclamationmark.octagon"
        case .retry: return "arrow.clockwise"
        case .note: return "info.circle"
        }
    }

    private var color: Color {
        switch entry.kind {
        case .instruction: return .primary
        case .finished: return .green
        case .failed, .stopped, .retry: return .red
        case .tool: return entry.isError ? .red : .secondary
        default: return .accentColor
        }
    }
}

/// The Worker's result before it enters the Vault: commits, files, diff; approve makes a branch.
private struct ReviewPanel: View {
    @EnvironmentObject private var session: WorkspaceSession
    let review: WorkReview

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("결과 검토").font(.headline)
            if !review.sensitive.isEmpty {
                Label("Nidus 설정을 바꿉니다: \(review.sensitive.joined(separator: ", ")). 네트워크 허용 목록 같은 설정이 들어 있을 수 있으니 확인하세요.", systemImage: "exclamationmark.shield")
                    .font(.callout).foregroundStyle(.orange)
            }
            Text("커밋 \(review.commits.count)개 · 파일 \(review.files.count)개").font(.callout)
            ForEach(review.commits.prefix(5)) { commit in
                Text("\(String(commit.hash.prefix(7))) \(commit.subject)").font(.system(.caption, design: .monospaced)).lineLimit(1)
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 2) {
                    ForEach(review.files) { file in
                        HStack {
                            Text(file.path).lineLimit(1).truncationMode(.middle)
                            Spacer()
                            Text("+\(file.added.map(String.init) ?? "?")").foregroundStyle(.green)
                            Text("-\(file.removed.map(String.init) ?? "?")").foregroundStyle(.red)
                        }
                        .font(.system(.caption, design: .monospaced))
                    }
                    Divider()
                    Text(review.diff + (review.diffTruncated ? "\n… (일부만 표시)" : ""))
                        .font(.system(.caption2, design: .monospaced)).textSelection(.enabled)
                }
                .padding(6)
            }
            .frame(height: 200)
            .background(Color(nsColor: .textBackgroundColor)).clipShape(RoundedRectangle(cornerRadius: 4))
            HStack {
                Button("버리기", role: .destructive) { session.discard() }
                Spacer()
                Button("승인 (브랜치 nidus/\(review.task))") { session.approve() }.buttonStyle(.borderedProminent)
            }
            Text("승인해도 현재 브랜치와 작업 중인 파일은 그대로입니다. 병합은 직접 하세요.").font(.caption).foregroundStyle(.secondary)
        }
        .padding(Layout.inset).panel()
    }
}
