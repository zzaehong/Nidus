import Foundation

enum Provider: String, CaseIterable, Identifiable, Codable {
    case openai, anthropic, gemini, deepseek
    var id: String { rawValue }
    var name: String {
        switch self { case .openai: return "OpenAI · GPT"; case .anthropic: return "Anthropic · Claude"; case .gemini: return "Google Gemini"; case .deepseek: return "DeepSeek" }
    }
    var symbol: String {
        switch self { case .openai: return "sparkles"; case .anthropic: return "sun.max"; case .gemini: return "diamond"; case .deepseek: return "water.waves" }
    }
}
struct APIModel: Decodable, Identifiable {
    let id: String
    let name: String
    let capabilities: Capabilities
    let pricing: Price
    let classification: ModelClassification?
    struct Capabilities: Decodable { let chat: String; let streaming: String; let tools: String; let vision: String }
    struct Price: Decodable {
        let status: String
        let sourceUrl: String
        let checkedAt: String?
        let freeTier: String?
        let notes: String?
        let rates: [Rate]
        struct Rate: Decodable { let tier: String; let input: Double; let output: Double; let cachedInput: Double?; let conditions: String }
    }
}
struct ModelResult: Decodable { let source: String; let fetchedAt: String?; let models: [APIModel] }
struct ChatResult: Decodable {
    let text: String
    let usage: Usage
    struct Usage: Decodable { let inputTokens: Int?; let outputTokens: Int?; let totalTokens: Int? }
}
struct ProviderState {
    var models: [APIModel] = []
    var status = "연결 전"
    var fetchedAt: String?
    var error: String?
    var busy = false
    var selectedModel: String?
    var prompt = ""
    var system = ""
    var maxTokens = "1024"
    var response = ""
    var usage = ""
    var detail = ""
}

@MainActor final class Dashboard: ObservableObject {
    typealias Transport = ([String: Any]) async throws -> Data
    let transport: Transport
    init(transport: @escaping Transport = { try await Runtime.shared.call($0) }) { self.transport = transport }
    @Published var states = Dictionary(uniqueKeysWithValues: Provider.allCases.map { ($0, ProviderState()) })
    @Published var ready = false
    @Published var runtimeError: String?
    @Published var healthRows: [HealthRow] = []
    @Published var healthRunning = false
    @Published var healthStopRequested = false
    private var started = false
    func start() async {
        guard !started else { return }; started = true
        runtimeError = nil
        do {
            _ = try await transport(["method": "ping"]); ready = true
            for provider in Provider.allCases { await operation("cached", provider) }
        } catch { runtimeError = error.localizedDescription; started = false }
    }
    func operation(_ method: String, _ provider: Provider, extra: [String: Any] = [:]) async {
        guard ready, !healthRunning, states[provider]?.busy == false else { return }
        if ["connect", "models", "disconnect"].contains(method) { healthRows.removeAll { $0.provider == provider } }
        states[provider]?.busy = true; states[provider]?.error = nil
        defer { states[provider]?.busy = false }
        do {
            let data = try await transport(extra.merging(["method": method, "provider": provider.rawValue]) { _, new in new })
            switch method {
            case "connect", "models", "cached":
                let result = try JSONDecoder().decode(ModelResult.self, from: data)
                states[provider]?.models = result.models
                states[provider]?.fetchedAt = result.fetchedAt
                states[provider]?.status = result.source == "api" ? "연결 확인됨 · Models API" : (result.source == "cache" ? "저장된 목록 · 재확인 필요" : "연결 전")
                if !result.models.contains(where: { $0.id == states[provider]?.selectedModel }) {
                    states[provider]?.selectedModel = result.models.first(where: { $0.capabilities.chat != "unsupported" })?.id
                }
            case "disconnect": states[provider] = ProviderState()
            case "chat":
                let result = try JSONDecoder().decode(ChatResult.self, from: data)
                states[provider]?.response = result.text
                states[provider]?.usage = "입력 \(result.usage.inputTokens.map(String.init) ?? "미확인") · 출력 \(result.usage.outputTokens.map(String.init) ?? "미확인") · 총 \(result.usage.totalTokens.map(String.init) ?? "미확인") 토큰"
            default: states[provider]?.detail = String(decoding: data, as: UTF8.self)
            }
        } catch {
            states[provider]?.error = error.localizedDescription
            if method == "connect" || method == "models" { states[provider]?.status = "연결 확인 실패" }
        }
    }
}
