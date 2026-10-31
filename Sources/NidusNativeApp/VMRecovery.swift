import SwiftUI
import AppKit

struct VMRecoverySnapshot: Decodable {
    var runID: String
    var vaultID: String
    var detectedAt: String?
    var faultDetectedAt: String?
    var recoveryAttempts: [String]?
    var state: String
    var lastState: String?
    var reason: String
    var stopConfirmed: Bool
    var canStop: Bool
    var locked: Bool
    var bootChanged: Bool
    var integrityVerified: Bool
    var details: [String]
}

@MainActor final class VMRecoveryModel: ObservableObject {
    @Published var snapshot: VMRecoverySnapshot?
    @Published var error: String?
    @Published var busy = false
    @Published var registry: String
    private let call: (String,String) async throws -> Data
    init(registry: String = UserDefaults.standard.string(forKey:"M0RecoveryRegistry") ?? "",
         call: @escaping (String,String) async throws -> Data = VMRecoveryBridge.call) {
        self.registry=registry; self.call=call
    }
    var canStop: Bool { !busy && error == nil && snapshot?.canStop == true && snapshot?.stopConfirmed == false }
    var needsAttention: Bool { error != nil || snapshot?.state == "STOP_UNCONFIRMED" || snapshot?.state == "FAILED" || (snapshot?.stopConfirmed == true && snapshot?.locked == true) }
    func refresh() async { await perform("status") }
    func stop() async {
        guard canStop else { return }
        await perform("cancel")
    }
    private func perform(_ action: String) async {
        guard !busy, !registry.isEmpty else { return }
        busy=true; defer { busy=false }
        do {
            let data=try await call(registry,action)
            snapshot=try JSONDecoder().decode(VMRecoverySnapshot.self,from:data); error=nil
        } catch {
            self.error="복구 기록 또는 제어 채널을 확인할 수 없습니다. 실행·반영·정리 차단을 유지합니다."
        }
    }
}

enum VMRecoveryBridge {
    static func call(_ registry: String, _ action: String) async throws -> Data {
        try await Task.detached {
            let root=URL(fileURLWithPath:#filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            let candidates=[Bundle.main.resourceURL?.appendingPathComponent("m0/recovery.py"),root.appendingPathComponent("scripts/agent-vm/recovery.py")].compactMap{$0}
            guard let script=candidates.first(where:{ FileManager.default.fileExists(atPath:$0.path) }) else { throw DashboardError(message:"Recovery unavailable") }
            let process=Process(),output=Pipe()
            process.executableURL=URL(fileURLWithPath:"/usr/bin/python3")
            process.arguments=[script.path,registry,action]
            process.environment=["PATH":"/usr/bin:/bin:/usr/sbin","PYTHONDONTWRITEBYTECODE":"1"]
            process.standardOutput=output;process.standardError=FileHandle.nullDevice
            try process.run()
            // Only this bridge child is timed out; never locate or kill VM processes by PID.
            let watchdog=DispatchWorkItem { if process.isRunning { process.terminate() } }
            DispatchQueue.global().asyncAfter(deadline:.now()+10,execute:watchdog)
            defer { watchdog.cancel() }
            let data=output.fileHandleForReading.readDataToEndOfFile();process.waitUntilExit()
            guard process.terminationStatus==0, data.count<=65536 else { throw DashboardError(message:"Recovery unavailable") }
            return data
        }.value
    }
}

struct VMRecoveryView: View {
    @ObservedObject var model: VMRecoveryModel
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        VStack(alignment:.leading,spacing:16) {
            HStack { Text("M0 · VM 장애 및 복구").font(.title2.bold());Spacer();Button("닫기") { dismiss() } }
            ScrollView {
                VStack(alignment:.leading,spacing:14) {
                    Text("VM 종료 미확인 상태에서는 새 실행, 원본 Vault 반영, 임시 데이터 삭제를 차단합니다. 다른 Vault도 전역 실행 제한을 따릅니다.")
                    Button("M0 Registry 선택") {
                        let panel=NSOpenPanel();panel.canChooseDirectories=false;panel.allowsMultipleSelection=false
                        if panel.runModal() == .OK, let url=panel.url {
                            model.snapshot=nil;model.error=nil;model.registry=url.path;UserDefaults.standard.set(url.path,forKey:"M0RecoveryRegistry")
                            Task { await model.refresh() }
                        }
                    }
                    if let value=model.snapshot {
                        LabeledContent("Vault",value:value.vaultID)
                        LabeledContent("실행 ID",value:value.runID)
                        LabeledContent("장애 감지 시각",value:value.faultDetectedAt ?? "미감지 / 확인 불가")
                        LabeledContent("마지막 실행 기록 시각",value:value.detectedAt ?? "확인 불가")
                        LabeledContent("관리 상태",value:value.state)
                        LabeledContent("마지막 확인 상태",value:value.lastState ?? "확인 불가")
                        LabeledContent("종료 확인",value:value.stopConfirmed ? "확인됨" : "미확인")
                        LabeledContent("안전 제한",value:value.locked ? "실행·반영·정리 차단" : "종료 확인됨 — 작업 자동 재개 없음")
                        LabeledContent("원인",value:value.reason)
                        HStack {
                            Button("안전 종료 시도") { Task { await model.stop() } }.disabled(!model.canStop)
                            Button("다시 상태 확인") { Task { await model.refresh() } }.disabled(model.busy)
                        }
                        Text("안전 종료 시도는 정상 종료 요청 후 필요하면 강제 종료합니다. 저장하지 않은 VM 변경이 손실될 수 있습니다.").font(.caption).foregroundStyle(.secondary)
                        if !value.canStop { Text("기존 VM을 제어할 신뢰 가능한 채널이 없습니다. 임의의 PID나 다른 VM을 종료하지 않습니다.").foregroundStyle(.secondary) }
                        DisclosureGroup("상세 정보") {
                            VStack(alignment:.leading) {
                                ForEach(Array(value.details.enumerated()),id:\.offset) { _,event in Text(event).font(.caption.monospaced()) }
                                ForEach(value.recoveryAttempts ?? [],id:\.self) { time in Text("종료 시도: \(time)") }
                                Text("재부팅 변경 근거: \(value.bootChanged ? "있음" : "없음") · 파일 검증: \(value.integrityVerified ? "완료" : "미완료")")
                            }
                        }
                    } else { Text("등록된 M0 Registry를 선택하세요. 이 화면은 VM이나 Agent 작업을 새로 시작하지 않습니다.") }
                    if let error=model.error { Text(error).foregroundStyle(.red) }
                    Divider()
                    Text("수동 복구 안내").font(.headline)
                    Text("제어 채널이 없으면 Mac 재시작이 최후의 복구 방법입니다. 저장하지 않은 작업과 VM 내부 변경이 손실될 수 있으므로 다른 작업을 저장한 뒤 직접 결정하세요. Nidus는 재시작을 실행하지 않습니다.")
                    Text("앱 재실행만으로 잠금을 해제하지 않습니다. 호스트 부팅 변경 근거와 원본·작업 복사본의 무결성을 모두 확인해야 합니다. 기존 기록에 파일 목록과 해시가 없거나 변경이 발견되면 격리를 유지합니다.")
                }.frame(maxWidth:.infinity,alignment:.leading).fixedSize(horizontal:false,vertical:true)
            }
        }.padding(24).frame(minWidth:640,idealWidth:760,minHeight:560,idealHeight:720)
    }
}
