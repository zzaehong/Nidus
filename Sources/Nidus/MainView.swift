import SwiftUI

/// Talking with Main: the user chats, Main answers or starts a project. The plan, Main's
/// questions and the approval are here too; the Work tab shows the team at work.
struct MainView: View {
    @EnvironmentObject private var store: VaultStore
    @EnvironmentObject private var session: WorkspaceSession
    let overview: Overview

    @State private var draft = ""

    private var mainMissing: Bool { overview.slots.first(where: { $0.role == "main" })?.candidates.isEmpty ?? true }

    var body: some View {
        FixedPage {
            PageHeader(title: "Main", subtitle: "Main과 직접 이야기합니다. 묻는 말에는 Main이 바로 답하고, 일을 맡기면 계획을 세워 보여 줍니다. 계획을 승인하면 팀이 일을 시작하고, 진행은 작업 탭에서 볼 수 있습니다.")
            GeometryReader { proxy in
                // Beside the conversation when there is room, under it on a narrow window.
                if proxy.size.width > 760 {
                    HStack(alignment: .top, spacing: Layout.spacing) {
                        conversation.frame(maxWidth: .infinity, maxHeight: .infinity)
                        if session.project != nil || showsCuration {
                            ScrollView { side }.frame(width: min(420, proxy.size.width * 0.42))
                        }
                    }
                } else {
                    VStack(spacing: Layout.spacing) {
                        conversation.frame(maxWidth: .infinity, maxHeight: .infinity)
                        if session.project != nil || showsCuration {
                            ScrollView { side }.frame(maxHeight: proxy.size.height * 0.45)
                        }
                    }
                }
            }
            .frame(maxHeight: .infinity)
        }
        .task(id: store.vault) { if let vault = store.vault { await session.attach(vault) } }
        .alert("Main", isPresented: Binding(get: { session.error != nil }, set: { if !$0 { session.error = nil } })) {
            Button("확인", role: .cancel) {}
        } message: { Text(session.error ?? "") }
    }

    private var showsCuration: Bool { session.curation != nil || session.curating }

    /// Beside the conversation: the project's plan, and the suggestions for the user's notes.
    private var side: some View {
        VStack(spacing: Layout.spacing) {
            if let project = session.project { ProjectPanel(project: project) }
            if showsCuration { CurationPanel(curation: session.curation) }
        }
    }

    private var conversation: some View {
        VStack(spacing: 0) {
            ScrollViewReader { reader in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 10) {
                        if session.chat.isEmpty {
                            Text("무엇이든 말해 보세요. 예: \"우리 팀은 어떻게 구성돼 있어?\", \"지난 프로젝트에서 뭘 배웠지?\", \"README를 읽고 소개 글을 써 줘\"")
                                .foregroundStyle(.secondary).padding(.top, 24).frame(maxWidth: .infinity)
                        }
                        ForEach(session.chat) { line in ChatBubble(line: line).id(line.id) }
                        if session.chatBusy {
                            HStack(spacing: 6) { ProgressView().controlSize(.small); Text("Main이 답하는 중…").foregroundStyle(.secondary) }.id("busy")
                        }
                        if let project = session.project, project.status == "waiting_user" {
                            Label(project.questions.isEmpty ? "계획이 준비됐습니다. 계획을 확인하고 승인하세요." : "Main이 계획에서 질문했습니다. 계획 패널에서 답해 주세요.", systemImage: "arrow.right.circle")
                                .font(.callout).foregroundStyle(Color.accentColor)
                        }
                    }
                    .padding(Layout.inset)
                }
                .onChange(of: session.chat.count) { _ in if let last = session.chat.last { withAnimation { reader.scrollTo(last.id, anchor: .bottom) } } }
                .onAppear { if let last = session.chat.last { reader.scrollTo(last.id, anchor: .bottom) } }
            }
            Divider()
            VStack(alignment: .leading, spacing: 6) {
                if mainMissing {
                    Label("Main에 배정된 모델이 없습니다. 모델 배정 탭에서 추가하세요.", systemImage: "exclamationmark.circle").font(.caption).foregroundStyle(.orange)
                }
                HStack(alignment: .bottom, spacing: 8) {
                    TextField("Main에게 말하기", text: $draft, axis: .vertical)
                        .textFieldStyle(.plain).lineLimit(1...6).padding(8)
                        .background(RoundedRectangle(cornerRadius: 8).strokeBorder(Color(nsColor: .separatorColor)))
                        .onSubmit(submit)
                    if session.chatBusy {
                        Button("중지") { session.cancelChat() }
                    } else {
                        Button("보내기", action: submit).buttonStyle(.borderedProminent)
                            .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                }
                HStack {
                    Text("Return으로 보내고, Option+Return으로 줄을 바꿉니다.").font(.caption).foregroundStyle(.tertiary)
                    Spacer()
                    if session.dreaming {
                        ProgressView().controlSize(.small)
                        Text("Library 정리 중").font(.caption).foregroundStyle(.secondary)
                        Button("멈춤") { session.cancelTidy() }.controlSize(.small)
                    } else {
                        Button("Library 정리") { session.tidyLibrary() }.controlSize(.small).disabled(session.running)
                            .help("쌓인 교훈과 결정을 살펴 같은 것은 합치고, 남길 가치가 낮은 것은 Archive 폴더로 옮깁니다. 지우지 않습니다.")
                    }
                    Button("문서 연결 제안") { session.curate() }.controlSize(.small).disabled(session.curating)
                        .help("내 노트를 살펴 서로 이을 만한 문서를 제안합니다. 고른 것만 적용하며, 그 전에는 아무것도 바꾸지 않습니다.")
                    Button("대화 지우기") { session.clearChat() }.controlSize(.small).disabled(session.chat.isEmpty || session.chatBusy)
                }
            }
            .padding(Layout.inset)
        }
        .panel()
    }

    private func submit() {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !session.chatBusy else { return }
        draft = ""
        session.sendChat(text)
    }
}

private struct ChatBubble: View {
    let line: ChatLine
    private var mine: Bool { line.role == "user" }

    var body: some View {
        HStack {
            if mine { Spacer(minLength: 60) }
            VStack(alignment: .leading, spacing: 4) {
                if mine { Text(line.text).textSelection(.enabled).fixedSize(horizontal: false, vertical: true) }
                else { MarkdownText(text: line.text) }
                if let project = line.project {
                    Label("프로젝트를 시작했습니다: \(project)", systemImage: "list.bullet.clipboard").font(.caption).foregroundStyle(.secondary).lineLimit(3)
                }
                if !mine, let model = line.model {
                    HStack(spacing: 6) {
                        Text(line.provider.map { "\($0):\(model)" } ?? model).font(.caption2).foregroundStyle(.tertiary)
                        if line.isError != true, let judgement = line.judgement { ModelFeedbackLink(judgement: judgement) }
                    }
                }
            }
            .padding(.horizontal, 12).padding(.vertical, 8)
            .background(RoundedRectangle(cornerRadius: 12).fill(mine ? Color.accentColor.opacity(0.18) : (line.isError == true ? Color.red.opacity(0.12) : Color(nsColor: .controlBackgroundColor))))
            if !mine { Spacer(minLength: 60) }
        }
    }
}

/// Main's replies often use Markdown: headings, lists, emphasis and code are shown as such.
/// (Tables stay as typed, in a monospaced face.)
struct MarkdownText: View {
    let text: String

    private enum Block: Hashable { case heading(Int, String), bullet(String, String), rule, code(String), table(String), paragraph(String), gap }

    private var blocks: [Block] {
        var out: [Block] = [], code: [String]? = nil
        for raw in text.components(separatedBy: "\n") {
            let line = raw.trimmingCharacters(in: .whitespaces)
            if line.hasPrefix("```") {
                if let lines = code { out.append(.code(lines.joined(separator: "\n"))); code = nil } else { code = [] }
                continue
            }
            if code != nil { code?.append(raw); continue }
            if line.isEmpty { if out.last != .gap, !out.isEmpty { out.append(.gap) }; continue }
            if line.allSatisfy({ $0 == "-" || $0 == "*" || $0 == "_" }) && line.count >= 3 { out.append(.rule); continue }
            if let hashes = line.firstIndex(where: { $0 != "#" }), line.hasPrefix("#"), line[hashes] == " " {
                out.append(.heading(line.distance(from: line.startIndex, to: hashes), String(line[hashes...]).trimmingCharacters(in: .whitespaces))); continue
            }
            if line.hasPrefix("- ") || line.hasPrefix("* ") || line.hasPrefix("+ ") { out.append(.bullet("•", String(line.dropFirst(2)))); continue }
            if let dot = line.firstIndex(where: { $0 == "." || $0 == ")" }), line[..<dot].allSatisfy(\.isNumber), !line[..<dot].isEmpty, line.index(after: dot) < line.endIndex, line[line.index(after: dot)] == " " {
                out.append(.bullet(String(line[...dot]), String(line[line.index(dot, offsetBy: 2)...]))); continue
            }
            if line.hasPrefix("|") { out.append(.table(line)); continue }
            out.append(.paragraph(line))
        }
        if let lines = code { out.append(.code(lines.joined(separator: "\n"))) }
        while out.last == .gap { out.removeLast() }
        return out
    }

    private func inline(_ text: String) -> AttributedString {
        (try? AttributedString(markdown: text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(text)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                switch block {
                case .heading(let level, let text): Text(inline(text)).font(level <= 1 ? .title3.bold() : level == 2 ? .headline : .subheadline.bold()).padding(.top, 4)
                case .bullet(let mark, let text):
                    HStack(alignment: .firstTextBaseline, spacing: 6) { Text(mark).foregroundStyle(.secondary); Text(inline(text)).fixedSize(horizontal: false, vertical: true) }
                case .rule: Divider().padding(.vertical, 2)
                case .code(let code): Text(code).font(.system(.callout, design: .monospaced)).padding(8).frame(maxWidth: .infinity, alignment: .leading).background(RoundedRectangle(cornerRadius: 6).fill(Color.primary.opacity(0.06)))
                case .table(let row): Text(row).font(.system(.caption, design: .monospaced))
                case .paragraph(let text): Text(inline(text)).fixedSize(horizontal: false, vertical: true)
                case .gap: Spacer().frame(height: 4)
                }
            }
        }
        .textSelection(.enabled)
    }
}
