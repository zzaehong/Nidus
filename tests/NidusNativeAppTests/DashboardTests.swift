import XCTest
@testable import NidusNativeApp

final class DashboardTests: XCTestCase {
    func testExplicitRuntimeAndNodePaths() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let dist = root.appendingPathComponent("dist")
        try FileManager.default.createDirectory(at: dist, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        try "".write(to: dist.appendingPathComponent("dashboard.js"), atomically: true, encoding: .utf8)
        let helper = dist.appendingPathComponent("nidus-keychain")
        try "".write(to: helper, atomically: true, encoding: .utf8)
        XCTAssertThrowsError(try RuntimeLocation.resolve(environment: ["NIDUS_RUNTIME_ROOT": root.path, "NIDUS_NODE_PATH": "/bin/sh"]))
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: helper.path)
        let found = try RuntimeLocation.resolve(environment: ["NIDUS_RUNTIME_ROOT": root.path, "NIDUS_NODE_PATH": "/bin/sh", "PATH": ""])
        XCTAssertEqual(found.node.path, "/bin/sh")
        XCTAssertEqual(found.script.path, dist.appendingPathComponent("dashboard.js").path)
    }
    func fixture(_ script: String) throws -> (Runtime, URL) {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let file = directory.appendingPathComponent("test.sh")
        try script.write(to: file, atomically: true, encoding: .utf8)
        return (Runtime(locate: { RuntimeLocation(node: URL(fileURLWithPath: "/bin/sh"), script: file) }, deadline: 0.2), directory)
    }
    func testResponseAndStderrIsolation() async throws {
        let (runtime, directory) = try fixture("/bin/cat >/dev/null\necho 'debug output' >&2\necho '{\"result\":{\"ready\":true}}'")
        defer { runtime.shutdown(); try? FileManager.default.removeItem(at: directory) }
        let response = try await runtime.call(["method": "ping"])
        XCTAssertEqual((try JSONSerialization.jsonObject(with: response) as? [String: Bool])?["ready"], true)
    }
    func testExitAndMalformedResponseFail() async throws {
        for script in ["exit 7", "echo invalid", "echo '{\"error\":{\"code\":\"authentication\",\"message\":\"Invalid key\"}}'"] {
            let (runtime, directory) = try fixture(script)
            defer { runtime.shutdown(); try? FileManager.default.removeItem(at: directory) }
            do { _ = try await runtime.call([:]); XCTFail("Expected failure") } catch { XCTAssertFalse(error.localizedDescription.isEmpty) }
        }
    }
    func testTimeoutAndShutdownRejectFurtherRequests() async throws {
        let (runtime, directory) = try fixture("trap '' TERM\nwhile :; do :; done")
        defer { runtime.shutdown(); try? FileManager.default.removeItem(at: directory) }
        let start = Date()
        do { _ = try await runtime.call([:]); XCTFail("Expected timeout") } catch { }
        XCTAssertLessThan(Date().timeIntervalSince(start), 4)
        runtime.shutdown()
        do { _ = try await runtime.call([:]); XCTFail("Expected closed runtime") } catch { }
    }
    @MainActor func testConnectAutoPopulatesProviderWithoutCrossContamination() async throws {
        let modelJSON = #"{"source":"api","fetchedAt":"2026-10-23","models":[{"id":"discovered","name":"Discovered","capabilities":{"chat":"unknown","streaming":"unknown","tools":"unknown","vision":"unknown"},"pricing":{"status":"unknown","sourceUrl":"https://example.invalid","checkedAt":null,"rates":[]}}]}"#
        var calls: [String] = []
        let dashboard = Dashboard { request in
            let method = request["method"] as! String; calls.append(method)
            return Data((method == "ping" ? "{\"ready\":true}" : method == "cached" ? "{\"source\":\"empty\",\"fetchedAt\":null,\"models\":[]}" : modelJSON).utf8)
        }
        await dashboard.start()
        XCTAssertTrue(dashboard.ready); XCTAssertEqual(calls, ["ping", "cached", "cached", "cached", "cached"])
        await dashboard.operation("connect", .gemini, extra: ["key": "synthetic"])
        XCTAssertEqual(dashboard.states[.gemini]?.selectedModel, "discovered")
        XCTAssertEqual(dashboard.states[.gemini]?.models.count, 1)
        XCTAssertEqual(dashboard.states[.openai]?.models.count, 0)
        XCTAssertEqual(dashboard.states[.gemini]?.busy, false)
    }
    @MainActor func testFailedStartupDoesNotMarkReadyAndCanRetry() async {
        var fail = true
        let dashboard = Dashboard { request in
            if fail { throw DashboardError(message: "Missing runtime") }
            return Data((request["method"] as? String == "ping" ? "{}" : "{\"source\":\"empty\",\"fetchedAt\":null,\"models\":[]}").utf8)
        }
        await dashboard.start(); XCTAssertFalse(dashboard.ready); XCTAssertNotNil(dashboard.runtimeError)
        fail = false; await dashboard.start(); XCTAssertTrue(dashboard.ready)
        XCTAssertNil(dashboard.runtimeError)
    }
    @MainActor func testConnectionFailureIsVisibleAndClearsBusyState() async {
        let dashboard = Dashboard { _ in throw DashboardError(message: "[authentication] Invalid key") }
        dashboard.ready = true
        await dashboard.operation("connect", .anthropic, extra: ["key": "synthetic"])
        XCTAssertEqual(dashboard.states[.anthropic]?.status, "연결 확인 실패")
        XCTAssertEqual(dashboard.states[.anthropic]?.error, "[authentication] Invalid key")
        XCTAssertEqual(dashboard.states[.anthropic]?.busy, false)
        XCTAssertNil(dashboard.states[.gemini]?.error)
    }
}
