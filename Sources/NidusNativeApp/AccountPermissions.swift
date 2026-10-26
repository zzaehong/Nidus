import SwiftUI
import AppKit

struct AccountPermission: Decodable, Identifiable {
    var id: String { provider }
    let provider: String
    let state: String
    let paidAllowed: Bool
    let revision: Int?
    let accountId: String
    let checkedAt: String?
    let verification: String
    let source: String
    let legacyHint: String?
    let verificationNote: String
    let officialTerms: String
    var label: String { billingLabel(state) }
}
func billingLabel(_ state: String) -> String {
    ["free_only":"Free Only", "hybrid":"Hybrid", "paid_only":"Paid Only", "unknown":"Unknown · 재확인 필요"][state] ?? state
}
struct AccountPermissionFields: View {
    @Binding var state: String
    @Binding var paid: Bool
    @Binding var confirmed: Bool
    @Binding var risk: Bool
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Picker("계정 과금 유형", selection: $state) {
                ForEach(["unknown","free_only","hybrid","paid_only"], id: \.self) { Text(billingLabel($0)).tag($0) }
            }.onChange(of: state) { _ in paid = false; confirmed = false; risk = false }
            Text("Provider 요금 체계와 현재 계정 상태는 다릅니다. 이 설정은 사용자 선언이며 공식 Billing 검증이 아닙니다.").font(.caption)
            if state != "unknown" {
                Toggle(state == "free_only" ? "이 계정은 유료 과금이 비활성화된 무료 전용 계정입니다" : "현재 계정의 과금 유형을 확인했습니다", isOn: $confirmed)
                Toggle("잘못 설정하면 과금될 수 있으며 앱 내 금액 제한은 없음을 이해합니다", isOn: $risk)
            }
            if ["hybrid","paid_only"].contains(state) {
                Toggle("이 Provider의 현재·향후 모든 모델에 유료 호출 허용", isOn: $paid)
                Text("승인은 현재 키·계정에만 적용합니다. 자동 Fallback에도 적용되며 언제든 철회할 수 있습니다.").font(.caption).foregroundStyle(.orange)
            }
            if state == "unknown" { Text("모델 목록은 조회할 수 있습니다. 자동 호출은 차단되며 수동 실행은 요청별 승인이 필요합니다.").font(.caption) }
        }
    }
}
struct AccountPermissionCard: View {
    let provider: Provider
    @State private var account: AccountPermission?
    @State private var editing = false
    @State private var error: String?
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text("\(provider.name) · \(account?.label ?? "Unknown") · 유료 호출 \(account?.paidAllowed == true ? "승인됨" : "미승인")")
                Spacer()
                Button("과금 유형 / 실행 권한 설정") { editing = true }
            }
            Text("\(account?.verification == "user-declared" ? "사용자 선언 · 공식 검증 아님" : "계정 상태 미확인") · 확인 시각 \(account?.checkedAt ?? "없음")").font(.caption)
            if let error { Text(error).foregroundStyle(.red).font(.caption) }
        }.padding(10).background(.quaternary.opacity(0.3), in: RoundedRectangle(cornerRadius: 8))
            .task { await refresh() }
            .sheet(isPresented: $editing, onDismiss: { Task { await refresh() } }) { AccountPermissionEditor(provider: provider) }
    }
    private func refresh() async {
        do { account = try JSONDecoder().decode(AccountPermission.self, from: await Runtime.shared.call(["method":"account-permission","provider":provider.rawValue])); error = nil }
        catch { self.error = error.localizedDescription }
    }
}
struct AccountPermissionEditor: View {
    let provider: Provider
    @Environment(\.dismiss) private var dismiss
    @State private var state = "unknown"
    @State private var paid = false
    @State private var confirmed = false
    @State private var risk = false
    @State private var accountId = ""
    @State private var account: AccountPermission?
    @State private var error: String?
    @State private var busy = true
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("\(provider.name) 계정 및 실행 권한").font(.title2.bold())
            AccountPermissionFields(state: $state, paid: $paid, confirmed: $confirmed, risk: $risk)
            TextField("프로젝트 / 계정 식별자 (선택)", text: $accountId).textFieldStyle(.roundedBorder)
            if let account {
                if let hint = account.legacyHint, hint != "unknown" { Text("이전 설정: \(hint) · 실행 권한으로 승계하지 않습니다. 현재 계정을 다시 확인하세요.").font(.caption).foregroundStyle(.orange) }
                Text("공식 요금 조건: \(account.officialTerms)").font(.caption)
                if let url = URL(string: account.source) { Link("공식 문서에서 계정 조건 확인", destination: url) }
                Text("현재 연결 권한으로 계정 과금 유형 자동 검증은 연결되어 있지 않습니다. 잔액이나 모델 목록 성공을 계정 유형의 증거로 사용하지 않습니다.").font(.caption)
            }
            if let error { Text(error).foregroundStyle(.red) }
            HStack {
                Button("닫기") { dismiss() }
                Spacer()
                Button("설정 저장") { Task { await save() } }
                    .disabled(busy || (state != "unknown" && (!confirmed || !risk)))
            }
        }.padding(24).frame(width: 650).task {
            do {
                let result = try JSONDecoder().decode(AccountPermission.self, from: await Runtime.shared.call(["method":"account-permission","provider":provider.rawValue]))
                account = result; state = result.state; accountId = result.accountId
                // Approval is never silently renewed when reviewing a changed billing type.
            } catch { self.error = error.localizedDescription }
            busy = false
        }
    }
    private func save() async {
        busy = true; defer { busy = false }
        do {
            _ = try await Runtime.shared.call(["method":"account-permission-set","provider":provider.rawValue,"state":state,"paidAllowed":paid,"confirmed":confirmed,"riskAccepted":risk,"accountId":accountId,"expectedRevision":account?.revision ?? 0])
            dismiss()
        } catch { self.error = error.localizedDescription }
    }
}

extension Dashboard {
    // Only explicit manual operations may ask for one-shot consent. Batch and auto use transport directly.
    @MainActor func manualCall(_ request: [String: Any], confirm: ((String, String) -> Bool)? = nil) async throws -> Data {
        do {
            let data = try await transport(request)
            if request["method"] as? String == "probe",
               let result = try? JSONDecoder().decode(ProbeResponse.self, from: data),
               result.error?.code == "execution_permission", result.error?.message.contains("account_unknown") == true {
                throw DashboardError(message: result.error!.message)
            }
            return data
        }
        catch {
            guard ["chat","probe"].contains(request["method"] as? String ?? ""),
                  error.localizedDescription.contains("account_unknown"),
                  let provider = request["provider"] as? String else { throw error }
            let task = request["method"] as? String ?? "chat"
            let model = request["model"] as? String ?? (request["request"] as? [String:Any])?["model"] as? String ?? ""
            let alert = NSAlert()
            alert.messageText = "과금 상태 미확인 · 이번 요청만 승인"
            alert.informativeText = "\(provider) / \(model)\n실제 비용이 발생할 수 있습니다. 금액 제한은 없습니다. 승인은 이번 요청에만 적용하며 자동 Fallback은 실행하지 않습니다."
            alert.addButton(withTitle: "취소")
            alert.addButton(withTitle: "과금 위험을 이해하고 1회 실행")
            let accepted = confirm?(provider, model) ?? (alert.runModal() == .alertSecondButtonReturn)
            guard accepted else { throw DashboardError(message: "사용자가 요청을 취소했습니다. API 미호출.") }
            struct Consent: Decodable { let token: String }
            let consent = try JSONDecoder().decode(Consent.self, from: await transport(["method":"request-consent","provider":provider,"model":model,"task":task,"riskAccepted":true]))
            return try await transport(request.merging(["consentToken":consent.token]) { _,new in new })
        }
    }
}
