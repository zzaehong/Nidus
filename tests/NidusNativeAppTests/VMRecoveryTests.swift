import XCTest
import SwiftUI
@testable import NidusNativeApp

final class VMRecoveryTests: XCTestCase {
    func data(channel: Bool=false, confirmed: Bool=false) -> Data {
        Data("""
        {"runID":"fixture","vaultID":"vault","state":"\(confirmed ? "STOP_CONFIRMED" : "STOP_UNCONFIRMED")","reason":"fixture","stopConfirmed":\(confirmed),"canStop":\(channel),"locked":\(!confirmed),"bootChanged":false,"integrityVerified":false,"details":[]}
        """.utf8)
    }
    @MainActor func testNoChannelDisablesStopAndShowsAlertAfterReload() async {
        var calls=0
        let model=VMRecoveryModel(registry:"fixture") { _,_ in calls+=1;return self.data() }
        await model.refresh();XCTAssertTrue(model.needsAttention);XCTAssertFalse(model.canStop)
        await model.stop();XCTAssertEqual(calls,1)
        let reloaded=VMRecoveryModel(registry:"fixture") { _,_ in self.data() }
        await reloaded.refresh();XCTAssertTrue(reloaded.needsAttention)
        let view=NSHostingView(rootView:VMRecoveryView(model:reloaded))
        view.frame=NSRect(x:0,y:0,width:760,height:720)
        view.layoutSubtreeIfNeeded()
        XCTAssertGreaterThan(view.fittingSize.height,0)

    }
    @MainActor func testStopAcceptanceDoesNotMeanConfirmed() async {
        var calls:[String]=[]
        let model=VMRecoveryModel(registry:"fixture") { _,action in calls.append(action);return self.data(channel:action=="status") }
        await model.refresh();XCTAssertTrue(model.canStop)
        await model.stop();XCTAssertEqual(calls,["status","cancel"])
        XCTAssertFalse(model.snapshot!.stopConfirmed);XCTAssertTrue(model.needsAttention)
        await model.stop();XCTAssertEqual(calls.count,2)
    }
    @MainActor func testFailureKeepsControlsDisabled() async {
        let model=VMRecoveryModel(registry:"fixture") { _,_ in throw DashboardError(message:"SECRET must not appear") }
        await model.refresh();XCTAssertTrue(model.needsAttention);XCTAssertFalse(model.canStop)
        XCTAssertFalse(model.error!.contains("SECRET"))
    }
    @MainActor func testConfirmedStopNeedsNoAlert() async {
        let model=VMRecoveryModel(registry:"fixture") { _,_ in self.data(confirmed:true) }
        await model.refresh();XCTAssertFalse(model.canStop);XCTAssertFalse(model.needsAttention)
    }
}
