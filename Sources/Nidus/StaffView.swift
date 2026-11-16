import SwiftUI

/// Home: the Vault's standing teams and employees. Their identity does not depend on a model;
/// the user gives each employee principles of their own.
struct StaffView: View {
    @EnvironmentObject private var store: VaultStore
    @EnvironmentObject private var session: WorkspaceSession

    struct Group: Decodable, Identifiable { let id: String; let name: String; let focus: String }
    struct Employee: Decodable, Identifiable { let id: String; let name: String; let group: String; let kind: String; let role: String; let principles: [String] }
    struct Staff: Decodable { let groups: [Group]; let employees: [Employee] }

    @State private var staff: Staff?
    @State private var problem: String?

    var body: some View {
        ScrollingPage {
            PageHeader(title: "직원", subtitle: "이 Vault의 상설 팀과 직원입니다. 모델이 바뀌어도 같은 직원으로 일합니다. Main은 요청마다 이 팀에서 고르고, 필요하면 새 팀이나 직원을 제안합니다(계획을 승인하면 함께 승인됩니다). 직원마다 지킬 원칙을 한 줄에 하나씩 적을 수 있습니다. 이름과 구성은 Vault의 .nidus/office/staff.json에서 고칩니다.")
            if let problem { Label(problem, systemImage: "exclamationmark.triangle").foregroundStyle(.orange) }
            if let staff {
                ForEach(staff.groups) { group in
                    VStack(alignment: .leading, spacing: 10) {
                        Text(group.name).font(.headline)
                        Text(group.focus).font(.callout).foregroundStyle(.secondary)
                        ForEach(staff.employees.filter { $0.group == group.id }) { employee in
                            EmployeeRow(employee: employee) { principles in await save(employee.id, principles) }
                        }
                    }
                    .padding(Layout.inset).frame(maxWidth: .infinity, alignment: .leading).panel()
                }
            } else if problem == nil {
                ProgressView()
            }
        }
        .task(id: store.vault) { await load() }
    }

    private func decode(_ value: [String: Any]) -> Staff? {
        guard let data = try? JSONSerialization.data(withJSONObject: value) else { return nil }
        return try? JSONDecoder().decode(Staff.self, from: data)
    }

    private func load() async {
        guard let vault = store.vault else { return }
        await session.attach(vault)
        do { staff = decode(try await session.send("staff")); problem = staff == nil ? "직원 목록을 읽지 못했습니다." : nil }
        catch { problem = error.localizedDescription }
    }

    private func save(_ employee: String, _ principles: [String]) async {
        do { staff = decode(try await session.send("setPrinciples", ["employee": employee, "principles": principles])) ?? staff; problem = nil }
        catch { problem = error.localizedDescription }
    }
}

private struct EmployeeRow: View {
    let employee: StaffView.Employee
    let save: ([String]) async -> Void
    @State private var text = ""
    @State private var editing = false

    private var lines: [String] { text.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty } }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline) {
                Image(systemName: employee.kind == "manager" ? "person.crop.circle.badge.checkmark" : "person.crop.circle").foregroundStyle(.secondary)
                Text(employee.name).font(.body.weight(.medium))
                Text(employee.kind == "manager" ? "Manager" : employee.role).font(.caption).foregroundStyle(.secondary)
                Text(employee.id).font(.system(.caption, design: .monospaced)).foregroundStyle(.tertiary)
                Spacer()
                if editing {
                    Button("취소") { text = employee.principles.joined(separator: "\n"); editing = false }
                    Button("저장") { Task { await save(lines); editing = false } }.buttonStyle(.borderedProminent)
                } else {
                    Button(employee.principles.isEmpty ? "원칙 추가" : "원칙 고치기") { editing = true }
                }
            }
            if editing {
                TextEditor(text: $text).font(.callout).frame(height: 80)
                    .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Color(nsColor: .separatorColor)))
                Text("한 줄에 하나씩, 12개까지. 예: 항상 출처를 적는다").font(.caption).foregroundStyle(.secondary)
            } else {
                ForEach(employee.principles, id: \.self) { Text("· \($0)").font(.callout).foregroundStyle(.secondary) }
            }
        }
        .onAppear { text = employee.principles.joined(separator: "\n") }
        .onChange(of: employee.principles) { new in if !editing { text = new.joined(separator: "\n") } }
    }
}
