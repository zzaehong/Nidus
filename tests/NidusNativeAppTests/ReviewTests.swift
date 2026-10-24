import XCTest
@testable import NidusNativeApp

@MainActor final class ReviewTests: XCTestCase {
    func model(_ id: String, estimate: Double? = 0.01, kind: String = "text") throws -> APIModel {
        var object: [String: Any] = ["id": id, "name": id,
            "capabilities": ["chat": "unknown", "streaming": "unknown", "tools": "unknown", "vision": "unknown"],
            "classification": ["kind": kind, "confidence": "inferred", "reason": "Mock", "textProbe": kind == "text" ? "opt_in" : "unsupported"],
            "pricing": ["status": "unknown", "sourceUrl": "https://example.invalid", "rates": []]]
        if let estimate { object["probeEstimate"] = ["usd": estimate] }
        return try JSONDecoder().decode(APIModel.self, from: JSONSerialization.data(withJSONObject: object))
    }
    func response(_ request: [String: Any], cost: Double? = 0.002) throws -> Data {
        var object: [String: Any] = ["model": request["model"]!, "status": "passed", "reason": "Mock",
            "checkedAt": "2026-10-24T00:00:00Z", "durationMs": 1, "stopProvider": false,
            "usage": ["inputTokens": 3, "outputTokens": 2, "totalTokens": 5]]
        if let cost { object["estimatedUsageUSD"] = cost; object["reservedUSD"] = max(cost, 0.01) }
        return try JSONSerialization.data(withJSONObject: object)
    }
    func testBudgetStopsBeforeNextRequestAndPersistsLedger() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = HealthResultStore(url: directory.appendingPathComponent("health.json"))
        var calls = 0
        let dashboard = Dashboard(healthStore: store) { request in
            calls += 1
            // The persisted in-flight request must remain unknown if the app crashes now.
            XCTAssertEqual(try store.loadBatches().last?.unknownCostRequests, 1)
            XCTAssertEqual(try store.loadBatches().last?.reservedUSD, 0.01)
            return try self.response(request)
        }
        dashboard.ready = true; dashboard.states[.openai]?.models = [try model("a"), try model("b")]
        await dashboard.runHealthChecks(providers: [.openai], allowInferred: true, limit: 20, confirmed: true, budgetUSD: 0.015, pause: {})
        XCTAssertEqual(calls, 1)
        XCTAssertEqual(dashboard.healthRows.map(\.status), [.passed, .cancelled])
        let restored = Dashboard(healthStore: store)
        XCTAssertEqual(restored.healthBatches.last?.reservedUSD, 0.01)
        XCTAssertEqual(restored.healthBatches.last?.estimatedUsageUSD, 0.002)
        XCTAssertEqual(restored.healthBatches.last?.inputTokens, 3)
        XCTAssertEqual(restored.healthHistory["openai:a"]?.estimatedUsageUSD, 0.002)
    }
    func testUnknownPriceRequiresSeparateConsentAndStopsAfterOne() async throws {
        var calls = 0
        let dashboard = Dashboard { request in calls += 1; XCTAssertEqual(request["allowUnknownPrice"] as? Bool, true); return try self.response(request, cost: nil) }
        dashboard.ready = true; dashboard.states[.openai]?.models = [try model("a", estimate: nil), try model("b", estimate: nil)]
        await dashboard.runHealthChecks(providers: [.openai], allowInferred: true, limit: 20, confirmed: true, pause: {})
        XCTAssertEqual(calls, 0); XCTAssertTrue(dashboard.healthRows.allSatisfy { $0.status == .skipped && $0.estimatedMaxUSD == nil })
        await dashboard.runHealthChecks(providers: [.openai], allowInferred: true, limit: 20, confirmed: true, budgetUSD: 0.5, allowUnknownPrice: true, pause: {})
        XCTAssertEqual(calls, 1); XCTAssertEqual(dashboard.healthBatches.last?.reservedUSD, 0.5)
        XCTAssertEqual(dashboard.healthBatches.last?.unknownCostRequests, 1)
        XCTAssertEqual(dashboard.healthRows.map(\.status), [.passed, .cancelled])
    }
    func testUnexpectedHigherUsageAndTransportFailureKeepReservation() async throws {
        var calls = 0
        let dashboard = Dashboard { request in calls += 1; return try self.response(request, cost: 0.04) }
        dashboard.ready = true; dashboard.states[.openai]?.models = [try model("a"), try model("b")]
        await dashboard.runHealthChecks(providers: [.openai], allowInferred: true, limit: 20, confirmed: true, budgetUSD: 0.03, pause: {})
        XCTAssertEqual(calls, 1); XCTAssertEqual(dashboard.healthBatches.last?.reservedUSD, 0.04)
        let failed = Dashboard { _ in throw DashboardError(message: "Mock") }
        failed.ready = true; failed.states[.openai]?.models = [try model("a"), try model("b")]
        await failed.runHealthChecks(providers: [.openai], allowInferred: true, limit: 20, confirmed: true, budgetUSD: 0.015, pause: {})
        XCTAssertEqual(failed.healthRows.map(\.status), [.failed, .cancelled])
        XCTAssertEqual(failed.healthBatches.last?.unknownCostRequests, 1)
    }
    func testInvalidBudgetsNeverDispatch() async throws {
        let dashboard = Dashboard { _ in XCTFail("must not send"); return Data() }
        dashboard.ready = true; dashboard.states[.openai]?.models = [try model("a")]
        for budget in [0.0, -1, Double.infinity, Double.nan] {
            await dashboard.runHealthChecks(providers: [.openai], allowInferred: true, limit: 1, confirmed: true, budgetUSD: budget, pause: {})
        }
        XCTAssertTrue(dashboard.healthBatches.isEmpty)
    }
    func testChatValidationStatesAndTargetedRetest() throws {
        let text = try model("a")
        var row = HealthRow(provider: .openai, model: "a", kind: "text", status: .passed, reason: "Mock")
        XCTAssertEqual(ChatValidation.status(model: text, result: nil), .untested)
        XCTAssertTrue(ChatValidation.untested.requiresConsent(acknowledged: false))
        XCTAssertTrue(ChatValidation.failed.requiresConsent(acknowledged: false))
        XCTAssertFalse(ChatValidation.untested.requiresConsent(acknowledged: true))
        XCTAssertFalse(ChatValidation.verified.requiresConsent(acknowledged: false))
        XCTAssertEqual(ChatValidation.status(model: text, result: row), .verified)
        row.status = .failed; row.reason = "[rate_limit]"
        XCTAssertEqual(ChatValidation.status(model: text, result: row), .failed)
        XCTAssertEqual(ChatValidation.status(model: try model("image", kind: "image"), result: row), .unsupported)
        let dashboard = Dashboard(); dashboard.states[.openai]?.models = [text, try model("b")]
        dashboard.healthHistory[row.id] = row
        let plan = dashboard.healthPlan(providers: [.openai], allowInferred: true, limit: 20, modelIDs: ["a"])
        XCTAssertEqual(plan.count, 1); XCTAssertEqual(plan[0].status, .queued)
    }
    func testLongConversationRetainedWithoutDeletingFailedHistory() {
        let messages = (0..<150).map { ChatMessage(role: "user", content: "message \($0)", failed: $0 == 10) }
        let prepared = conversationMessages(messages)
        XCTAssertEqual(prepared.count, 149); XCTAssertEqual(prepared.first?["content"], "message 0")
        XCTAssertEqual(messages.count, 150); XCTAssertTrue(messages[10].failed)
    }
}
