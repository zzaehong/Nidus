import XCTest
@testable import NidusNativeApp

final class AccountPermissionTests: XCTestCase {
    func testAccountDecodeDistinguishesUserDeclarationFromOfficialTerms() throws {
        let json = #"{"provider":"gemini","state":"free_only","paidAllowed":false,"accountId":"project","checkedAt":"2026-10-26","verification":"user-declared","source":"https://ai.google.dev/gemini-api/docs/billing","verificationNote":"Not connected","officialTerms":"Free and paid tiers","legacyHint":null}"#
        let value = try JSONDecoder().decode(AccountPermission.self, from: Data(json.utf8))
        XCTAssertEqual(value.label, "Free Only")
        XCTAssertEqual(value.verification, "user-declared")
        XCTAssertFalse(value.paidAllowed)
        XCTAssertEqual(billingLabel("hybrid"), "Hybrid")
        XCTAssertEqual(billingLabel("paid_only"), "Paid Only")
        XCTAssertTrue(billingLabel("unknown").contains("Unknown"))
    }
    @MainActor func testUnknownManualChatRequiresExplicitConsentAndPassesTokenOnlyToThatRequest() async throws {
        var calls: [[String:Any]] = []
        let dashboard = Dashboard { request in
            calls.append(request)
            if request["method"] as? String == "request-consent" { return Data(#"{"token":"one-shot"}"#.utf8) }
            if request["consentToken"] == nil { throw DashboardError(message: "Execution permission denied (account_unknown)") }
            return Data(#"{"text":"OK"}"#.utf8)
        }
        let request: [String:Any] = ["method":"chat","provider":"gemini","request":["model":"gemini-2.5-flash","messages":[]]]
        var confirmations = 0
        _ = try await dashboard.manualCall(request, confirm: { provider, model in
            confirmations += 1; XCTAssertEqual(provider, "gemini"); XCTAssertEqual(model, "gemini-2.5-flash"); return true
        })
        XCTAssertEqual(confirmations, 1)
        XCTAssertEqual(calls.count, 3)
        XCTAssertEqual(calls[1]["method"] as? String, "request-consent")
        XCTAssertEqual(calls[1]["riskAccepted"] as? Bool, true)
        XCTAssertEqual(calls[2]["consentToken"] as? String, "one-shot")
        XCTAssertNil(request["consentToken"])
    }
    @MainActor func testDecliningConsentDoesNotIssueTokenOrRetry() async {
        var calls = 0
        let dashboard = Dashboard { _ in calls += 1; throw DashboardError(message: "account_unknown") }
        do {
            _ = try await dashboard.manualCall(["method":"chat","provider":"gemini","request":["model":"m"]], confirm: { _,_ in false })
            XCTFail("Expected cancellation")
        } catch { XCTAssertEqual(calls, 1) }
    }
    @MainActor func testAutomaticAndPaidPermissionDenialsNeverOfferUnknownRequestConsent() async {
        for (method,message) in [("auto-chat","account_unknown"),("chat","provider_paid_not_approved")] {
            var confirmations = 0
            let dashboard = Dashboard { _ in throw DashboardError(message: message) }
            do { _ = try await dashboard.manualCall(["method":method,"provider":"gemini"], confirm: { _,_ in confirmations += 1; return true }); XCTFail("Expected denial") }
            catch { XCTAssertEqual(confirmations, 0) }
        }
    }
    @MainActor func testSingleProbeConsentUsesProbeScopeWithoutEnablingBatch() async throws {
        var calls: [[String:Any]] = []
        let dashboard = Dashboard { request in
            calls.append(request)
            if request["method"] as? String == "request-consent" { return Data(#"{"token":"probe-token"}"#.utf8) }
            if request["consentToken"] != nil { return Data(#"{"status":"passed"}"#.utf8) }
            return Data(#"{"model":"m","status":"skipped","reason":"permission","checkedAt":"now","durationMs":0,"stopProvider":false,"error":{"code":"execution_permission","message":"account_unknown"},"usage":null}"#.utf8)
        }
        _ = try await dashboard.manualCall(["method":"probe","provider":"gemini","model":"m"], confirm: { _,_ in true })
        XCTAssertEqual(calls[1]["task"] as? String, "probe")
        XCTAssertEqual(calls[2]["consentToken"] as? String, "probe-token")
    }
}
