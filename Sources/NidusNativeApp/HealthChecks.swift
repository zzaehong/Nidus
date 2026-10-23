import Foundation

struct ModelClassification: Decodable {
    let kind: String
    let confidence: String
    let reason: String
    let textProbe: String
    var label: String { modelKindLabel(kind) + (confidence == "inferred" ? " · 추정" : "") }
}
func modelKindLabel(_ kind: String) -> String {
    ["text": "텍스트", "image": "이미지 생성", "video": "영상 생성", "live": "라이브", "audio": "음성/음악", "embedding": "임베딩", "moderation": "모더레이션", "unknown": "기타/미확인"][kind] ?? "기타/미확인"
}
enum CheckStatus: String, Codable {
    case queued, running, passed, failed, skipped, cancelled
    var label: String {
        switch self {
        case .queued: return "대기"; case .running: return "검사 중"; case .passed: return "텍스트 응답 확인"
        case .failed: return "요청 실패/판정 보류"; case .skipped: return "미검사"; case .cancelled: return "중지됨"
        }
    }
}
struct HealthRow: Identifiable {
    var id: String { provider.rawValue + ":" + model }
    let provider: Provider
    let model: String
    let kind: String
    var status: CheckStatus
    var reason: String
    var checkedAt: String?
    var durationMs: Int?
    var inputTokens: Int?
    var outputTokens: Int?
}
struct ProbeResponse: Decodable {
    let model: String
    let status: CheckStatus
    let reason: String
    let checkedAt: String
    let durationMs: Int
    let stopProvider: Bool
    let error: ProbeError?
    let usage: ChatResult.Usage?
    struct ProbeError: Decodable { let code: String; let message: String }
}

extension Dashboard {
    func healthPlan(providers: [Provider], allowInferred: Bool, limit: Int) -> [HealthRow] {
        var rows: [HealthRow] = [], seen = Set<String>(), count = 0
        for provider in providers {
            for model in (states[provider]?.models ?? []).sorted(by: { $0.id < $1.id }) {
                guard seen.insert(provider.rawValue + ":" + model.id).inserted else { continue }
                let classification = model.classification
                let supported = classification?.textProbe == "supported" || (allowInferred && classification?.textProbe == "opt_in")
                let eligible = supported && count < max(1, min(limit, 500))
                if eligible { count += 1 }
                let reason = eligible ? "텍스트 요청 예정 · 최대 출력 256토큰" : supported ? "선택한 요청 개수 한도 초과" : classification?.textProbe == "opt_in" ? "추정 텍스트 모델 포함 동의 필요" : "해당 유형의 검사기 미지원 · 고장을 의미하지 않음"
                rows.append(HealthRow(provider: provider, model: model.id, kind: classification?.kind ?? "unknown", status: eligible ? .queued : .skipped, reason: reason))
            }
        }
        return rows
    }
    func stopHealthChecks() { healthStopRequested = true }
    func runHealthChecks(providers: [Provider], allowInferred: Bool, limit: Int, confirmed: Bool,
                         pause: () async -> Void = { try? await Task.sleep(nanoseconds: 1_000_000_000) }) async {
        guard confirmed, ready, !healthRunning, !states.values.contains(where: { $0.busy }) else { return }
        healthRunning = true; healthStopRequested = false
        healthRows = healthPlan(providers: providers, allowInferred: allowInferred, limit: limit)
        defer { healthRunning = false }
        var blocked = Set<Provider>(), sent = false
        for index in healthRows.indices {
            guard healthRows[index].status == .queued else { continue }
            let row = healthRows[index]
            if blocked.contains(row.provider) {
                healthRows[index].status = .skipped
                healthRows[index].reason = "인증/권한/한도/전달 오류로 해당 Provider 검사 중단"
                continue
            }
            if sent && !healthStopRequested { await pause() }
            if healthStopRequested || Task.isCancelled {
                healthRows[index].status = .cancelled; healthRows[index].reason = "사용자 중지 · API 미호출"
                continue
            }
            healthRows[index].status = .running
            do {
                sent = true
                let data = try await transport(["method": "probe", "provider": row.provider.rawValue, "model": row.model, "allowInferred": allowInferred, "confirmed": true])
                let result = try JSONDecoder().decode(ProbeResponse.self, from: data)
                guard result.model == row.model, [.passed, .failed, .skipped].contains(result.status) else { throw DashboardError(message: "검사 응답 형식이 올바르지 않습니다.") }
                healthRows[index].status = result.status
                healthRows[index].reason = result.error.map { "[\($0.code)] \($0.message) · 모델 고장으로 단정할 수 없음" } ?? result.reason
                healthRows[index].checkedAt = result.checkedAt
                healthRows[index].durationMs = result.durationMs
                healthRows[index].inputTokens = result.usage?.inputTokens
                healthRows[index].outputTokens = result.usage?.outputTokens
                if result.stopProvider { blocked.insert(row.provider) }
            } catch {
                healthRows[index].status = .failed
                healthRows[index].reason = error.localizedDescription
                blocked.insert(row.provider)
            }
        }
    }
}
