import XCTest
@testable import NidusNativeApp

final class FreeUseAndDragTests: XCTestCase {
    func testDragReordersOnlyWithinSameDifficultyAndPreservesMembership() {
        XCTAssertEqual(reorderedTiers([1, 2, 3], difficulty: "simple", payloads: ["nidus-tier:simple:1"], target: 3), [2, 3, 1])
        XCTAssertEqual(reorderedTiers([3, 2, 1], difficulty: "complex", payloads: ["nidus-tier:complex:1"], target: 3), [1, 3, 2])
        XCTAssertNil(reorderedTiers([1, 2], difficulty: "normal", payloads: ["nidus-tier:simple:1"], target: 2))
        XCTAssertNil(reorderedTiers([1, 2], difficulty: "normal", payloads: ["nidus-tier:normal:3"], target: 2))
        XCTAssertNil(reorderedTiers([1, 2], difficulty: "normal", payloads: ["unrelated text"], target: 2))
        XCTAssertNil(reorderedTiers([1, 2], difficulty: "normal", payloads: ["nidus-tier:normal:1"], target: 1))
        XCTAssertNil(reorderedTiers([1, 2], difficulty: "normal", payloads: ["nidus-tier:normal:1", "nidus-tier:normal:2"], target: 2))
    }
    @MainActor func testDroppedOrderAndScopedRiskConsentUseCommonBridgeAndDoNotOptimisticallySave() async throws {
        let raw = #"{"allowPaid":false,"policies":{"simple":[1,2],"normal":[2,1],"complex":[3,2]},"models":[]}"#
        var calls: [[String: Any]] = []
        var fail = false
        let model = RoutingSettingsModel { input in
            calls.append(input)
            if fail { throw DashboardError(message: "Storage failure") }
            return Data(raw.utf8)
        }
        await model.perform()
        let reordered = try XCTUnwrap(reorderedTiers([1, 2], difficulty: "simple", payloads: ["nidus-tier:simple:1"], target: 2))
        fail = true
        await model.policy("simple", reordered)
        XCTAssertEqual(calls[1]["tiers"] as? [Int], [2, 1])
        XCTAssertEqual(model.snapshot?.policies["simple"], [1, 2])
        XCTAssertEqual(model.error, "Storage failure")
        fail = false
        await model.perform(["method": "free-use-set", "provider": "gemini", "model": "gemini-2.5-flash", "status": "unverified", "approved": true, "accountConfirmed": false, "chargeRiskAccepted": true])
        XCTAssertEqual(calls[2]["chargeRiskAccepted"] as? Bool, true)
        XCTAssertEqual(calls[2]["status"] as? String, "unverified")
        XCTAssertFalse(model.snapshot!.allowPaid)
    }
    func testUserAttestationAndUnknownQuotaAreDisplayedWithoutClaimingProviderVerification() throws {
        let raw = #"{"status":"verified","approved":true,"checkedAt":"2026-10-25T00:00:00Z","source":"https://ai.google.dev/gemini-api/docs/pricing","conditions":"Quota not synchronized; paid bounds apply","verification":"user-account-attestation"}"#
        let result = try JSONDecoder().decode(RoutingSettingsSnapshot.TierModel.FreeUse.self, from: Data(raw.utf8))
        XCTAssertEqual(result.verification, "user-account-attestation")
        XCTAssertEqual(result.status, "verified")
        XCTAssertTrue(result.conditions.contains("paid bounds"))
        XCTAssertNotNil(result.checkedAt)
    }
}
