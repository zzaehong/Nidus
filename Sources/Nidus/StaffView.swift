import SwiftUI

/// Home: the Vault's standing teams and employees, and what each is working on. Their identity
/// does not depend on a model; the user names them, adds teams and Workers, and gives each
/// employee principles of their own. The Desks show what each Worker knows of its Task, and
/// Main's Desk what Main knows of the whole office.
struct StaffView: View {
    @EnvironmentObject private var store: VaultStore
    @EnvironmentObject private var session: WorkspaceSession

    struct Group: Decodable, Identifiable { let id: String; let name: String; let focus: String }
    struct Employee: Decodable, Identifiable { let id: String; let name: String; let group: String; let kind: String; let role: String; let principles: [String] }
    struct State: Decodable { let project: String?; let task: String?; let status: String; let at: String }
    struct Staff: Decodable { let groups: [Group]; let employees: [Employee]; let states: [String: State]? }

    @State private var staff: Staff?
    @State private var desks: DeskList?
    @State private var problem: String?
    @State private var addingGroup = false
    @State private var showingMainDesk = false

    var body: some View {
        ScrollingPage {
            PageHeader(title: "직원", subtitle: "이 Vault의 상설 팀과 직원입니다. 모델이 바뀌어도 같은 직원으로 일합니다. Main은 요청마다 이 팀에서 고르고, 필요하면 새 팀이나 직원을 제안합니다(계획을 승인하면 함께 승인됩니다). 여기서 팀과 직원을 더하고 이름을 바꾸며, 직원마다 지킬 원칙을 적습니다.")
            HStack {
                Button { showingMainDesk = true } label: { Label("Main Desk", systemImage: "rectangle.and.text.magnifyingglass") }
                    .help("Main이 작업과 Nidus 상황을 확인하는 상황판")
                Button { addingGroup = true } label: { Label("팀 추가", systemImage: "person.3") }
                Spacer()
                Button { Task { await load() } } label: { Image(systemName: "arrow.clockwise") }.help("다시 읽기")
            }
            if let problem { Label(problem, systemImage: "exclamationmark.triangle").foregroundStyle(.orange) }
            if let desks, let project = desks.project, !desks.desks.isEmpty { DeskSection(project: project, desks: desks.desks, staff: staff) }
            if let staff {
                ForEach(staff.groups) { group in
                    GroupCard(group: group, employees: staff.employees.filter { $0.group == group.id }, states: staff.states ?? [:], send: send)
                }
            } else if problem == nil {
                ProgressView()
            }
        }
        .task(id: store.vault) { await load() }
        .sheet(isPresented: $addingGroup) { AddGroupSheet { name, focus in await send("addGroup", ["name": name, "focus": focus]) } }
        .sheet(isPresented: $showingMainDesk) { MainDeskSheet() }
    }

    private func decode<T: Decodable>(_ value: [String: Any], as: T.Type) -> T? {
        guard let data = try? JSONSerialization.data(withJSONObject: value) else { return nil }
        return try? JSONDecoder().decode(T.self, from: data)
    }

    private func load() async {
        guard let vault = store.vault else { return }
        await session.attach(vault)
        do {
            staff = decode(try await session.send("staff"), as: Staff.self)
            desks = decode(try await session.send("desks"), as: DeskList.self)
            problem = staff == nil ? "직원 목록을 읽지 못했습니다." : nil
        } catch { problem = error.localizedDescription }
    }

    /// Sends an edit; the answer is the staff as saved. Returns the failure, if any, for the place that asked.
    @discardableResult
    private func send(_ command: String, _ arguments: [String: Any]) async -> String? {
        do {
            let saved = try await session.send(command, arguments)
            if let fresh = decode(saved, as: Staff.self) { staff = Staff(groups: fresh.groups, employees: fresh.employees, states: staff?.states) }
            problem = nil
            return nil
        } catch { return error.localizedDescription }
    }
}

// MARK: - teams and employees

private struct GroupCard: View {
    let group: StaffView.Group
    let employees: [StaffView.Employee]
    let states: [String: StaffView.State]
    let send: (String, [String: Any]) async -> String?
    @State private var editing = false
    @State private var name = ""
    @State private var focus = ""
    @State private var hiring = false
    @State private var problem: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if editing {
                TextField("팀 이름", text: $name).textFieldStyle(.roundedBorder)
                TextField("하는 일", text: $focus, axis: .vertical).textFieldStyle(.roundedBorder).lineLimit(1...3)
                HStack {
                    Spacer()
                    Button("취소") { editing = false; problem = nil }
                    Button("저장") { Task { problem = await send("editGroup", ["group": group.id, "name": name, "focus": focus]); if problem == nil { editing = false } } }
                        .buttonStyle(.borderedProminent).disabled(name.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            } else {
                HStack(alignment: .firstTextBaseline) {
                    Text(group.name).font(.headline)
                    Spacer()
                    Button("팀 고치기") { name = group.name; focus = group.focus; editing = true }.controlSize(.small)
                    Button("직원 추가") { hiring = true }.controlSize(.small)
                }
                if !group.focus.isEmpty { Text(group.focus).font(.callout).foregroundStyle(.secondary) }
            }
            if let problem { Label(problem, systemImage: "exclamationmark.triangle").font(.caption).foregroundStyle(.orange) }
            ForEach(employees) { employee in
                EmployeeRow(employee: employee, state: states[employee.id], send: send)
            }
        }
        .padding(Layout.inset).frame(maxWidth: .infinity, alignment: .leading).panel()
        .sheet(isPresented: $hiring) { HireSheet(group: group) { name, role in await send("hire", ["group": group.id, "name": name, "role": role]) } }
    }
}

private struct EmployeeRow: View {
    let employee: StaffView.Employee
    let state: StaffView.State?
    let send: (String, [String: Any]) async -> String?
    @State private var text = ""
    @State private var editingPrinciples = false
    @State private var editingName = false
    @State private var name = ""
    @State private var role = ""
    @State private var problem: String?

    private var lines: [String] { text.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty } }
    private var isManager: Bool { employee.kind == "manager" }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline) {
                Image(systemName: isManager ? "person.crop.circle.badge.checkmark" : "person.crop.circle").foregroundStyle(.secondary)
                if editingName {
                    TextField("이름", text: $name).textFieldStyle(.roundedBorder).frame(maxWidth: 160)
                    if !isManager { TextField("역할 (예: Researcher)", text: $role).textFieldStyle(.roundedBorder).frame(maxWidth: 180) }
                    Button("취소") { editingName = false; problem = nil }
                    Button("저장") {
                        Task {
                            var arguments: [String: Any] = ["employee": employee.id, "name": name]
                            if !isManager { arguments["role"] = role }
                            problem = await send("editEmployee", arguments)
                            if problem == nil { editingName = false }
                        }
                    }.buttonStyle(.borderedProminent)
                } else {
                    Text(employee.name).font(.body.weight(.medium))
                    Text(isManager ? "Manager" : employee.role).font(.caption).foregroundStyle(.secondary)
                    if let state { StateBadge(state: state) }
                }
                Spacer()
                if !editingName && !editingPrinciples {
                    Button("이름 고치기") { name = employee.name; role = employee.role; editingName = true }.controlSize(.small)
                    Button(employee.principles.isEmpty ? "원칙 추가" : "원칙 고치기") { editingPrinciples = true }.controlSize(.small)
                } else if editingPrinciples {
                    Button("취소") { text = employee.principles.joined(separator: "\n"); editingPrinciples = false }
                    Button("저장") { Task { problem = await send("setPrinciples", ["employee": employee.id, "principles": lines]); if problem == nil { editingPrinciples = false } } }.buttonStyle(.borderedProminent)
                }
            }
            if let problem { Label(problem, systemImage: "exclamationmark.triangle").font(.caption).foregroundStyle(.orange) }
            if editingPrinciples {
                TextEditor(text: $text).font(.callout).frame(height: 80)
                    .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Color(nsColor: .separatorColor)))
                Text("한 줄에 하나씩, 12개까지. 예: 항상 출처를 적는다").font(.caption).foregroundStyle(.secondary)
            } else {
                ForEach(employee.principles, id: \.self) { Text("· \($0)").font(.callout).foregroundStyle(.secondary) }
            }
        }
        .onAppear { text = employee.principles.joined(separator: "\n") }
        .onChange(of: employee.principles) { new in if !editingPrinciples { text = new.joined(separator: "\n") } }
    }
}

/// Where an employee is: idle, or on which Task of which project, since when.
private struct StateBadge: View {
    let state: StaffView.State
    private var label: String {
        switch state.status {
        case "started": return "시작"
        case "working": return "작업 중"
        case "review": return "검토 중"
        case "done": return "마침"
        case "blocked": return "막힘"
        default: return "쉬는 중"
        }
    }
    var body: some View {
        Text([label, state.task].compactMap { $0 }.joined(separator: " · "))
            .font(.caption2).padding(.horizontal, 6).padding(.vertical, 1)
            .background(Capsule().fill(state.status == "working" || state.status == "started" ? Color.accentColor.opacity(0.18) : Color.primary.opacity(0.06)))
            .help("\(state.project ?? "") · \(clock(state.at))")
    }
}

private struct AddGroupSheet: View {
    @Environment(\.dismiss) private var dismiss
    let add: (String, String) async -> String?
    @State private var name = ""
    @State private var focus = ""
    @State private var problem: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("팀 추가").font(.headline)
            TextField("팀 이름 (예: 데이터 분석)", text: $name).textFieldStyle(.roundedBorder)
            TextField("하는 일 (Main이 팀을 고를 때 봅니다)", text: $focus, axis: .vertical).textFieldStyle(.roundedBorder).lineLimit(2...4)
            Text("팀장(Manager)이 함께 만들어집니다. Worker는 팀 카드의 \"직원 추가\"로 더합니다.").font(.caption).foregroundStyle(.secondary)
            if let problem { Label(problem, systemImage: "exclamationmark.triangle").font(.caption).foregroundStyle(.orange) }
            HStack {
                Spacer()
                Button("취소") { dismiss() }.keyboardShortcut(.cancelAction)
                Button("추가") { Task { problem = await add(name, focus); if problem == nil { dismiss() } } }
                    .buttonStyle(.borderedProminent).keyboardShortcut(.defaultAction).disabled(name.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        }
        .padding(Layout.margin).frame(width: 420)
    }
}

private struct HireSheet: View {
    @Environment(\.dismiss) private var dismiss
    let group: StaffView.Group
    let hire: (String, String) async -> String?
    @State private var name = ""
    @State private var role = ""
    @State private var problem: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("\(group.name)에 직원 추가").font(.headline)
            TextField("이름 (예: 분석가)", text: $name).textFieldStyle(.roundedBorder)
            TextField("역할 (예: Data Analyst)", text: $role).textFieldStyle(.roundedBorder)
            Text("Manager가 Task를 맡길 Worker입니다. 역할은 무엇을 잘하는 사람인지 한두 단어로 적습니다.").font(.caption).foregroundStyle(.secondary)
            if let problem { Label(problem, systemImage: "exclamationmark.triangle").font(.caption).foregroundStyle(.orange) }
            HStack {
                Spacer()
                Button("취소") { dismiss() }.keyboardShortcut(.cancelAction)
                Button("추가") { Task { problem = await hire(name, role); if problem == nil { dismiss() } } }
                    .buttonStyle(.borderedProminent).keyboardShortcut(.defaultAction).disabled(name.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        }
        .padding(Layout.margin).frame(width: 420)
    }
}

// MARK: - Desks

struct DeskList: Decodable {
    struct Project: Decodable { let id: String; let instruction: String; let status: String }
    struct Checkpoint: Decodable, Hashable { let at: String; let kind: String; let text: String }
    struct Desk: Decodable { let progress: String; let findings: String; let next: String; let references: [String]; let updatedAt: String; let checkpoints: [Checkpoint] }
    struct Item: Decodable, Identifiable { let task: String; let title: String; let status: String; let employee: String?; let employeeName: String?; let desk: Desk?; var id: String { task } }
    let project: Project?
    let desks: [Item]
}

/// The Desks of the open (or last) project: what each Worker knows of its Task, as the Worker keeps it.
private struct DeskSection: View {
    let project: DeskList.Project
    let desks: [DeskList.Item]
    let staff: StaffView.Staff?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                Text("Desk").font(.headline)
                Text(project.instruction).font(.callout).foregroundStyle(.secondary).lineLimit(1).truncationMode(.tail)
            }
            Text("Worker가 Task마다 적어 두는 작업 맥락입니다. 모델이 바뀌거나 작업이 끊겨도 여기서 이어갑니다.").font(.caption).foregroundStyle(.secondary)
            ForEach(desks) { item in
                DisclosureGroup {
                    if let desk = item.desk {
                        VStack(alignment: .leading, spacing: 6) {
                            field("진행", desk.progress)
                            field("알아낸 것", desk.findings)
                            field("다음", desk.next)
                            if !desk.references.isEmpty { field("참조", desk.references.joined(separator: "\n")) }
                            ForEach(desk.checkpoints, id: \.self) { c in
                                field("\(c.kind == "final" ? "마침" : c.kind == "summary" ? "요약" : "메모") · \(clock(c.at))", c.text)
                            }
                            Text("마지막 갱신 \(clock(desk.updatedAt))").font(.caption2).foregroundStyle(.tertiary)
                        }
                        .padding(.vertical, 4)
                    } else {
                        Text("아직 적은 것이 없습니다.").font(.callout).foregroundStyle(.secondary)
                    }
                } label: {
                    HStack {
                        Text("\(item.task) · \(item.title)").font(.callout.weight(.medium)).lineLimit(1)
                        Text(item.employeeName ?? "").font(.caption).foregroundStyle(.secondary)
                        Spacer()
                        Text(statusName(item.status)).font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
        }
        .padding(Layout.inset).frame(maxWidth: .infinity, alignment: .leading).panel()
    }

    @ViewBuilder private func field(_ label: String, _ text: String) -> some View {
        if !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            VStack(alignment: .leading, spacing: 2) {
                Text(label).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                Text(text).font(.callout).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func statusName(_ status: String) -> String {
        ["pending": "대기", "in_progress": "진행 중", "review": "검토 중", "done": "완료", "blocked": "진행 불가", "skipped": "건너뜀", "waiting_user": "결정 대기"][status] ?? status
    }
}

/// Main's Desk as Main reads it: built from the records, never written by a model.
private struct MainDeskSheet: View {
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var session: WorkspaceSession
    @State private var text = ""
    @State private var problem: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Main Desk").font(.headline)
                Spacer()
                Button { Task { await load() } } label: { Image(systemName: "arrow.clockwise") }.help("다시 읽기")
                Button("닫기") { dismiss() }.keyboardShortcut(.cancelAction)
            }
            Text("Main이 대화할 때마다 읽는 상황판입니다. 보드·호출 기록·활동 기록에서 코드가 만들며, 모델이 쓰지 않습니다. .nidus/local/main-desk/desk.md에도 저장됩니다.")
                .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            if let problem { Label(problem, systemImage: "exclamationmark.triangle").font(.caption).foregroundStyle(.orange) }
            ScrollView {
                Text(text.isEmpty ? "읽는 중…" : text).font(.system(.callout, design: .monospaced)).textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(10).panel()
        }
        .padding(Layout.margin).frame(width: 760, height: 620)
        .task { await load() }
    }

    private func load() async {
        do { text = (try await session.send("mainDesk"))["text"] as? String ?? ""; problem = nil }
        catch { problem = error.localizedDescription }
    }
}
