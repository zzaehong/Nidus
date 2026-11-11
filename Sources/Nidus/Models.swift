import Foundation

struct VaultStatus: Decodable {
    let vault: String
    let exists: Bool
    let initialized: Bool
}

/// One row of the assignment table: a role, or a worker difficulty.
struct Slot: Decodable, Identifiable, Equatable {
    let id: String
    let role: String
    let difficulty: String?
    let candidates: [String]
    let resolved: String?
    let reason: String?
    let problem: String?

    var needsTools: Bool { role == "worker" }

    var title: String {
        switch id {
        case "roles.main": return "Main"
        case "roles.lead-manager": return "Lead Manager"
        case "roles.manager": return "Manager"
        case "worker.simple": return "Worker · 단순"
        case "worker.normal": return "Worker · 보통"
        case "worker.complex": return "Worker · 복잡"
        default: return role
        }
    }

    var summary: String {
        switch id {
        case "roles.main": return "사용자와 직접 소통하고 최종 결과물을 검토합니다."
        case "roles.lead-manager": return "여러 팀 사이의 협업과 작업 인계를 조정합니다."
        case "roles.manager": return "작업을 나눠 Worker에게 맡기고 결과를 검토합니다."
        case "worker.simple": return "지시자가 단순하다고 지정한 작업을 수행합니다."
        case "worker.normal": return "지시자가 보통이라고 지정한 작업을 수행합니다."
        case "worker.complex": return "지시자가 복잡하다고 지정한 작업을 수행합니다."
        default: return ""
        }
    }
}

struct ProviderInfo: Decodable, Identifiable, Equatable {
    let id: String
    let name: String
    let keyURL: String
    let needsAccountId: Bool
    let connected: Bool
    let models: Int
    let fetchedAt: String?
}

struct UsageGroup: Decodable, Identifiable, Equatable {
    let role: String
    let difficulty: String?
    let provider: String
    let model: String
    let calls: Int
    let failed: Int
    let inputTokens: Int
    let outputTokens: Int
    let cachedInputTokens: Int
    let costUSD: String
    let unknownCostCalls: Int

    var id: String { "\(role)/\(difficulty ?? "-")/\(provider)/\(model)" }
    var roleLabel: String { difficulty.map { "\(role) · \($0)" } ?? role }
}

struct UsageSummary: Decodable, Equatable {
    let month: String
    let calls: Int
    let costUSD: String
    let unknownCostCalls: Int
    let groups: [UsageGroup]
}

struct Overview: Decodable, Equatable {
    let vault: String
    let slots: [Slot]
    let providers: [ProviderInfo]
    let usage: UsageSummary
    let budgetUSD: String?
    let budgetWarning: String?
}

struct ModelChoice: Decodable, Identifiable, Equatable {
    let id: String
    let name: String
    /// Result of the last real check: passed, failed or untested.
    let text: String
    let tools: String
    let detail: String?
    let checkedAt: String?

    var untested: Bool { text == "untested" && tools == "untested" }

    /// Sort order for lists: most usable first.
    var rank: Int {
        if tools == "passed" { return 0 }
        if text == "passed" { return 1 }
        if untested { return 2 }
        return 3
    }

    /// Why the last check did not fully pass, in the app's language.
    var note: String? {
        guard let detail, tools != "passed" else { return nil }
        if detail.contains("not_found") { return "이 키로는 호출할 수 없는 모델입니다 (404)." }
        if detail.contains("did not call the tool") { return "도구를 호출하지 않고 텍스트로만 답했습니다." }
        if detail.contains("invalid tool input") { return "도구 입력을 형식에 맞지 않게 보냈습니다." }
        if detail.contains("did not use the tool result") { return "도구 결과를 답에 반영하지 않았습니다." }
        if detail.contains("invalid_request") { return "도구 호출 요청을 받아들이지 않습니다." }
        if detail.contains("permission") { return "이 키에 호출 권한이 없습니다." }
        if detail.contains("provider_error") { return "도구 호출에서 서버 오류가 났습니다. 다시 검사해 볼 수 있습니다." }
        return detail
    }

    /// Main and managers plan and review in text; workers must be able to call tools.
    func qualifies(for slot: Slot) -> Bool {
        slot.needsTools ? tools == "passed" : text == "passed"
    }
}

/// Outcome of checking one model. Each field is passed, failed or inconclusive.
struct CheckResult: Decodable, Equatable {
    let text: String
    let tools: String
    let detail: String
}

struct ConnectResult: Decodable {
    let provider: String
    let models: Int
}

struct AskResult: Decodable, Equatable {
    let text: String
    let stopReason: String
    let model: String
    let reason: String
    let inputTokens: Int?
    let outputTokens: Int?
    let costUSD: String?
    let warnings: [String]
}

struct Acknowledgement: Decodable {}

/// Trims the nine-decimal engine amount to something readable: "0.000018000" → "$0.000018", "12.500000000" → "$12.50".
func formatUSD(_ amount: String) -> String {
    guard let dot = amount.firstIndex(of: ".") else { return "$\(amount)" }
    var fraction = String(amount[amount.index(after: dot)...])
    while fraction.count > 2, fraction.hasSuffix("0") { fraction.removeLast() }
    return "$\(amount[..<dot]).\(fraction)"
}
