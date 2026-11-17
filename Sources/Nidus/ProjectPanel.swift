import SwiftUI

/// Main's plan for the current request, its questions, and the Task Board as it runs.
struct ProjectPanel: View {
    @EnvironmentObject private var session: WorkspaceSession
    let project: OfficeProject

    @State private var answers: [String: String] = [:]
    @State private var note = ""

    private var busy: Bool { session.running }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text(title).font(.headline)
                Spacer()
                if busy { ProgressView().controlSize(.small) }
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    Text(project.instruction).font(.callout).foregroundStyle(.secondary).lineLimit(3)
                    if project.status == "planning" && project.tasks.isEmpty {
                        Text("Main이 계획을 세우고 있습니다…").foregroundStyle(.secondary)
                    }
                    if !project.summary.isEmpty { Text(project.summary).font(.callout).textSelection(.enabled) }
                    if !project.roadmap.isEmpty {
                        VStack(alignment: .leading, spacing: 2) {
                            ForEach(Array(project.roadmap.enumerated()), id: \.offset) { index, step in
                                Text("\(index + 1). \(step)").font(.caption)
                            }
                        }
                    }
                    if !project.proposals.isEmpty && project.status == "waiting_user" {
                        VStack(alignment: .leading, spacing: 2) {
                            Label("Main의 제안 (계획을 승인하면 함께 승인됩니다)", systemImage: "person.badge.plus").font(.caption.weight(.semibold))
                            ForEach(project.proposals, id: \.self) { Text("· \($0)").font(.caption) }
                        }
                        .foregroundStyle(.orange)
                    }
                    ForEach(project.openAgendas) { agenda in
                        AgendaCard(agenda: agenda, task: project.tasks.first { $0.id == agenda.taskId }?.title)
                    }
                    if !project.tasks.isEmpty {
                        Label(project.needsVm ? "VM이 필요한 Task가 있어, 그 Task를 시작할 때 VM을 켭니다" : "모든 Task를 VM 없이 처리합니다",
                              systemImage: project.needsVm ? "shippingbox" : "text.page")
                            .font(.caption).foregroundStyle(.secondary)
                        tasks
                    }
                    if let report = project.report, !report.isEmpty {
                        Divider()
                        Text("최종 보고").font(.subheadline.bold())
                        MarkdownText(text: report).font(.callout)
                    }
                    if let knowledge = project.knowledge, !knowledge.isEmpty {
                        VStack(alignment: .leading, spacing: 2) {
                            Label("Library에 기록했습니다", systemImage: "books.vertical").font(.caption.weight(.semibold))
                            ForEach(knowledge, id: \.self) { path in
                                Button { openNote(path) } label: { Text(path).font(.caption).multilineTextAlignment(.leading) }
                                    .buttonStyle(.link).help("Obsidian에서 엽니다(없으면 기본 앱)")
                            }
                        }
                        .foregroundStyle(.secondary)
                    }
                    if let error = project.error {
                        Label(error, systemImage: "exclamationmark.octagon").font(.callout).foregroundStyle(.red)
                    }
                    if project.status == "waiting_user" && !project.questions.isEmpty { questions }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(maxHeight: 360)
            actions
        }
        .padding(Layout.inset).panel()
    }

    /// Opens a Library document in Obsidian, where the user keeps the Vault; otherwise in its default app.
    private func openNote(_ path: String) {
        guard let vault = session.vault else { return }
        let file = URL(fileURLWithPath: vault).appendingPathComponent(path)
        var link = URLComponents(string: "obsidian://open")!
        link.queryItems = [URLQueryItem(name: "path", value: file.path)]
        if let url = link.url, NSWorkspace.shared.urlForApplication(toOpen: url) != nil, NSWorkspace.shared.open(url) { return }
        NSWorkspace.shared.open(file)
    }

    private var title: String {
        switch project.status {
        case "planning": return "Main · 계획 중"
        case "waiting_user": return project.questions.isEmpty ? "Main · 계획 확인" : "Main · 질문이 있습니다"
        case "running": return project.openAgendas.isEmpty ? "진행 중" : "Meeting Room · 결정을 기다립니다"
        case "reviewing": return "Main · 최종 검토 중"
        case "done": return "완료"
        case "stopped": return "중지됨"
        default: return "실패"
        }
    }

    private var tasks: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(project.teams) { team in
                let mine = project.tasks.filter { $0.team == team.id }
                if !mine.isEmpty {
                    Text("\(team.name)\(project.manager(of: team.id).map { " · \($0.name)" } ?? "") · \(team.focus)").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                    ForEach(mine) { task in TaskRow(task: task, worker: project.worker(of: task)?.name) }
                }
            }
        }
    }

    private var questions: some View {
        VStack(alignment: .leading, spacing: 8) {
            Divider()
            Text("Main의 질문").font(.subheadline.bold())
            ForEach(project.questions) { question in
                VStack(alignment: .leading, spacing: 4) {
                    Text(question.text).font(.callout)
                    TextField("답", text: Binding(get: { answers[question.id] ?? question.answer ?? "" }, set: { answers[question.id] = $0 }), axis: .vertical)
                        .textFieldStyle(.roundedBorder).lineLimit(1...4)
                }
            }
        }
    }

    @ViewBuilder
    private var actions: some View {
        switch project.status {
        case "waiting_user":
            VStack(alignment: .leading, spacing: 6) {
                TextField("Main에게 덧붙일 말 (선택)", text: $note, axis: .vertical).textFieldStyle(.roundedBorder).lineLimit(1...3)
                HStack {
                    Button("닫기") { session.closeProject() }
                    Spacer()
                    Button(project.questions.isEmpty ? "계획 수정 요청" : "답변 보내기") {
                        var all: [String: String] = [:]
                        for q in project.questions { all[q.id] = answers[q.id] ?? q.answer ?? "" }
                        session.replyToPlan(answers: all, note: note)
                        note = ""
                    }
                    .disabled(project.questions.isEmpty && note.trimmingCharacters(in: .whitespaces).isEmpty)
                    Button("계획 승인하고 시작") { session.approvePlan() }.buttonStyle(.borderedProminent)
                        .help("Manager들이 Task를 Worker에게 맡기기 시작합니다. 답하지 않은 질문은 Main이 적절히 판단합니다.")
                }
            }
            .disabled(busy)
        case "planning", "running", "reviewing":
            HStack { Spacer(); Button("중지", role: .destructive) { session.cancel() } }
        case "stopped":
            HStack {
                Button("닫기") { session.closeProject() }
                Spacer()
                Button("이어서 진행") { session.approvePlan() }.buttonStyle(.borderedProminent)
            }
        default:
            HStack { Spacer(); Button("닫고 새로 지시") { session.closeProject() } }
        }
    }
}

private struct TaskRow: View {
    let task: OfficeProject.Task
    var worker: String? = nil
    @State private var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Image(systemName: icon).foregroundStyle(color).frame(width: 14)
                Text(task.title).font(.callout).lineLimit(expanded ? nil : 1)
                Spacer()
                if let worker { Text(worker).font(.caption2).foregroundStyle(.secondary) }
                Text(task.isText ? "텍스트" : "VM").font(.caption2).foregroundStyle(.secondary)
                    .padding(.horizontal, 5).padding(.vertical, 1)
                    .background(.quaternary, in: Capsule())
                    .help(task.isText ? "텍스트 작업: VM 없이 Vault의 커밋된 파일을 읽고 글로 결과물을 냅니다" : "VM 작업 공간에서 셸·브라우저·인터넷을 써서 작업합니다")
                if task.attempts > 1 { Text("\(task.attempts)차").font(.caption2).foregroundStyle(.secondary) }
                Button { expanded.toggle() } label: { Image(systemName: expanded ? "chevron.up" : "chevron.down") }.buttonStyle(.plain).foregroundStyle(.secondary)
            }
            if expanded {
                VStack(alignment: .leading, spacing: 3) {
                    Text("목표: \(task.contract.goal)")
                    if !task.contract.scope.isEmpty { Text("범위: \(task.contract.scope)") }
                    if !task.contract.constraints.isEmpty { Text("제약: \(task.contract.constraints)") }
                    Text("완료 조건:")
                    ForEach(task.contract.acceptance, id: \.self) { Text("· \($0)") }
                    if !task.contract.verification.isEmpty { Text("검증: \(task.contract.verification)") }
                    if let difficulty = task.difficulty { Text("Worker 난이도: \(difficulty)") }
                    if let result = task.result { Text("결과: \(result.summary)").foregroundStyle(.primary) }
                    if let output = task.output, !output.isEmpty {
                        HStack {
                            Text("결과물").font(.caption.weight(.semibold))
                            Spacer()
                            Button("복사") {
                                NSPasteboard.general.clearContents()
                                NSPasteboard.general.setString(output, forType: .string)
                            }.controlSize(.mini)
                        }
                        ScrollView {
                            Text(output).font(.caption).foregroundStyle(.primary).frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .frame(maxHeight: 220)
                        .padding(6).background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 6))
                    }
                    if let last = task.reviews.last, last.verdict != "accept", !last.feedback.isEmpty { Text("검토: \(last.feedback)").foregroundStyle(.orange) }
                }
                .font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
                .padding(.leading, 20)
            }
        }
    }

    private var icon: String {
        switch task.status {
        case "done": return "checkmark.circle.fill"
        case "in_progress": return "circle.dotted"
        case "review": return "eye"
        case "blocked": return "exclamationmark.octagon"
        case "waiting_user": return "hand.raised.fill"
        case "skipped": return "minus.circle"
        default: return "circle"
        }
    }

    private var color: Color {
        switch task.status {
        case "done": return .green
        case "in_progress", "review": return .accentColor
        case "blocked": return .red
        case "waiting_user": return .orange
        default: return .secondary
        }
    }
}

/// One matter the team put to the user (Meeting Room): the AI lays out the question; the user decides.
private struct AgendaCard: View {
    @EnvironmentObject private var session: WorkspaceSession
    let agenda: OfficeProject.Agenda
    let task: String?
    @State private var choice: Int?
    @State private var note = ""
    @State private var remember = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label {
                Text(agenda.title).font(.callout.weight(.semibold))
            } icon: { Image(systemName: "hand.raised.fill").foregroundStyle(.orange) }
            Text("\(agenda.from == "manager" ? "Manager" : agenda.from == "red-team" ? "Red Team" : "Lead Manager")가 결정을 요청했습니다\(task.map { " · \($0) Task는 결정을 기다립니다" } ?? "")")
                .font(.caption).foregroundStyle(.secondary)
            if !agenda.background.isEmpty { Text(agenda.background).font(.callout).textSelection(.enabled) }
            if !agenda.reasoning.isEmpty { Text("판단 근거: \(agenda.reasoning)").font(.caption).foregroundStyle(.secondary).textSelection(.enabled) }
            VStack(alignment: .leading, spacing: 4) {
                ForEach(Array(agenda.options.enumerated()), id: \.offset) { index, option in
                    Button { choice = index } label: {
                        HStack(alignment: .firstTextBaseline) {
                            Image(systemName: choice == index ? "largecircle.fill.circle" : "circle").foregroundStyle(choice == index ? Color.accentColor : .secondary)
                            VStack(alignment: .leading, spacing: 1) {
                                Text(option.label).font(.callout)
                                if !option.impact.isEmpty { Text(option.impact).font(.caption).foregroundStyle(.secondary) }
                            }
                            Spacer(minLength: 0)
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            }
            if !agenda.recommendation.isEmpty { Text("추천: \(agenda.recommendation)").font(.caption).foregroundStyle(.secondary) }
            TextField(choice == nil ? "다른 지시 (선택지 대신. 예: 더 알아보고 다시 올려 줘)" : "덧붙일 말 (선택)", text: $note, axis: .vertical)
                .textFieldStyle(.roundedBorder).lineLimit(1...3)
            HStack {
                Toggle("Library에 기록", isOn: $remember).help("오래 기억할 결정이면 Library의 결정 문서로 남깁니다").toggleStyle(.checkbox).font(.caption)
                Spacer()
                Button("하지 않음", role: .destructive) { session.decide(agenda.id, kind: "reject", option: nil, note: note, remember: remember) }
                if choice == nil {
                    Button("이 지시로 진행") { session.decide(agenda.id, kind: "instruct", option: nil, note: note, remember: remember) }
                        .buttonStyle(.borderedProminent).disabled(note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                } else {
                    Button("이 선택으로 진행") { session.decide(agenda.id, kind: "option", option: choice, note: note, remember: remember) }
                        .buttonStyle(.borderedProminent)
                }
            }
        }
        .padding(10)
        .background(RoundedRectangle(cornerRadius: 8).fill(Color.orange.opacity(0.08)))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Color.orange.opacity(0.4)))
    }
}
