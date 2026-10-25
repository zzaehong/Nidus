import Foundation

struct ModelClassification: Decodable {
    let source: String?
    let checkedAt: String?
    let kind: String
    let confidence: String
    let reason: String
    let textProbe: String
    var label: String { modelKindLabel(kind) + (confidence == "inferred" ? " · 추정" : "") }
}
func modelKindLabel(_ kind: String) -> String {
    ["text": "텍스트", "image": "이미지 생성", "video": "영상 생성", "live": "라이브", "audio": "음성/음악", "embedding": "임베딩", "moderation": "모더레이션", "reranking": "검색 재정렬", "document": "문서 추출/OCR", "detection": "탐지/판별", "reward": "보상 평가", "unknown": "기타/미확인"][kind] ?? "기타/미확인"
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
struct HealthRow: Identifiable, Codable {
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
    func persistHealthResults() throws {
        guard healthStoreLoaded else { throw DashboardError(message: "기존 검사 기록을 읽지 못해 저장을 중단했습니다.") }
        do {
            try healthStore?.save(Array(healthHistory.values))
            healthStorageError = nil
        } catch {
            healthStorageError = "검사 결과를 저장하지 못했습니다. 새 결과는 현재 세션에만 유지됩니다. 저장 공간과 파일 권한을 확인해주세요."
            throw error
        }
    }
    func clearHealthResults(_ provider: Provider) throws {
        let previous = healthHistory
        healthHistory = healthHistory.filter { $0.value.provider != provider }
        do { try persistHealthResults() }
        catch { healthHistory = previous; throw DashboardError(message: "검사 기록 초기화 실패: API 키 변경을 진행하지 않았습니다.") }
        healthRows.removeAll { $0.provider == provider }
    }
    func healthPlan(providers: [Provider], allowInferred: Bool, limit: Int, onlyUntested: Bool = false) -> [HealthRow] {
        var rows: [HealthRow] = [], seen = Set<String>(), count = 0
        for provider in providers {
            for model in (states[provider]?.models ?? []).sorted(by: { $0.id < $1.id }) {
                guard seen.insert(provider.rawValue + ":" + model.id).inserted else { continue }
                if onlyUntested, let saved = healthHistory[provider.rawValue + ":" + model.id] {
                    rows.append(saved)
                    continue
                }
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
    func runHealthChecks(providers: [Provider], allowInferred: Bool, limit: Int, confirmed: Bool, onlyUntested: Bool = false,
                         pause: () async -> Void = { try? await Task.sleep(nanoseconds: 1_000_000_000) }) async {
        guard confirmed, ready, healthStoreLoaded, !healthRunning, !states.values.contains(where: { $0.busy }) else { return }
        healthRunning = true; healthStopRequested = false
        healthRows = healthPlan(providers: providers, allowInferred: allowInferred, limit: limit, onlyUntested: onlyUntested)
        defer { healthRunning = false }
        var sent = false
        for index in healthRows.indices {
            guard healthRows[index].status == .queued else { continue }
            let row = healthRows[index]
            if sent && !healthStopRequested { await pause() }
            if healthStopRequested || Task.isCancelled {
                healthRows[index].status = .cancelled; healthRows[index].reason = "사용자 중지 · API 미호출"
                continue
            }
            healthRows[index].status = .running
            let started = Date()
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
                // Even older runtimes may set stopProvider: a model failure must not skip the queue.
            } catch {
                healthRows[index].status = .failed
                healthRows[index].reason = "검사 요청 전달 또는 응답 해석에 실패했습니다."
                healthRows[index].checkedAt = ISO8601DateFormatter().string(from: Date())
                healthRows[index].durationMs = Int(Date().timeIntervalSince(started) * 1000)
            }
            if [.passed, .failed].contains(healthRows[index].status) {
                healthHistory[row.id] = healthRows[index]
                // Save after each result so stopping or exiting does not lose completed work.
                try? persistHealthResults()
            }
        }
    }
}
