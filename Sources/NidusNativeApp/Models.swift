import Foundation

enum Provider: String, CaseIterable, Identifiable, Codable {
    case openai, anthropic, gemini, deepseek, nvidia, groq, mistral, cloudflare
    var id: String { rawValue }
    var name: String {
        switch self { case .openai: return "OpenAI · GPT"; case .anthropic: return "Anthropic · Claude"; case .gemini: return "Google Gemini"; case .deepseek: return "DeepSeek"; case .nvidia: return "NVIDIA NIM"; case .groq: return "Groq"; case .mistral: return "Mistral AI"; case .cloudflare: return "Cloudflare Workers AI" }
    }
    var symbol: String {
        switch self { case .openai: return "sparkles"; case .anthropic: return "sun.max"; case .gemini: return "diamond"; case .deepseek: return "water.waves"; case .nvidia: return "cpu"; case .groq: return "bolt"; case .mistral: return "wind"; case .cloudflare: return "cloud" }
    }
    var requiresAccountID: Bool { self == .cloudflare }
    var keyURL: URL {
        let links: [Provider: String] = [.openai:"https://platform.openai.com/api-keys", .anthropic:"https://platform.claude.com/settings/keys", .gemini:"https://aistudio.google.com/api-keys", .deepseek:"https://platform.deepseek.com/api_keys", .nvidia:"https://build.nvidia.com/", .groq:"https://console.groq.com/keys", .mistral:"https://console.mistral.ai/", .cloudflare:"https://dash.cloudflare.com/"]
        return URL(string: links[self]!)!
    }

}
struct APIModel: Decodable, Identifiable {
    let id: String
    let name: String
    let capabilities: Capabilities
    let pricing: Price
    let classification: ModelClassification?
    var usableForTextChat: Bool {
        guard capabilities.chat != "unsupported", classification?.kind == "text",
              ["supported", "opt_in"].contains(classification?.textProbe ?? "unsupported") else { return false }
        return !id.localizedCaseInsensitiveContains("computer-use")
    }
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
struct ModelResult: Decodable { let authentication: String?; let source: String; let fetchedAt: String?; let models: [APIModel] }
struct ChatResult: Decodable {
    let provider: Provider?
    let model: String?
    let routing: RoutingResult?
    let text: String
    let usage: Usage
    struct Usage: Decodable { let inputTokens: Int?; let outputTokens: Int?; let totalTokens: Int? }
}
struct RoutingResult: Codable {
    let tier: Int?
    let difficulty: String
    let reason: String
    let boundUSD: String?
    let estimatedUSD: String?
    let budgetLevel: String?
    let transitions: [Transition]
    struct Transition: Codable {
        let tier: Int?
        let provider: String
        let model: String
        let reason: String
        let status: String
        let budget: String
    }
    var summary: String {
        transitions.map { "\($0.provider)/\($0.model): \($0.reason) · \($0.status)" }.joined(separator: " → ")
    }
}
struct RoutePlanResult: Decodable {
    let candidates: [Candidate]
    let budget: Budget
    let excluded: [Excluded]
    struct Candidate: Decodable {
        let tier: Int?
        let model: SelectedModel
        let quote: Quote
        let reason: String
    }
    struct SelectedModel: Decodable { let provider: String; let id: String }
    struct Quote: Decodable { let boundUSD: String? }
    struct Budget: Decodable { let level: String; let remainingUSD: String? }
    struct Excluded: Decodable { let reason: String }
    var summary: String {
        guard let first = candidates.first else { return "자동 후보 없음: " + Array(Set(excluded.map(\.reason))).sorted().joined(separator: ", ") }
        return "예상 Tier \(first.tier.map(String.init) ?? "미확인"): \(first.model.provider)/\(first.model.id) · 참고 비용 상한 $\(first.quote.boundUSD ?? "미확인") · 지출 제한 없음"
    }
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
    let healthStore: HealthResultStore?
    var healthStoreLoaded = true
    init(healthStore: HealthResultStore? = nil, transport: @escaping Transport = { try await Runtime.shared.call($0) }) {
        self.transport = transport
        self.healthStore = healthStore
        do {
            let rows = try healthStore?.load() ?? []
            healthHistory = Dictionary(uniqueKeysWithValues: rows.map { ($0.id, $0) })
            healthRows = rows
        } catch {
            healthStoreLoaded = false
            healthStorageError = "검사 기록을 읽지 못했습니다. 기존 파일은 보존됩니다. 저장 파일을 확인한 뒤 앱을 다시 실행해주세요."
        }
    }
    @Published var states = Dictionary(uniqueKeysWithValues: Provider.allCases.map { ($0, ProviderState()) })
    @Published var ready = false
    @Published var runtimeError: String?
    @Published var healthRows: [HealthRow] = []
    @Published var healthHistory: [String: HealthRow] = [:]
    @Published var healthStorageError: String?
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
        states[provider]?.busy = true; states[provider]?.error = nil
        defer { states[provider]?.busy = false }
        do {
            // Invalidate before any credential mutation, including an uncertain transport outcome.
            if ["connect", "disconnect"].contains(method) { try clearHealthResults(provider) }
            let request = extra.merging(["method": method, "provider": provider.rawValue]) { _, new in new }
            let data = try await (["chat","probe"].contains(method) ? manualCall(request) : transport(request))
            switch method {
            case "connect", "models", "cached":
                let result = try JSONDecoder().decode(ModelResult.self, from: data)
                states[provider]?.models = result.models
                states[provider]?.fetchedAt = result.fetchedAt
                states[provider]?.status = result.authentication == "catalog-access-only" ? "카탈로그 조회됨 · 키 실행 권한 미확인" : result.source == "api" ? "연결 확인됨 · Models API" : (result.source == "cache" ? "저장된 목록 · 재확인 필요" : "연결 전")
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
