import Foundation

enum ChatValidation: String {
    case verified = "검증 완료", untested = "미검사", failed = "검증 실패", unsupported = "미지원"
    func requiresConsent(acknowledged: Bool) -> Bool { self != .verified && !acknowledged }
    static func status(model: APIModel, result: HealthRow?) -> ChatValidation {
        guard model.usableForTextChat else { return .unsupported }
        if result?.status == .passed { return .verified }
        if result?.status == .failed { return .failed }
        return .untested
    }
}
struct ContextAssessment: Decodable {
    let status: String
    let inputTokens: Int
    let outputTokens: Int
    let limits: APIModel.Limits
    var warning: String {
        "문맥 입력 약 \(inputTokens)토큰 + 최대 출력 \(outputTokens)토큰 (UTF-8 기반 추정). 입력 한도 \(limits.inputTokens.map(String.init) ?? "미확인"), 전체 문맥 한도 \(limits.contextTokens.map(String.init) ?? "미확인"), 출력 한도 \(limits.outputTokens.map(String.init) ?? "미확인"). 정확한 토큰 수가 아니며 Provider가 거절할 수 있습니다. 이전 대화는 자동 삭제하지 않습니다."
    }
}
func conversationMessages(_ messages: [ChatMessage]) -> [[String: String]] {
    messages.filter { !$0.failed }.map { ["role": $0.role, "content": $0.content] }
}
