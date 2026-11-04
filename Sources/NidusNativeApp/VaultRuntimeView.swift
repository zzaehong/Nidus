import SwiftUI
import AppKit

struct VaultChoice: Identifiable { let id: String; let name: String; let environment: String }
struct VaultAgentModel: Decodable, Identifiable {
    let id: String; let provider: String; let model: String; let name: String; let available: Bool; let mode: String; let reason: String
    var label: String { "\(Provider(rawValue: provider)?.name ?? provider) · \(name) [\(model)]" }
}
struct ShellApproval: Identifiable { let id: String; let vault: String; let command: String; let hash: String; let expires: Double; let workspace: String }

@MainActor final class VaultRuntimeModel: ObservableObject {
    @Published var vaults: [VaultChoice] = []
    @Published var selected = ""
    @Published var cacheStatus = "캐시 상태 조회 전"
    @Published var status = "상태 조회 전"
    @Published var error: String?
    @Published var busy = false
    @Published var running = false
    @Published var events: [String] = []
    @Published var approval: ShellApproval?
    @Published var prompt = ""
    @Published var workspacePaths = ""
    @Published var shellCommand = "echo hello; pwd; id"
    @Published var model = ""
    @Published var requiresWeb = false
    @Published var browserAvailable = false
    @Published var browserInput = "https://example.com/"
    private let healthStore: HealthResultStore
    private var connectedModels: [VaultAgentModel] = []
    init(healthStore: HealthResultStore = .application) { self.healthStore = healthStore }
    func reloadHealth(autoSelect: Bool = true) throws {
        do {
            let passed = Set(try healthStore.load().filter { $0.status == .passed && $0.kind == "text" }.map(\.id))
            agentModels = connectedModels.filter { $0.available && passed.contains($0.id) }
            if selectedModel == nil { model = autoSelect ? (agentModels.first?.id ?? "") : "" }
        } catch { agentModels=[]; model=""; throw error }
    }
    @Published var agentModels: [VaultAgentModel] = []
    @Published var vmState = "UNKNOWN"
    @Published var vmOwner = "없음"
    @Published var vmInstance = "없음"
    @Published var activeSession = "없음"
    @Published var recentSessions: [String] = []
    @Published var lastChecked: Date?
    @Published var statusUnavailable = true
    @Published var queueCount = 0
    private var checkingStatus = false
    var selectedModel: VaultAgentModel? { agentModels.first { $0.id == model && $0.available } }
    var vmSummaryTitle: String {
        if statusUnavailable { return "VM 현황 · 현재 상태 확인 불가" }
        switch vmState {
        case "RUNNING", "STARTING", "STOPPING": return "VM 현황 · 활성 VM 1개 / 최대 1개"
        case "STOPPED", "STOP_CONFIRMED": return "VM 현황 · 활성 VM 없음"
        default: return "VM 현황 · 활성 수 미확인 / 새 실행 차단"
        }
    }
    var canStop: Bool { !statusUnavailable && vmState == "RUNNING" && activeSession == "없음" && queueCount == 0 && !running }
    func loadModels(_ data: Data) throws {
        connectedModels = try JSONDecoder().decode([VaultAgentModel].self, from: data)
        try reloadHealth()
    }
    func applyStatus(_ state: [String:Any]) {
        vmState = state["state"] as? String ?? "UNKNOWN"
        let owner = state["vaultId"] as? String
        vmOwner = owner.map { id in (vaults.first { $0.id == id }?.name ?? "등록 정보 없음") + " · " + id } ?? "없음"
        vmInstance = state["vmInstanceId"] as? String ?? "없음"
        activeSession = state["activeSession"] as? String ?? "없음"
        queueCount = state["queued"] as? Int ?? 0
        let labels = ["RUNNING":"실행 중", "STOPPED":"정지", "STARTING":"부팅 중", "STOPPING":"종료 확인 중", "STOP_CONFIRMED":"종료 확인됨", "STOP_UNCONFIRMED":"종료 미확인 — 재실행 차단"]
        status = "\(labels[vmState] ?? vmState) · Generation \(state["generation"] as? Int ?? 0) · 대기 \(queueCount)"
        if vmState == "RUNNING" { status += activeSession == "없음" ? " · 유휴 상태" : " · 작업 수행 중" }
        if let owner, owner != selected, vmState == "RUNNING" { status += "\n선택한 Vault와 실행 중인 VM의 Vault가 다릅니다." }
        recentSessions = ((state["sessions"] as? [[String:Any]]) ?? []).suffix(5).reversed().map { "\($0["state"] as? String ?? "UNKNOWN") · \($0["id"] as? String ?? "") · 정리 \(($0["cleanupConfirmed"] as? Bool == true) ? "확인" : "미확인")" }
        if state["statusSource"] as? String == "journal-unverified" { status += " · 서비스 미연결 / 기록 기반" }
        lastChecked = Date(); statusUnavailable = false
    }
    func pollStatus() async {
        guard !checkingStatus else { return }; checkingStatus = true; defer { checkingStatus = false }
        do { let data = try await Runtime.shared.call(["method":"vault-vm-status"])
            guard let state = try JSONSerialization.jsonObject(with:data) as? [String:Any] else { throw CocoaError(.coderReadCorrupt) }
            applyStatus(state)
        } catch { statusUnavailable = true; status = "상태 조회 실패 — 마지막 상태를 현재 상태로 간주하지 마세요." }
    }
    @Published var sharing = false
    private var channelID=UUID()
    private var process: Process?
    private var input: FileHandle?
    private var buffer = Data()
    private var outputBytes = 0
    static var active: VaultRuntimeModel?

    func refresh() async {
        do {
            let data = try await Runtime.shared.call(["method":"vault-list"])
            let rows = (try JSONSerialization.jsonObject(with:data)) as? [[String:Any]] ?? []
            vaults = rows.compactMap { row in
                guard let id=row["vaultId"] as? String, let name=row["displayName"] as? String, let environment=row["environmentId"] as? String else { return nil }
                return VaultChoice(id:id,name:name,environment:environment)
            }
            if selected.isEmpty { selected=vaults.first?.id ?? "" }
            if let capability = try JSONSerialization.jsonObject(with:await Runtime.shared.call(["method":"vault-browser-capabilities"])) as? [String:Any] { browserAvailable = capability["available"] as? Bool == true }
            try loadModels(await Runtime.shared.call(["method":"agent-models"]))
            await pollStatus()
        } catch { self.error=error.localizedDescription }
    }
    func choose() {
        let panel=NSOpenPanel();panel.canChooseDirectories=true;panel.canChooseFiles=false;panel.allowsMultipleSelection=false
        panel.message="선택한 디렉터리를 Vault로 등록합니다. .nidus/vault.json이 생성됩니다. 테스트에는 새 빈 디렉터리를 사용하세요."
        guard panel.runModal() == .OK, let url=panel.url else { return }
        Task {
            do {
                let data=try await Runtime.shared.call(["method":"vault-register","path":url.path])
                if let row=try JSONSerialization.jsonObject(with:data) as? [String:Any], let id=row["vaultId"] as? String { selected=id }
                await refresh()
            } catch { self.error=error.localizedDescription }
        }
    }
    func cacheAction(clear:Bool = false, vaultId:String? = nil, restart:Bool = false) async {
        let target=vaultId ?? selected
        guard !target.isEmpty else {return};busy=true;defer {busy=false}
        do {
            if restart { _ = try await Runtime.shared.call(["method":"vault-vm-service-restart"]) }
            if clear { _ = try await Runtime.shared.call(["method":"vault-cache-clear","vaultId":target]) }
            let data=try await Runtime.shared.call(["method":"vault-cache-status","vaultId":target])
            if let value=try JSONSerialization.jsonObject(with:data) as? [String:Any] {
                let state=value["state"] as? String ?? "unknown"
                let label=state == "dirty" ? (value["owned"] as? Bool == true ? "사용 중 또는 종료 미확인" : "정상 해제 미확인 — 재사용 차단") : state == "clean" ? "정상 해제됨" : state == "absent" ? "아직 생성되지 않음" : state
                guard target == selected else {return}
                cacheStatus="\(label) · 용량 512 MiB · Host 할당 \((value["allocatedBytes"] as? Int ?? 0)/1048576) MiB"
            }
        } catch { self.error=error.localizedDescription }
    }
    func action(_ method:String) async {
        busy=true;defer {busy=false}
        do {
            let data=try await Runtime.shared.call(["method":method,"vaultId":selected])
            if let state=try JSONSerialization.jsonObject(with:data) as? [String:Any] {
                applyStatus(state)
                if state["state"] as? String == "STOP_UNCONFIRMED" {error="VM 종료 근거를 확인할 수 없어 새 실행을 차단했습니다. 자동 복구·잠금 초기화는 지원하지 않습니다."}
            }
        } catch { self.error=error.localizedDescription }
    }
    func send(_ value:[String:Any]) {
        do {guard let input else {return};try input.write(contentsOf:JSONSerialization.data(withJSONObject:value)+Data([10]))}
        catch { self.error="Agent 승인/취소 채널이 끊겼습니다.";cancel() }
    }
    func startAgent() {
        if requiresWeb && !browserAvailable { error="웹 검색은 현재 비활성입니다. 최신 정보 확인 작업은 실행할 수 없습니다."; return }
        do { try reloadHealth(autoSelect:false) } catch { self.error="모델 검사 기록을 읽지 못해 실행을 차단했습니다."; return }
        guard selectedModel != nil else { error="동작 검사 통과 기록이 있는 모델을 선택하세요."; return }
        guard let choice = selectedModel, !running,sharing,!selected.isEmpty,!prompt.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty else {return}
        startRequest(["method":"run","vaultId":selected,"provider":choice.provider,"model":choice.model,"prompt":prompt,"confirmDataSharing":sharing,"requiresWeb":requiresWeb])
    }
    func startShell() {
        guard !running,!selected.isEmpty,!shellCommand.isEmpty else {return}
        startRequest(["method":"direct-shell","vaultId":selected,"command":shellCommand,"paths":workspacePaths.trimmingCharacters(in:.whitespacesAndNewlines)])
    }
    func startBrowser(search:Bool) {
        guard browserAvailable,!running,!selected.isEmpty,!browserInput.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty else {return}
        startRequest(["method":"direct-browser","vaultId":selected,"tool":search ? "browser_search" : "browser_navigate","value":browserInput])
    }
    private func startRequest(_ request:[String:Any]) {
        do {
            let location=try RuntimeLocation.resolve(),child=Process(),stdin=Pipe(),stdout=Pipe()
            child.executableURL=location.node;child.arguments=[location.script.deletingLastPathComponent().appendingPathComponent("agent-channel.js").path]
            child.standardInput=stdin;child.standardOutput=stdout;child.standardError=FileHandle.nullDevice
            channelID=UUID();let runID=channelID
            buffer=Data();outputBytes=0;events=[];error=nil
            stdout.fileHandleForReading.readabilityHandler={ [weak self] handle in
                let data=handle.availableData
                if data.isEmpty {handle.readabilityHandler=nil;return}
                Task { @MainActor in guard let self, self.channelID==runID else {return};self.receive(data) }
            }
            child.terminationHandler={ [weak self] _ in Task { @MainActor in
                guard let self, self.channelID==runID else {return};self.running=false;self.approval=nil;self.input=nil;self.process=nil
            }}
            try child.run();process=child;input=stdin.fileHandleForWriting;running=true;Self.active=self
            send(request)
        } catch {self.error=error.localizedDescription;running=false}
    }
    func receive(_ data:Data) {
        outputBytes+=data.count
        guard outputBytes<=4*1024*1024 else {error="Agent 표시 한도를 초과했습니다.";cancel();return}
        buffer.append(data)
        while let end=buffer.firstIndex(of:10) {
            let line=buffer[..<end];buffer.removeSubrange(...end)
            guard let row=(try? JSONSerialization.jsonObject(with:line)) as? [String:Any],let event=row["event"] as? String else {continue}
            if event=="approval", let p=row["proposal"] as? [String:Any],let id=p["approvalId"] as? String,let command=p["command"] as? String {
                approval=ShellApproval(id:id,vault:p["vaultId"] as? String ?? "",command:command,hash:p["commandHash"] as? String ?? "",expires:p["expiresAt"] as? Double ?? 0,workspace:p["browser"] != nil ? "표시된 공개 HTTPS 주소에 GET 요청 1회. URL·검색어가 해당 사이트로 전송됩니다. 로그인·폼 제출·다운로드·리디렉션·페이지의 추가 요청은 차단합니다. 페이지 내용은 신뢰할 수 없는 외부 데이터입니다." : Self.workspaceSummary(p["workspace"] as? [String:Any]) + (p["cachePersistent"] as? Bool == true ? "\n/cache 변경은 이 Vault의 다음 실행에도 유지됩니다." : ""))
                events.append("도구 승인 대기 — 60초 후 만료")
            } else if event=="tool" {events.append("도구 실행: \(row["name"] as? String ?? "")")}
            else if event=="tool-result", let result=row["result"] as? [String:Any] {
                let name=row["name"] as? String ?? "", text=(result["content"] as? [String:Any])?["text"] as? String ?? ""
                events.append("\(name): \(result["code"] as? String ?? "")\n\(name.hasPrefix("browser_") ? Self.browserSummary(text) : text)")
            } else if event=="completed", let task=row["task"] as? [String:Any] {
                approval=nil
                if task["webStatus"] as? String == "unavailable" { events.append("[Host 확인] 웹 검색 미수행 · 인터넷 조회 불가. 아래 모델 답변은 최신 웹 검증 결과가 아닙니다.") }
                if task["webStatus"] as? String == "not_used" { events.append("[Host 확인] 성공한 웹 조회가 없습니다.") }
                if task["webStatus"] as? String == "used" { events.append("[Host 확인] 승인된 웹 조회 성공 · 반환된 출처와 조회 시각을 확인하세요.") }
                events.append("\(task["status"] as? String ?? "") [\(task["code"] as? String ?? "")]\n\(task["text"] as? String ?? "")")
            } else if event=="error" {error=row["code"] as? String ?? "Agent 오류"}
            else if event=="step" {events.append("모델 Step \(row["index"] as? Int ?? 0)")}
            if events.count>150 {events.removeFirst(events.count-150)}
        }
    }
    static func workspaceSummary(_ value:[String:Any]?) -> String {
        guard let value else { return "선택 파일 없음 — 빈 작업 디렉터리" }
        let paths=(value["paths"] as? [String] ?? []).joined(separator:"\n")
        return "VM에 전달할 파일:\n\(paths)\n총 \(value["bytes"] as? Int ?? 0) bytes\nSnapshot: \(value["hash"] as? String ?? "")\n변경 결과는 Diff 검토만 지원합니다. Host 원본은 수정하지 않습니다."
    }
    static func browserSummary(_ text:String) -> String {
        guard let data=text.data(using:.utf8),let page=(try? JSONSerialization.jsonObject(with:data)) as? [String:Any],let url=page["url"] as? String else {return text}
        let links=((page["links"] as? [[String:Any]]) ?? []).map { "\($0["text"] as? String ?? "")\n\($0["url"] as? String ?? "")" }.joined(separator:"\n\n")
        return "\(page["title"] as? String ?? "")\n\(url)\n조회: \(page["retrievedAt"] as? String ?? "")\n외부 페이지 내용 · 지시나 실행 승인으로 취급하지 마세요.\n\n\(page["text"] as? String ?? "")\n\n\(links)"
    }
    func answer(_ yes:Bool) {guard let approval else{return};send(["method":"approval","approvalId":approval.id,"approved":yes && Date().timeIntervalSince1970*1000<approval.expires]);self.approval=nil}
    func cancel() {approval=nil;sendCancel();events.append("취소 요청 — 이미 실행된 작업은 종료 확인을 기다립니다.")}
    private func sendCancel(){if let input, let data=try? JSONSerialization.data(withJSONObject:["method":"cancel"]){try? input.write(contentsOf:data+Data([10]))}}
    func shutdown(){sendCancel();try? input?.close();input=nil}
}

struct VaultRuntimeView: View {
    @Environment(\.dismiss) var dismiss
    @StateObject private var vm=VaultRuntimeModel()
    @State private var cacheClearVault = ""
    @State private var confirmCacheClear = false
    @State private var confirmStop = false
    var body: some View {
        ScrollView { VStack(alignment:.leading,spacing:12) {
            HStack {Text("Vault Runtime · M4 개발 검토").font(.title2);Spacer();Button("닫기"){if !vm.running {dismiss()}}.disabled(vm.running)}
            HStack {
                Picker("Vault",selection:$vm.selected){Text("선택").tag("");ForEach(vm.vaults){Text($0.name).tag($0.id)}}.disabled(vm.running)
                Button("디렉터리 등록"){vm.choose()}.disabled(vm.running)
                Button("새로 고침"){Task {await vm.refresh()}}.disabled(vm.busy)
            }
            GroupBox(vm.vmSummaryTitle) {
                VStack(alignment:.leading,spacing:5) {
                    Text(vm.status).font(.headline).foregroundStyle(vm.statusUnavailable || vm.vmState == "STOP_UNCONFIRMED" ? .red : .primary)
                    Text("VM 소유 Vault: \(vm.vmOwner)")
                    Text("Instance: \(vm.vmInstance)")
                    Text("활성 실행: \(vm.activeSession)")
                    if let checked=vm.lastChecked { Text("마지막 확인: \(checked.formatted(date:.omitted,time:.standard)) · 2초마다 갱신").foregroundStyle(.secondary) }
                    if !vm.recentSessions.isEmpty { DisclosureGroup("최근 실행 \(vm.recentSessions.count)건") { ForEach(vm.recentSessions,id:\.self) { Text($0) } } }
                }.font(.caption).textSelection(.enabled).frame(maxWidth:.infinity,alignment:.leading)
            }
            HStack {
                Button("오프라인 VM 시작"){Task {await vm.action("vault-vm-start")}}.disabled(vm.selected.isEmpty||vm.busy||vm.running)
                Button("실행 중인 VM 종료…"){confirmStop=true}.disabled(vm.busy || !vm.canStop)
                    .confirmationDialog("\(vm.vmOwner)의 VM을 종료할까요?",isPresented:$confirmStop,titleVisibility:.visible) {
                        Button("VM 종료",role:.destructive){Task {await vm.action("vault-vm-stop")}}
                    }
            }
            Text("Shell: 승인된 명령만 오프라인 VM에서 실행합니다. Python·Node.js를 사용할 수 있고, Host Vault를 마운트하지 않으며 세션 작업 디렉터리는 매번 비워집니다. 브라우저의 공개 HTTPS 읽기는 아래에서 별도로 승인합니다. Host 파일 생성·수정·삭제는 비활성입니다.").font(.caption).foregroundStyle(.secondary)
            HStack {TextField("오프라인 Shell 명령",text:$vm.shellCommand).disabled(vm.running)
                Button("Shell 제안 · API 호출 없음"){vm.startShell()}.disabled(vm.running || vm.selected.isEmpty || vm.shellCommand.isEmpty)
            }
            Text("Workspace 파일 (Vault 상대경로, 한 줄에 하나, 최대 32개). 다음 Shell 승인에 포함됩니다.").font(.caption)
            TextEditor(text:$vm.workspacePaths).frame(height:50).border(.quaternary).disabled(vm.running)
            GroupBox("Vault 전용 패키지 캐시") {
                VStack(alignment:.leading) {
                    Text(vm.cacheStatus).font(.caption)
                    Text("/cache의 pip·npm 캐시는 재부팅 후에도 유지됩니다. 작업 폴더·환경변수·인증 정보는 보존하지 않습니다. 인터넷 패키지 다운로드는 아직 지원하지 않습니다.").font(.caption)
                    HStack {
                        Button("캐시 상태 조회"){Task {await vm.cacheAction()}}.disabled(vm.selected.isEmpty||vm.busy)
                        Button("정지된 서비스 갱신"){Task {await vm.cacheAction(restart:true)}}.disabled(vm.busy||vm.running || !["STOPPED","STOP_CONFIRMED"].contains(vm.vmState))
                        Button("선택 Vault 캐시 삭제…",role:.destructive){cacheClearVault=vm.selected;confirmCacheClear=true}.disabled(vm.selected.isEmpty||vm.busy||vm.running || !["STOPPED","STOP_CONFIRMED"].contains(vm.vmState))
                            .confirmationDialog("선택 Vault의 패키지 캐시를 삭제할까요? Host 원본 파일은 유지됩니다.",isPresented:$confirmCacheClear,titleVisibility:.visible){Button("캐시 삭제",role:.destructive){Task {await vm.cacheAction(clear:true,vaultId:cacheClearVault)}}}
                    }
                }.frame(maxWidth:.infinity,alignment:.leading)
            }
            Divider()
            HStack {Picker("검사 통과 모델",selection:$vm.model){Text("모델 선택").tag("");ForEach(vm.agentModels.filter { $0.available }) { choice in Text(choice.label).tag(choice.id) }}.disabled(vm.running)
                Button("Agent 실행"){vm.startAgent()}.disabled(vm.running||vm.selected.isEmpty || vm.selectedModel == nil || (vm.requiresWeb && !vm.browserAvailable) || !vm.sharing||vm.prompt.isEmpty)
                Button("실행 취소"){vm.cancel()}.disabled(!vm.running)
            }
            if let choice=vm.selectedModel { Text(choice.mode == "native-tools" ? "네이티브 Tool Calling · 모든 VM 명령은 개별 승인 필요" : "Nidus JSON 도구 프로토콜 · 모델의 형식 준수에 따라 실행이 실패할 수 있으며, 잘못된 요청은 실행하지 않습니다.").font(.caption).foregroundStyle(.secondary) }
            if vm.agentModels.filter({$0.available}).isEmpty { Text("선택 가능한 검사 통과 모델이 없습니다. 모델 일괄 동작 검사를 완료한 뒤 새로 고침하세요.").foregroundStyle(.orange) }
            Toggle("선택한 Vault의 허용된 파일 내용과 명령 결과를 선택한 Provider에 전송하며 API 비용이 발생할 수 있음을 확인했습니다.",isOn:$vm.sharing).font(.caption).disabled(vm.running)
            GroupBox(vm.browserAvailable ? "제한적 인터넷 · 읽기 전용 브라우저" : "웹 검색 · 현재 사용 불가") {
                VStack(alignment:.leading) {
                    Text(vm.browserAvailable ? "승인된 공개 HTTPS 페이지를 읽습니다. 로그인·스크립트·폼 제출·다운로드·자동 리디렉션은 지원하지 않습니다. Shell은 오프라인이며, 사이트가 조회를 차단할 수 있습니다." : "이 이미지에는 브라우저 기능이 없습니다. Shell은 오프라인입니다.")
                    if vm.browserAvailable {
                        TextField("HTTPS 주소 또는 검색어",text:$vm.browserInput).disabled(vm.running)
                        HStack {Button("주소 읽기…"){vm.startBrowser(search:false)};Button("웹 검색…"){vm.startBrowser(search:true)}}.disabled(vm.running||vm.selected.isEmpty||vm.browserInput.isEmpty)
                        Text("직접 브라우저 실행은 Provider를 호출하지 않습니다. Agent에서 사용하면 페이지 내용이 선택한 Provider에 전달됩니다.")
                    }
                    Toggle("이 작업은 웹 검색이 반드시 필요함",isOn:$vm.requiresWeb).disabled(vm.running)
                    if vm.requiresWeb { Text(vm.browserAvailable ? "웹 조회가 성공해야 작업을 완료로 표시합니다." : "웹 검색이 필요한 작업은 API 비용이 발생하지 않도록 실행을 차단합니다.").foregroundStyle(.orange) }
                }.font(.caption).frame(maxWidth:.infinity,alignment:.leading)
            }
            TextEditor(text:$vm.prompt).frame(height:70).border(.quaternary).disabled(vm.running)
            if let approval=vm.approval {
                VStack(alignment:.leading,spacing:8){Text("VM 도구 실행 승인").font(.headline);Text("Vault: \(approval.vault)").font(.caption)
                    ScrollView {Text(approval.command).font(.system(.body,design:.monospaced)).textSelection(.enabled).frame(maxWidth:.infinity,alignment:.leading)}.frame(maxHeight:120)
                    Text(approval.workspace).font(.caption).textSelection(.enabled)
                    Text("SHA-256: \(approval.hash)").font(.caption2).textSelection(.enabled)
                    HStack {Button("거부"){vm.answer(false)};Button("이 명령 1회 승인"){vm.answer(true)}}
                }.padding().background(.orange.opacity(0.12),in:RoundedRectangle(cornerRadius:8))
            }
            if let error=vm.error {Text(error).foregroundStyle(.red).textSelection(.enabled)}
            ScrollView {Text(vm.events.joined(separator:"\n\n")).font(.system(.caption,design:.monospaced)).textSelection(.enabled).frame(maxWidth:.infinity,alignment:.leading)}.frame(minHeight:120,maxHeight:300)
        }.padding(24) }.frame(minWidth:850,minHeight:720).task {
            await vm.refresh()
            while !Task.isCancelled { do {try await Task.sleep(nanoseconds:2_000_000_000)} catch {break}; await vm.pollStatus() }
        }.onChange(of:vm.model) { _ in vm.sharing=false }
         .onChange(of:vm.selected) { _ in vm.cacheStatus="캐시 상태 조회 전";Task {await vm.pollStatus()} }
    }
}
