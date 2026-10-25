import XCTest
@testable import NidusNativeApp

final class ProviderExpansionTests: XCTestCase {
    func testProviderMetadataAndConditionalAccountID() {
        XCTAssertEqual(Provider.allCases.count, 8)
        XCTAssertEqual(Provider.allCases.filter(\.requiresAccountID), [.cloudflare])
        for p in Provider.allCases { XCTAssertEqual(p.keyURL.scheme, "https"); XCTAssertFalse(p.name.isEmpty) }
        XCTAssertNil(Provider(rawValue: "openrouter"))
    }
    @MainActor func testCloudflareConnectionAndPlanUseSharedTransport() async throws {
        var requests: [[String: Any]] = []
        let dashboard = Dashboard { request in
            requests.append(request)
            return Data((request["method"] as? String == "ping" ? "{}" : #"{"source":"api","fetchedAt":"2026-10-25","models":[]}"#).utf8)
        }
        await dashboard.start()
        await dashboard.operation("connect", .cloudflare, extra: ["key":"synthetic", "accountId":String(repeating:"a",count:32)])
        XCTAssertEqual(requests.last?["accountId"] as? String, String(repeating:"a",count:32))
        XCTAssertEqual(requests.last?["provider"] as? String, "cloudflare")
        XCTAssertNotNil(dashboard.states[.cloudflare]?.fetchedAt)
        let settings = RoutingSettingsModel { input in
            requests.append(input)
            return Data(#"{"allowPaid":false,"policies":{},"models":[],"providerPlans":[{"provider":"cloudflare","state":"free","checkedAt":"2026-10-25","source":"https://developers.cloudflare.com/","conditions":"Neurons remaining unknown"}]}"#.utf8)
        }
        await settings.perform(["method":"provider-plan-set", "provider":"cloudflare", "state":"free", "confirmed":true, "riskAccepted":true])
        XCTAssertEqual(settings.snapshot?.providerPlans?.first?.state,"free")
        XCTAssertEqual(settings.snapshot?.allowPaid,false)
    }
    @MainActor func testNvidiaFreeSetupSendsOnlyExplicitSelectionAndConsent() async {
        var sent: [String: Any] = [:]
        let settings = RoutingSettingsModel { input in
            sent = input
            return Data(#"{"allowPaid":false,"policies":{},"models":[]}"#.utf8)
        }
        let selected = ["nvidia/nemotron-3-ultra-550b-a55b"]
        await settings.perform(["method":"nvidia-free-setup", "models":selected, "confirmed":true, "riskAccepted":true])
        XCTAssertEqual(sent["method"] as? String,"nvidia-free-setup")
        XCTAssertEqual(sent["models"] as? [String],selected)
        XCTAssertEqual(sent["confirmed"] as? Bool,true)
        XCTAssertEqual(settings.snapshot?.allowPaid,false)
    }
}
