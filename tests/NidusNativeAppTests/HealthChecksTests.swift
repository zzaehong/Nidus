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
    func testLegacyStopHintDoesNotBlockSameOrOtherProviders() async throws {
        var calls: [String] = []
        let dashboard = Dashboard { request in
            calls.append(request["model"] as! String)
            return try self.response(request, status: request["provider"] as? String == "gemini" ? "failed" : "passed", stop: request["provider"] as? String == "gemini")
        }
        dashboard.ready = true
        dashboard.states[.gemini]?.models = [try model("a"), try model("b")]
        dashboard.states[.openai]?.models = [try model("c")]
        await dashboard.runHealthChecks(providers: [.gemini, .openai], allowInferred: false, limit: 20, confirmed: true, pause: {})
        XCTAssertEqual(calls, ["a", "b", "c"])
        XCTAssertEqual(dashboard.healthRows.map(\.status), [.failed, .failed, .passed])
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
    func testTransportFailureContinuesAndKeyChangesInvalidateResults() async throws {
        var calls = 0
        let dashboard = Dashboard { _ in calls += 1; throw DashboardError(message: "Mock transport failed") }
        dashboard.ready = true; dashboard.states[.gemini]?.models = [try model("a"), try model("b")]
        await dashboard.runHealthChecks(providers: [.gemini], allowInferred: false, limit: 20, confirmed: true, pause: {})
        XCTAssertEqual(calls, 2); XCTAssertEqual(dashboard.healthRows.map(\.status), [.failed, .failed])
        await dashboard.operation("connect", .gemini, extra: ["key": "synthetic"])
        XCTAssertTrue(dashboard.healthRows.isEmpty)
    }

    func testFirst429StillChecksAll24EligibleModelsOutOf60() async throws {
        var calls: [String] = [], pauses = 0
        let dashboard = Dashboard { request in
            calls.append(request["model"] as! String)
            if calls.count == 1 {
                return try JSONSerialization.data(withJSONObject: [
                    "model": request["model"] as! String, "status": "failed", "reason": "Probe failed",
                    "checkedAt": "2026-10-24T00:00:00Z", "durationMs": 5, "stopProvider": false,
                    "error": ["code": "rate_limit", "message": "Provider request failed (HTTP 429, rate_limit)."]])
            }
            return try self.response(request)
        }
        dashboard.ready = true
        dashboard.states[.gemini]?.models = try (0..<24).map { try model(String(format: "text-%02d", $0)) }
            + (0..<36).map { try model("video-\($0)", kind: "video", probe: "unsupported") }
        await dashboard.runHealthChecks(providers: [.gemini], allowInferred: false, limit: 24, confirmed: true, pause: { pauses += 1 })
        XCTAssertEqual(calls.count, 24); XCTAssertEqual(Set(calls).count, 24); XCTAssertEqual(pauses, 23)
        XCTAssertEqual(dashboard.healthRows.filter { $0.status == .passed }.count, 23)
        XCTAssertEqual(dashboard.healthRows.filter { $0.status == .failed }.count, 1)
        XCTAssertEqual(dashboard.healthRows.filter { $0.status == .skipped }.count, 36)
        XCTAssertTrue(dashboard.healthRows[0].reason.contains("[rate_limit]"))
        XCTAssertFalse(dashboard.healthRunning)
    }

    func testMalformedResponseDoesNotSkipNextModel() async throws {
        var calls = 0
        let dashboard = Dashboard { request in
            calls += 1
            return calls == 1 ? Data("{}".utf8) : try self.response(request)
        }
        dashboard.ready = true
        dashboard.states[.gemini]?.models = [try model("a"), try model("b")]
        await dashboard.runHealthChecks(providers: [.gemini], allowInferred: false, limit: 20, confirmed: true, pause: {})
        XCTAssertEqual(calls, 2)
        XCTAssertEqual(dashboard.healthRows.map(\.status), [.failed, .passed])
    }

    func temporaryStore() -> HealthResultStore {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
        return HealthResultStore(url: directory.appendingPathComponent("health.json"))
    }

    func testRestartKeepsSuccessAndFailureAndOnlyUntestedDoesNotSpendLimitOnHistory() async throws {
        let store = temporaryStore()
        let first = Dashboard(healthStore: store) { request in
            try self.response(request, status: request["model"] as? String == "a" ? "failed" : "passed")
        }
        first.ready = true
        first.states[.gemini]?.models = [try model("a"), try model("b"), try model("c")]
        await first.runHealthChecks(providers: [.gemini], allowInferred: false, limit: 2, confirmed: true, pause: {})
        XCTAssertEqual(try store.load().count, 2)
        var calls: [String] = []
        let second = Dashboard(healthStore: store) { request in
            calls.append(request["model"] as! String)
            return try self.response(request)
        }
        XCTAssertEqual(second.healthHistory["gemini:a"]?.status, .failed)
        XCTAssertEqual(second.healthHistory["gemini:b"]?.inputTokens, 2)
        second.ready = true; second.states[.gemini]?.models = first.states[.gemini]?.models ?? []
        let plan = second.healthPlan(providers: [.gemini], allowInferred: false, limit: 1, onlyUntested: true)
        XCTAssertEqual(plan.map(\.status), [.failed, .passed, .queued])
        await second.runHealthChecks(providers: [.gemini], allowInferred: false, limit: 1, confirmed: true, onlyUntested: true, pause: {})
        XCTAssertEqual(calls, ["c"]); XCTAssertEqual(try store.load().count, 3)
        await second.runHealthChecks(providers: [.gemini], allowInferred: false, limit: 20, confirmed: true, onlyUntested: true, pause: {})
        XCTAssertEqual(calls, ["c"], "Already checked models must not cause another paid request")
        await second.runHealthChecks(providers: [.gemini], allowInferred: false, limit: 1, confirmed: true, onlyUntested: false, pause: {})
        XCTAssertEqual(calls, ["c", "a"])
        XCTAssertEqual(Dashboard(healthStore: store).healthHistory["gemini:a"]?.status, .passed)
        let permissions = try FileManager.default.attributesOfItem(atPath: store.url.path)[.posixPermissions] as? Int
        XCTAssertEqual(permissions, 0o600)
    }

    func testCompletedResultsSavedBeforeNextRequestAndCancelledModelsRemainUntested() async throws {
        let store = temporaryStore()
        let dashboard = Dashboard(healthStore: store) { request in try self.response(request) }
        dashboard.ready = true
        dashboard.states[.gemini]?.models = [try model("a"), try model("b")]
        await dashboard.runHealthChecks(providers: [.gemini], allowInferred: false, limit: 20, confirmed: true, pause: {
            XCTAssertEqual(try? store.load().map(\.model), ["a"])
            dashboard.stopHealthChecks()
        })
        let restored = Dashboard(healthStore: store)
        restored.states[.gemini]?.models = dashboard.states[.gemini]?.models ?? []
        XCTAssertEqual(restored.healthPlan(providers: [.gemini], allowInferred: false, limit: 20, onlyUntested: true).map(\.status), [.passed, .queued])
    }

    func testRefreshPreservesHistoryAndCredentialMutationInvalidatesOnlyProvider() async throws {
        let store = temporaryStore()
        let dashboard = Dashboard(healthStore: store) { request in
            if request["method"] as? String == "probe" { return try self.response(request) }
            return Data(#"{"source":"api","models":[]}"#.utf8)
        }
        dashboard.ready = true
        dashboard.states[.gemini]?.models = [try model("a")]
        dashboard.states[.deepseek]?.models = [try model("a")]
        await dashboard.runHealthChecks(providers: [.gemini, .deepseek], allowInferred: false, limit: 20, confirmed: true, pause: {})
        await dashboard.operation("models", .gemini)
        XCTAssertEqual(try store.load().count, 2)
        await dashboard.operation("connect", .gemini, extra: ["key": "synthetic-secret"])
        XCTAssertEqual(try store.load().map(\.provider), [.deepseek])
        XCTAssertFalse(try String(contentsOf: store.url, encoding: .utf8).contains("synthetic-secret"))
        await dashboard.operation("disconnect", .deepseek)
        XCTAssertTrue(try store.load().isEmpty)
    }

    func testCorruptHistoryIsNotOverwrittenAndSaveFailureIsVisible() async throws {
        let store = temporaryStore()
        try FileManager.default.createDirectory(at: store.url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data("broken".utf8).write(to: store.url)
        let corrupt = Dashboard(healthStore: store)
        XCTAssertNotNil(corrupt.healthStorageError)
        XCTAssertThrowsError(try corrupt.persistHealthResults())
        XCTAssertEqual(try String(contentsOf: store.url, encoding: .utf8), "broken")

        let directoryTarget = HealthResultStore(url: store.url.deletingLastPathComponent())
        let dashboard = Dashboard { request in try self.response(request) }
        dashboard.ready = true; dashboard.states[.gemini]?.models = [try model("a")]
        await dashboard.runHealthChecks(providers: [.gemini], allowInferred: false, limit: 1, confirmed: true, pause: {})
        XCTAssertThrowsError(try directoryTarget.save(Array(dashboard.healthHistory.values)))
        let failing = Dashboard(healthStore: directoryTarget)
        failing.healthStoreLoaded = true // Simulate a destination becoming unwritable after loading.
        XCTAssertThrowsError(try failing.persistHealthResults())
        XCTAssertNotNil(failing.healthStorageError)
    }
}
