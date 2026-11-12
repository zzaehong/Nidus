import Foundation
import AppKit

/// One line of the run log in the Work tab.
struct RunEntry: Identifiable {
    enum Kind { case instruction, model, tool, finished, stopped, failed, retry, note, main, manager }
    let id = UUID()
    let kind: Kind
    var title: String
    var detail: String = ""
    var isError = false
    var callId: String?
    var pending = false
}

struct BrowserTab: Identifiable, Equatable {
    let id: String
    let url: String
    let title: String
    let active: Bool
}

struct ApprovalRequest: Identifiable {
    let id: String
    let target: String
    let host: String
    let site: String
    let port: Int
    var label: String { target == "mac" ? "Mac의 포트 \(port) (host.nidus)" : site }
}

struct WorkReview: Decodable {
    struct Commit: Decodable, Identifiable { let hash: String; let subject: String; let author: String; var id: String { hash } }
    struct File: Decodable, Identifiable { let path: String; let added: Int?; let removed: Int?; var id: String { path } }
    let task: String
    let base: String
    let head: String
    let commits: [Commit]
    let files: [File]
    let diff: String
    let diffTruncated: Bool
    let sensitive: [String]
}

/// A request handled by Main, its teams and their tasks (the Task Board of one request).
struct OfficeProject: Decodable {
    struct Team: Decodable, Identifiable { let id: String; let name: String; let focus: String }
    struct Contract: Decodable { let goal: String; let scope: String; let constraints: String; let acceptance: [String]; let verification: String }
    struct Review: Decodable { let verdict: String; let feedback: String }
    struct Result: Decodable { let summary: String; let verification: String }
    struct Task: Decodable, Identifiable {
        let id: String; let team: String; let title: String; let contract: Contract; let dependsOn: [String]
        let status: String; let difficulty: String?; let attempts: Int; let reviews: [Review]; let result: Result?
    }
    struct Question: Decodable, Identifiable { let id: String; let text: String; let answer: String? }
    let id: String
    let instruction: String
    let status: String
    let summary: String
    let roadmap: [String]
    let teams: [Team]
    let tasks: [Task]
    let questions: [Question]
    let report: String?
    let error: String?
}

/// The resident Workspace Service (dist/workspace/service.js) for the open Vault: the VM, its
/// browser and the Worker. Talks to it in JSON lines over stdin/stdout.
@MainActor
final class WorkspaceSession: ObservableObject {
    static let shared = WorkspaceSession()

    @Published private(set) var vault: String?
    @Published private(set) var vm = "stopped"
    @Published private(set) var detail = ""
    @Published private(set) var task: String?
    @Published private(set) var running = false
    @Published private(set) var control = "ai"
    @Published private(set) var controlReason: String?
    @Published private(set) var frame: NSImage?
    @Published private(set) var frameSize = CGSize(width: 1280, height: 800)
    @Published private(set) var tabs: [BrowserTab] = []
    @Published private(set) var approvals: [ApprovalRequest] = []
    @Published private(set) var entries: [RunEntry] = []
    @Published private(set) var review: WorkReview?
    @Published private(set) var project: OfficeProject?
    @Published private(set) var git = "ready"
    @Published private(set) var costUSD = 0.0
    @Published private(set) var costUnknown = false
    @Published var allowAll = false
    @Published var error: String?

    private var process: Process?
    private var input: FileHandle?
    private var buffer = Data()
    private var nextId = 0
    private var waiting: [Int: CheckedContinuation<[String: Any], Error>] = [:]

    // MARK: - lifecycle

    /// Starts the service for this Vault (once). Switching Vaults ends the previous one.
    func attach(_ path: String) async {
        if vault == path, process != nil { return }
        await shutdown()
        reset()
        vault = path
        do {
            try launch()
            let result = try await send("open", ["vault": path])
            git = result["git"] as? String ?? "ready"
            task = result["task"] as? String
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func reset() {
        vm = "stopped"; detail = ""; task = nil; running = false; control = "ai"; controlReason = nil
        frame = nil; tabs = []; approvals = []; entries = []; review = nil; project = nil; costUSD = 0; costUnknown = false; allowAll = false
    }

    private func launch() throws {
        let location = try BridgeLocation.resolve()
        let script = location.script.deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("workspace/service.js")
        guard FileManager.default.fileExists(atPath: script.path) else { throw BridgeError(message: "작업 공간 엔진이 없습니다. npm run build를 실행하세요.") }
        let process = Process(), stdin = Pipe(), stdout = Pipe()
        process.executableURL = location.node
        process.arguments = [script.path]
        process.standardInput = stdin
        process.standardOutput = stdout
        process.standardError = FileHandle.nullDevice
        stdout.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            Task { @MainActor in self?.receive(data) }
        }
        process.terminationHandler = { [weak self] _ in
            Task { @MainActor in self?.ended() }
        }
        try process.run()
        self.process = process
        self.input = stdin.fileHandleForWriting
    }

    private func ended() {
        process = nil; input = nil
        for (_, continuation) in waiting { continuation.resume(throwing: BridgeError(message: "작업 공간 엔진이 종료되었습니다.")) }
        waiting.removeAll()
        if vm != "stopped" { vm = "failed"; detail = "작업 공간 엔진이 종료되었습니다" }
        running = false
    }

    /// Ends the service; it stops the VM properly before exiting. Waits up to 30 seconds.
    func shutdown() async {
        guard let process else { return }
        try? input?.close()
        input = nil
        for _ in 0..<300 where process.isRunning { try? await Task.sleep(nanoseconds: 100_000_000) }
        if process.isRunning { process.terminate() }
        self.process = nil
    }

    // MARK: - protocol

    @discardableResult
    func send(_ command: String, _ arguments: [String: Any] = [:]) async throws -> [String: Any] {
        guard let input else { throw BridgeError(message: "작업 공간 엔진이 실행 중이 아닙니다.") }
        nextId += 1
        let id = nextId
        var message = arguments
        message["id"] = id
        message["cmd"] = command
        var line = try JSONSerialization.data(withJSONObject: message)
        line.append(0x0A)
        return try await withCheckedThrowingContinuation { continuation in
            waiting[id] = continuation
            do { try input.write(contentsOf: line) } catch {
                waiting.removeValue(forKey: id)
                continuation.resume(throwing: BridgeError(message: "작업 공간 엔진에 명령을 보내지 못했습니다."))
            }
        }
    }

    /// Runs a command and shows its failure instead of throwing.
    func perform(_ command: String, _ arguments: [String: Any] = [:]) {
        Task {
            do { try await send(command, arguments) } catch { self.error = error.localizedDescription }
        }
    }

    private func receive(_ data: Data) {
        if data.isEmpty { return }
        buffer.append(data)
        while let end = buffer.firstIndex(of: 0x0A) {
            let line = buffer[buffer.startIndex..<end]
            buffer.removeSubrange(buffer.startIndex...end)
            guard let message = try? JSONSerialization.jsonObject(with: line) as? [String: Any] else { continue }
            if let reply = message["reply"] as? Int {
                let continuation = waiting.removeValue(forKey: reply)
                if message["ok"] as? Bool == true { continuation?.resume(returning: message["result"] as? [String: Any] ?? [:]) }
                else { continuation?.resume(throwing: BridgeError(message: message["error"] as? String ?? "요청이 실패했습니다.")) }
            } else if let event = message["event"] as? String {
                handle(event, message)
            }
        }
        if buffer.count > 16 * 1024 * 1024 { buffer.removeAll() }
    }

    private func handle(_ event: String, _ m: [String: Any]) {
        switch event {
        case "status":
            vm = m["vm"] as? String ?? vm
            if let text = m["detail"] as? String { detail = text }
            task = m["task"] as? String
            running = m["running"] as? Bool ?? false
            control = m["control"] as? String ?? control
        case "frame":
            guard let base64 = m["data"] as? String, let data = Data(base64Encoded: base64), let image = NSImage(data: data) else { return }
            frame = image
            frameSize = CGSize(width: m["width"] as? Double ?? 1280, height: m["height"] as? Double ?? 800)
        case "control":
            control = m["control"] as? String ?? "ai"
            controlReason = m["reason"] as? String
        case "tabs":
            tabs = (m["tabs"] as? [[String: Any]] ?? []).map { BrowserTab(id: $0["id"] as? String ?? "", url: $0["url"] as? String ?? "", title: $0["title"] as? String ?? "", active: $0["active"] as? Bool ?? false) }
        case "approval":
            approvals.append(ApprovalRequest(id: m["id"] as? String ?? "", target: m["target"] as? String ?? "internet", host: m["host"] as? String ?? "", site: m["site"] as? String ?? "", port: m["port"] as? Int ?? 0))
            NSApp.requestUserAttention(.informationalRequest)
        case "approvalDone":
            approvals.removeAll { $0.id == m["id"] as? String }
        case "allowAll":
            allowAll = m["enabled"] as? Bool ?? false
        case "review":
            if let value = m["review"], !(value is NSNull), let data = try? JSONSerialization.data(withJSONObject: value) {
                review = try? JSONDecoder().decode(WorkReview.self, from: data)
            } else {
                review = nil
            }
        case "log":
            entries.append(RunEntry(kind: .note, title: m["text"] as? String ?? ""))
        case "project":
            if let value = m["project"], !(value is NSNull), let data = try? JSONSerialization.data(withJSONObject: value) {
                project = try? JSONDecoder().decode(OfficeProject.self, from: data)
            } else {
                project = nil
            }
        case "office":
            let from = m["from"] as? String ?? "main"
            entries.append(RunEntry(kind: from == "manager" ? .manager : .main, title: m["title"] as? String ?? "", detail: m["text"] as? String ?? "", isError: m["isError"] as? Bool ?? false))
        case "worker":
            worker(m)
        default:
            break
        }
    }

    private func worker(_ m: [String: Any]) {
        switch m["type"] as? String {
        case "instruction":
            entries.append(RunEntry(kind: .instruction, title: m["text"] as? String ?? ""))
        case "model":
            if let cost = m["costUSD"] as? String, let value = Double(cost) { costUSD += value } else { costUnknown = true }
            let text = (m["text"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            let model = m["model"] as? String ?? ""
            if !text.isEmpty { entries.append(RunEntry(kind: .model, title: text, detail: model)) }
        case "tool_call":
            entries.append(RunEntry(kind: .tool, title: Self.describe(tool: m["name"] as? String ?? "", input: m["input"]), detail: "", callId: m["id"] as? String, pending: true))
        case "tool_result":
            if let index = entries.lastIndex(where: { $0.callId == m["id"] as? String }) {
                entries[index].detail = m["content"] as? String ?? ""
                entries[index].isError = m["isError"] as? Bool ?? false
                entries[index].pending = false
            }
        case "retry":
            entries.append(RunEntry(kind: .retry, title: "모델 호출 실패, 다시 시도합니다 (\(m["attempt"] as? Int ?? 0)회째)", detail: m["error"] as? String ?? "", isError: true))
        case "finished":
            entries.append(RunEntry(kind: .finished, title: m["summary"] as? String ?? ""))
        case "stopped":
            entries.append(RunEntry(kind: .stopped, title: m["detail"] as? String ?? "중지됨", isError: true))
        case "failed":
            entries.append(RunEntry(kind: .failed, title: m["error"] as? String ?? "실패", isError: true))
        default:
            break
        }
    }

    /// A tool call in words, for the log.
    static func describe(tool: String, input: Any?) -> String {
        let i = input as? [String: Any] ?? [:]
        func s(_ key: String) -> String { (i[key] as? String) ?? (i[key].map { "\($0)" } ?? "") }
        switch tool {
        case "shell": return "$ \(s("command"))"
        case "read_file": return "파일 읽기 \(s("path"))"
        case "write_file": return "파일 쓰기 \(s("path"))\(i["append"] as? Bool == true ? " (이어 쓰기)" : "")"
        case "list_files": return "파일 목록 \(s("path").isEmpty ? "/workspace" : s("path"))"
        case "web_search": return "검색 \"\(s("query"))\"\(s("engine").isEmpty ? "" : " (\(s("engine")))")"
        case "browser_open": return "열기 \(s("url"))"
        case "browser_observe": return "페이지 관찰"
        case "browser_read_more": return "페이지 더 읽기"
        case "browser_click": return "클릭 #\(s("element"))"
        case "browser_type": return "입력 #\(s("element")) \"\(s("text"))\""
        case "browser_press": return "키 \(s("key")) #\(s("element"))"
        case "browser_select": return "선택 #\(s("element")) \(s("value"))"
        case "browser_scroll": return "스크롤 \(s("pixels"))"
        case "browser_back": return "뒤로"
        case "browser_switch_tab": return "탭 전환"
        case "browser_ask_user": return "사용자에게 요청: \(s("reason"))"
        case "finish": return "작업 완료"
        default: return tool
        }
    }

    // MARK: - actions

    func start() { perform("start") }
    func stop() { perform("stop") }
    func run(_ instruction: String, difficulty: String, fresh: Bool) {
        Task {
            do { try await send("run", ["instruction": instruction, "difficulty": difficulty, "fresh": fresh]) }
            catch { self.error = error.localizedDescription }
        }
    }
    func cancel() { perform("cancel") }
    func plan(_ instruction: String) { perform("plan", ["instruction": instruction]) }
    func replyToPlan(answers: [String: String], note: String) { perform("planReply", ["answers": answers, "note": note]) }
    func approvePlan() { perform("approvePlan") }
    func closeProject() { perform("closeProject") }
    func takeOver() { perform("takeOver") }
    func handBack() { perform("handBack") }
    func answer(_ request: ApprovalRequest, _ answer: String) {
        approvals.removeAll { $0.id == request.id }
        perform("answer", ["approval": request.id, "answer": answer])
    }
    func setAllowAll(_ enabled: Bool) { perform("allowAll", ["enabled": enabled]) }
    func approve() { if let review { perform("approve", ["head": review.head]) } }
    func discard() { perform("discard") }
    func gitInit() {
        Task {
            do { git = try await send("gitInit")["git"] as? String ?? git } catch { self.error = error.localizedDescription }
        }
    }
    func clearLog() { entries.removeAll() }

    // Browser input is sent in order and failures are quiet: the screen shows the result.
    private var inputs: Task<Void, Never>?
    func input(_ event: [String: Any]) {
        guard control == "user" else { return }
        let previous = inputs
        inputs = Task {
            await previous?.value
            _ = try? await send("input", ["input": event])
        }
    }
}
