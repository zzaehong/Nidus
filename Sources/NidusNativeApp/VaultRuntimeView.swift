import SwiftUI
import AppKit

struct VaultChoice: Identifiable { let id: String; let name: String; let environment: String }
struct ShellApproval: Identifiable { let id: String; let vault: String; let command: String; let hash: String; let expires: Double }

@MainActor final class VaultRuntimeModel: ObservableObject {
    @Published var vaults: [VaultChoice] = []
    @Published var selected = ""
    @Published var status = "상태 조회 전"
    @Published var error: String?
    @Published var busy = false
    @Published var running = false
    @Published var events: [String] = []
    @Published var approval: ShellApproval?
    @Published var prompt = ""
    @Published var shellCommand = "echo hello; pwd; id"
    @Published var model = "gpt-4.1-mini"
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
            await action("vault-vm-status")
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
    func action(_ method:String) async {
        busy=true;defer {busy=false}
        do {
            let data=try await Runtime.shared.call(["method":method,"vaultId":selected])
            if let state=try JSONSerialization.jsonObject(with:data) as? [String:Any] {
                status="\(state["state"] as? String ?? "UNKNOWN") · Generation \(state["generation"] as? Int ?? 0) · 대기 \(state["queued"] as? Int ?? 0)"
                if let owner=state["vaultId"] as? String {status += "\nVM Vault: \(owner)"}
                if let session=state["activeSession"] as? String {status += "\n실행: \(session)"}
                if state["state"] as? String == "STOP_UNCONFIRMED" {error="VM 종료 근거를 확인할 수 없어 새 실행을 차단했습니다. 자동 복구·잠금 초기화는 지원하지 않습니다."}
            }
        } catch { self.error=error.localizedDescription }
    }
    func send(_ value:[String:Any]) {
        do {guard let input else {return};try input.write(contentsOf:JSONSerialization.data(withJSONObject:value)+Data([10]))}
        catch { self.error="Agent 승인/취소 채널이 끊겼습니다.";cancel() }
    }
    func startAgent() {
        guard !running,sharing,!selected.isEmpty,!prompt.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty else {return}
        startRequest(["method":"run","vaultId":selected,"model":model,"prompt":prompt,"confirmDataSharing":sharing])
    }
    func startShell() {
        guard !running,!selected.isEmpty,!shellCommand.isEmpty else {return}
        startRequest(["method":"direct-shell","vaultId":selected,"command":shellCommand])
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
                approval=ShellApproval(id:id,vault:p["vaultId"] as? String ?? "",command:command,hash:p["commandHash"] as? String ?? "",expires:p["expiresAt"] as? Double ?? 0)
                events.append("Shell 승인 대기 — 60초 후 만료")
            } else if event=="tool" {events.append("도구 실행: \(row["name"] as? String ?? "")")}
            else if event=="tool-result", let result=row["result"] as? [String:Any] {
                events.append("\(row["name"] as? String ?? ""): \(result["code"] as? String ?? "")\n\((result["content"] as? [String:Any])?["text"] as? String ?? "")")
            } else if event=="completed", let task=row["task"] as? [String:Any] {
                approval=nil;events.append("\(task["status"] as? String ?? "") [\(task["code"] as? String ?? "")]\n\(task["text"] as? String ?? "")")
            } else if event=="error" {error=row["code"] as? String ?? "Agent 오류"}
            else if event=="step" {events.append("모델 Step \(row["index"] as? Int ?? 0)")}
            if events.count>150 {events.removeFirst(events.count-150)}
        }
    }
    func answer(_ yes:Bool) {guard let approval else{return};send(["method":"approval","approvalId":approval.id,"approved":yes && Date().timeIntervalSince1970*1000<approval.expires]);self.approval=nil}
    func cancel() {approval=nil;sendCancel();events.append("취소 요청 — 이미 실행된 작업은 종료 확인을 기다립니다.")}
    private func sendCancel(){if let input, let data=try? JSONSerialization.data(withJSONObject:["method":"cancel"]){try? input.write(contentsOf:data+Data([10]))}}
    func shutdown(){sendCancel();try? input?.close();input=nil}
}

struct VaultRuntimeView: View {
    @Environment(\.dismiss) var dismiss
    @StateObject private var vm=VaultRuntimeModel()
    var body: some View {
        VStack(alignment:.leading,spacing:12) {
            HStack {Text("Vault Runtime · M4 개발 검토").font(.title2);Spacer();Button("닫기"){if !vm.running {dismiss()}}.disabled(vm.running)}
            HStack {
                Picker("Vault",selection:$vm.selected){Text("선택").tag("");ForEach(vm.vaults){Text($0.name).tag($0.id)}}.disabled(vm.running)
                Button("디렉터리 등록"){vm.choose()}.disabled(vm.running)
                Button("새로 고침"){Task {await vm.refresh()}}.disabled(vm.busy)
            }
            Text(vm.status).font(.system(.caption,design:.monospaced)).textSelection(.enabled)
            HStack {
                Button("오프라인 VM 시작"){Task {await vm.action("vault-vm-start")}}.disabled(vm.selected.isEmpty||vm.busy||vm.running)
                Button("VM 종료 요청"){Task {await vm.action("vault-vm-stop")}}.disabled(vm.busy||vm.running)
            }
            Text("Shell: 승인된 명령만 번들에 포함된 오프라인 VM에서 실행합니다. 개발 이미지 빌드에서는 Python·Node.js를 사용할 수 있습니다. Host Vault는 마운트하지 않으며 세션 작업 디렉터리는 매번 비워집니다. Browser: 네트워크 격리 미검증으로 비활성. Host 파일 생성·수정·삭제: 비활성.").font(.caption).foregroundStyle(.secondary)
            HStack {TextField("오프라인 Shell 명령",text:$vm.shellCommand).disabled(vm.running)
                Button("Shell 제안 · API 호출 없음"){vm.startShell()}.disabled(vm.running || vm.selected.isEmpty || vm.shellCommand.isEmpty)
            }
            Divider()
            HStack {Picker("OpenAI 모델",selection:$vm.model){Text("gpt-4.1-mini").tag("gpt-4.1-mini");Text("gpt-4.1").tag("gpt-4.1")}.disabled(vm.running)
                Button("Agent 실행"){vm.startAgent()}.disabled(vm.running||vm.selected.isEmpty || !vm.sharing||vm.prompt.isEmpty)
                Button("실행 취소"){vm.cancel()}.disabled(!vm.running)
            }
            Toggle("선택한 Vault의 허용된 파일 내용과 명령 결과를 OpenAI에 전송하며 API 비용이 발생할 수 있음을 확인했습니다.",isOn:$vm.sharing).font(.caption).disabled(vm.running)
            TextEditor(text:$vm.prompt).frame(height:70).border(.quaternary).disabled(vm.running)
            if let approval=vm.approval {
                VStack(alignment:.leading,spacing:8){Text("VM Shell 실행 승인").font(.headline);Text("Vault: \(approval.vault)").font(.caption)
                    ScrollView {Text(approval.command).font(.system(.body,design:.monospaced)).textSelection(.enabled).frame(maxWidth:.infinity,alignment:.leading)}.frame(maxHeight:120)
                    Text("SHA-256: \(approval.hash)").font(.caption2).textSelection(.enabled)
                    HStack {Button("거부"){vm.answer(false)};Button("이 명령 1회 승인"){vm.answer(true)}}
                }.padding().background(.orange.opacity(0.12),in:RoundedRectangle(cornerRadius:8))
            }
            if let error=vm.error {Text(error).foregroundStyle(.red).textSelection(.enabled)}
            ScrollView {Text(vm.events.joined(separator:"\n\n")).font(.system(.caption,design:.monospaced)).textSelection(.enabled).frame(maxWidth:.infinity,alignment:.leading)}
        }.padding(24).frame(minWidth:850,minHeight:720).task {await vm.refresh()}
    }
}
