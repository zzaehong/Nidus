import XCTest
@testable import NidusNativeApp

@MainActor final class HealthChecksTests: XCTestCase {
    func model(_ id: String, kind: String = "text", probe: String = "supported") throws -> APIModel {
        let object: [String: Any] = ["id": id, "name": id,
            "capabilities": ["chat": "unknown", "streaming": "unknown", "vision": "unknown", "tools": "unknown"],
            "pricing": ["status": "unknown", "sourceUrl": "https://example.invalid", "rates": []],
            "classification": ["kind": kind, "confidence": probe == "supported" ? "metadata" : "inferred", "reason": "Fixture", "textProbe": probe]]
        return try JSONDecoder().decode(APIModel.self, from: JSONSerialization.data(withJSONObject: object))
    }
    func response(_ request: [String: Any], status: String = "passed", stop: Bool = false) throws -> Data {
        try JSONSerialization.data(withJSONObject: ["model": request["model"] as! String, "status": status,
            "reason": "Mock", "checkedAt": "2026-10-24T00:00:00Z", "durationMs": 5, "stopProvider": stop,
            "usage": ["inputTokens": 2, "outputTokens": 1, "totalTokens": 3]])
    }
    func testPlanClassificationConsentLimitAndDeduplication() throws {
        let dashboard = Dashboard()
        dashboard.states[.gemini]?.models = [try model("a"), try model("a"), try model("b"), try model("c", probe: "opt_in"), try model("d", kind: "video", probe: "unsupported")]
        let plan = dashboard.healthPlan(providers: [.gemini, .gemini], allowInferred: false, limit: 1)
        XCTAssertEqual(plan.count, 4)
        XCTAssertEqual(plan.map(\.status), [.queued, .skipped, .skipped, .skipped])
        let expanded = dashboard.healthPlan(providers: [.gemini], allowInferred: true, limit: 500)
        XCTAssertEqual(expanded.map(\.status), [.queued, .queued, .queued, .skipped])
    }
    func testSerialRunPreservesUsageAndSkipsMedia() async throws {
        var calls: [String] = [], pauses = 0
        let dashboard = Dashboard { request in
            calls.append(request["model"] as! String)
            XCTAssertEqual(request["confirmed"] as? Bool, true)
            return try self.response(request)
        }
        dashboard.ready = true
        dashboard.states[.gemini]?.models = [try model("a"), try model("b", kind: "image", probe: "unsupported"), try model("c")]
        await dashboard.runHealthChecks(providers: [.gemini], allowInferred: false, limit: 20, confirmed: true, pause: { pauses += 1 })
        XCTAssertEqual(calls, ["a", "c"]); XCTAssertEqual(pauses, 1)
        XCTAssertEqual(dashboard.healthRows.map(\.status), [.passed, .skipped, .passed])
        XCTAssertEqual(dashboard.healthRows[0].inputTokens, 2); XCTAssertFalse(dashboard.healthRunning)
    }
    func testProviderBlockDoesNotBlockOtherProviders() async throws {
        var calls: [String] = []
        let dashboard = Dashboard { request in
            calls.append(request["model"] as! String)
            return try self.response(request, status: request["provider"] as? String == "gemini" ? "failed" : "passed", stop: request["provider"] as? String == "gemini")
        }
        dashboard.ready = true
        dashboard.states[.gemini]?.models = [try model("a"), try model("b")]
        dashboard.states[.openai]?.models = [try model("c")]
        await dashboard.runHealthChecks(providers: [.gemini, .openai], allowInferred: false, limit: 20, confirmed: true, pause: {})
        XCTAssertEqual(calls, ["a", "c"])
        XCTAssertEqual(dashboard.healthRows.map(\.status), [.failed, .skipped, .passed])
    }
    func testStopPreventsNextRequestAndConcurrentOperationsAreBlocked() async throws {
        var calls = 0
        let dashboard = Dashboard { request in calls += 1; return try self.response(request) }
        dashboard.ready = true
        dashboard.states[.gemini]?.models = [try model("a"), try model("b"), try model("c")]
        await dashboard.runHealthChecks(providers: [.gemini], allowInferred: false, limit: 20, confirmed: true, pause: {
            await dashboard.operation("disconnect", .gemini)
            dashboard.stopHealthChecks()
        })
        XCTAssertEqual(calls, 1)
        XCTAssertEqual(dashboard.healthRows.map(\.status), [.passed, .cancelled, .cancelled])
        XCTAssertEqual(dashboard.states[.gemini]?.models.count, 3)
    }
    func testConfirmationAndBusyGuardMakeNoRequests() async throws {
        var calls = 0
        let dashboard = Dashboard { request in calls += 1; return try self.response(request) }
        dashboard.ready = true; dashboard.states[.gemini]?.models = [try model("a")]
        await dashboard.runHealthChecks(providers: [.gemini], allowInferred: false, limit: 20, confirmed: false, pause: {})
        dashboard.states[.openai]?.busy = true
        await dashboard.runHealthChecks(providers: [.gemini], allowInferred: false, limit: 20, confirmed: true, pause: {})
        XCTAssertEqual(calls, 0)
    }
    func testTransportFailureStopsProviderAndKeyChangesInvalidateResults() async throws {
        var calls = 0
        let dashboard = Dashboard { _ in calls += 1; throw DashboardError(message: "Mock transport failed") }
        dashboard.ready = true; dashboard.states[.gemini]?.models = [try model("a"), try model("b")]
        await dashboard.runHealthChecks(providers: [.gemini], allowInferred: false, limit: 20, confirmed: true, pause: {})
        XCTAssertEqual(calls, 1); XCTAssertEqual(dashboard.healthRows.map(\.status), [.failed, .skipped])
        await dashboard.operation("connect", .gemini, extra: ["key": "synthetic"])
        XCTAssertTrue(dashboard.healthRows.isEmpty)
    }
}
