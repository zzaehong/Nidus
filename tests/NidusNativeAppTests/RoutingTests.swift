import XCTest
@testable import NidusNativeApp

final class RoutingTests: XCTestCase {
    func testLegacyRoomKeepsManualModeAndNormalDefaultWithoutRewritingHistory() throws {
        let room = ChatRoom(provider: .openai, model: "gpt-4.1-mini")
        let data = try JSONEncoder().encode(room)
        let decoded = try JSONDecoder().decode(ChatRoom.self, from: data)
        XCTAssertFalse(decoded.automaticRouting ?? false)
        XCTAssertEqual(decoded.difficulty ?? "normal", "normal")
        XCTAssertEqual(decoded.model, room.model)
        var automatic = decoded
        automatic.automaticRouting = true
        automatic.difficulty = "complex"
        let restored = try JSONDecoder().decode(ChatRoom.self, from: JSONEncoder().encode(automatic))
        XCTAssertEqual(restored.automaticRouting, true)
        XCTAssertEqual(restored.difficulty, "complex")
    }
    func testActualSelectedModelAndFallbackReasonDecodeAndPersist() throws {
        let json = #"{"provider":"gemini","model":"gemini-2.5-flash","text":"OK","usage":{"inputTokens":10,"outputTokens":2},"routing":{"difficulty":"normal","reason":"normal:general","boundUSD":"0.478412800","estimatedUSD":"0.000008000","budgetLevel":"warning","transitions":[{"provider":"openai","model":"gpt-4.1-mini","reason":"rate_limit","status":"failed","budget":"allowed"},{"provider":"gemini","model":"gemini-2.5-flash","reason":"rate_limit","status":"succeeded","budget":"allowed"}]}}"#
        let result = try JSONDecoder().decode(ChatResult.self, from: Data(json.utf8))
        XCTAssertEqual(result.provider, .gemini)
        XCTAssertEqual(result.model, "gemini-2.5-flash")
        XCTAssertTrue(result.routing!.summary.contains("rate_limit"))
        XCTAssertEqual(result.routing?.estimatedUSD, "0.000008000")
        var message = ChatMessage(role: "assistant", content: result.text, provider: result.provider, model: result.model)
        message.routing = result.routing
        let restored = try JSONDecoder().decode(ChatMessage.self, from: JSONEncoder().encode(message))
        XCTAssertEqual(restored.routing?.budgetLevel, "warning")
    }
    func testPreviewShowsBlockedReasonOrConservativeBound() throws {
        let json = #"{"candidates":[],"budget":{"level":"blocked","remainingUSD":"0.000000000"},"excluded":[{"reason":"monthly_budget"}]}"#
        let result = try JSONDecoder().decode(RoutePlanResult.self, from: Data(json.utf8))
        XCTAssertTrue(result.summary.contains("monthly_budget"))
    }
}
