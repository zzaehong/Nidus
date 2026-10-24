import SwiftUI
import Foundation

struct ChatMessage: Codable, Identifiable {
    let id: UUID
    let role: String
    var content: String
    var provider: Provider?
    var model: String?
    var inputTokens: Int?
    var outputTokens: Int?
    var createdAt: Date
    var failed: Bool
    init(role: String, content: String, provider: Provider? = nil, model: String? = nil,
         inputTokens: Int? = nil, outputTokens: Int? = nil, failed: Bool = false) {
        self.id = UUID(); self.role = role; self.content = content
        self.provider = provider; self.model = model; self.inputTokens = inputTokens; self.outputTokens = outputTokens
        self.createdAt = Date(); self.failed = failed
    }
}

struct ChatRoom: Codable, Identifiable {
    let id: UUID
    var title: String
    var systemPrompt: String
    var provider: Provider
    var model: String
    var messages: [ChatMessage]
    var updatedAt: Date
    init(provider: Provider = .openai, model: String = "") {
        id = UUID(); title = "새 채팅방"; systemPrompt = ""; self.provider = provider
        self.model = model; messages = []; updatedAt = Date()
    }
}

struct ChatRoomStore {
    let url: URL
    static var application: ChatRoomStore {
        ChatRoomStore(url: FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Nidus", isDirectory: true).appendingPathComponent("chat-rooms.json"))
    }
    private struct Snapshot: Codable { let version: Int; let rooms: [ChatRoom] }
    func load() throws -> [ChatRoom] {
        guard FileManager.default.fileExists(atPath: url.path) else { return [] }
        let snapshot = try JSONDecoder().decode(Snapshot.self, from: Data(contentsOf: url))
        guard snapshot.version == 1, Set(snapshot.rooms.map(\.id)).count == snapshot.rooms.count,
              snapshot.rooms.allSatisfy({ $0.messages.allSatisfy { ["user", "assistant"].contains($0.role) } }) else {
            throw DashboardError(message: "채팅 기록의 형식이 올바르지 않습니다.")
        }
        return snapshot.rooms.sorted { $0.updatedAt > $1.updatedAt }
    }
    func save(_ rooms: [ChatRoom]) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true,
                                               attributes: [.posixPermissions: 0o700])
        let data = try JSONEncoder().encode(Snapshot(version: 1, rooms: rooms))
        try data.write(to: url, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }
}

struct ChatRoomsView: View {
    @EnvironmentObject private var dashboard: Dashboard
    @Environment(\.dismiss) private var dismiss
    @State private var rooms: [ChatRoom] = []
    @State private var selectedID: UUID?
    @State private var loading = true
    @State private var storageError: String?
    @State private var sendError: String?
    @State private var draft = ""
    @State private var rawMessageIDs = Set<UUID>()
    @State private var maxTokens = "1024"
    @State private var sending = false
    @State private var acknowledgedModels = Set<String>()
    @State private var approvalMessage: String?
    @State private var approvalRoomID: UUID?
    @State private var retest = false
    @State private var contextInfo = "전송 전에 전체 문맥과 최대 출력 예산을 검사합니다. 토큰 수는 추정치입니다."
    private let store = ChatRoomStore.application

    private var selectedIndex: Int? { rooms.firstIndex { $0.id == selectedID } }
    private var activeRoom: ChatRoom? { selectedIndex.map { rooms[$0] } }
    private var activeModels: [APIModel] {
        selectableModels(for: activeRoom?.provider ?? .openai)
    }
    private var readyProviders: [Provider] {
        Provider.allCases.filter { !selectableModels(for: $0).isEmpty }
    }

    private func selectableModels(for provider: Provider) -> [APIModel] {
        (dashboard.states[provider]?.models ?? []).filter { model in
            validation(model, provider) != .unsupported
        }
    }
    private func validation(_ model: APIModel, _ provider: Provider) -> ChatValidation {
        ChatValidation.status(model: model, result: dashboard.healthHistory[provider.rawValue + ":" + model.id])
    }

    var body: some View {
        NavigationSplitView {
            VStack(spacing: 0) {
                HStack {
                    Text("채팅방").font(.title3.bold())
                    Spacer()
                    Button(action: createRoom) { Image(systemName: "square.and.pencil") }
                        .help("새 채팅방")
                    Button(role: .destructive, action: deleteSelected) { Image(systemName: "trash") }
                        .disabled(activeRoom == nil || sending).help("선택한 채팅방 삭제")
                }.padding()
                List(selection: $selectedID) {
                    ForEach(rooms) { room in
                        VStack(alignment: .leading, spacing: 5) {
                            Text(room.title).lineLimit(1)
                            Text(room.messages.last?.content ?? "대화를 시작하세요")
                                .font(.caption).foregroundStyle(.secondary).lineLimit(1)
                            Text("\(room.provider.name) · \(room.model.isEmpty ? "모델 선택 필요" : room.model)")
                                .font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                        }.padding(.vertical, 5).tag(room.id)
                    }
                }.listStyle(.sidebar).disabled(sending)
                if let storageError { Text(storageError).font(.caption).foregroundStyle(.red).padding() }
            }.navigationSplitViewColumnWidth(min: 230, ideal: 270)
        } detail: {
            if let index = selectedIndex {
                conversation(index: index)
            } else {
                VStack(spacing: 12) {
                    Image(systemName: "bubble.left.and.bubble.right").font(.largeTitle).foregroundStyle(.secondary)
                    Text("채팅방을 선택하세요").font(.title2.bold())
                    Text("새 채팅방을 만들면 Provider를 바꿔가며 대화를 이어갈 수 있습니다.").foregroundStyle(.secondary)
                }.frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .frame(width: 1060, height: 760)
        .toolbar { ToolbarItem(placement: .confirmationAction) { Button("닫기") { dismiss() }.disabled(sending) } }
        .task { loadRooms() }
        .interactiveDismissDisabled(sending)
        .sheet(isPresented: $retest) {
            if let room = activeRoom { HealthChecksView(initialProvider: room.provider, targetModelIDs: [room.model]).environmentObject(dashboard) }
        }
        .alert("호환성·문맥 및 과금 안내", isPresented: Binding(get: { approvalMessage != nil }, set: { if !$0 { approvalMessage = nil } })) {
            Button("취소", role: .cancel) { approvalMessage = nil }
            Button("확인하고 전송") {
                approvalMessage = nil
                if let index = rooms.firstIndex(where: { $0.id == approvalRoomID }) {
                    acknowledgedModels.insert(rooms[index].provider.rawValue + ":" + rooms[index].model)
                    send(index: index, approved: true)
                }
            }
        } message: { Text(approvalMessage ?? "") }
        .alert("메시지를 보내지 못했습니다", isPresented: Binding(get: { sendError != nil }, set: { if !$0 { sendError = nil } })) {
            Button("확인", role: .cancel) { sendError = nil }
        } message: { Text(sendError ?? "요청을 완료하지 못했습니다.") }
    }

    @ViewBuilder private func conversation(index: Int) -> some View {
        let room = rooms[index]
        VStack(spacing: 12) {
            HStack {
                TextField("채팅방 이름", text: Binding(get: { rooms[index].title }, set: { rooms[index].title = $0; persist() }))
                    .font(.title2.bold()).textFieldStyle(.plain)
                Spacer()
                Picker("Provider", selection: Binding(get: { rooms[index].provider }, set: { selectProvider($0, at: index) })) {
                    ForEach(readyProviders, id: \.self) { Text($0.name).tag($0) }
                }.frame(width: 210)
                Picker("모델", selection: Binding(get: { rooms[index].model }, set: { rooms[index].model = $0; rooms[index].updatedAt = Date(); persist() })) {
                    ForEach(activeModels) { model in Text(model.name + " · " + validation(model, room.provider).rawValue).tag(model.id) }
                }.frame(width: 280)
            }.disabled(sending)
            TextField("이 채팅방의 system prompt (선택)", text: Binding(get: { rooms[index].systemPrompt }, set: { rooms[index].systemPrompt = $0; persist() }))
                .textFieldStyle(.roundedBorder).disabled(sending)
            if let model = activeModels.first(where: { $0.id == room.model }) {
                HStack {
                    Text(validation(model, room.provider).rawValue + " · " + (dashboard.healthHistory[room.provider.rawValue + ":" + room.model]?.reason ?? "호환성 미검증 · 실제 과금 가능"))
                        .font(.caption).foregroundStyle(.secondary)
                    Spacer()
                    Button("모델 재검사…") { retest = true }.disabled(sending || dashboard.healthRunning)
                }
            }
            Text(contextInfo).font(.caption2).foregroundStyle(.secondary).textSelection(.enabled)
            if readyProviders.isEmpty {
                VStack(spacing: 8) {
                    Label("텍스트 채팅 후보가 없습니다", systemImage: "checkmark.seal").font(.headline)
                    Text("Provider를 연결하고 모델 목록을 조회하세요. 미검사 텍스트 후보도 안내 확인 후 선택할 수 있습니다.")
                        .font(.caption).foregroundStyle(.secondary)
                }.frame(maxWidth: .infinity).padding(12)
            } else if activeModels.isEmpty {
                    Label("이 Provider에는 텍스트 채팅 후보가 없습니다. 모델 목록을 새로고침하세요.", systemImage: "info.circle")
                        .font(.caption).foregroundStyle(.secondary).frame(maxWidth: .infinity, alignment: .leading)
            }
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 14) {
                        ForEach(room.messages) { message in
                            messageView(message).id(message.id)
                        }
                        if sending { HStack { ProgressView().controlSize(.small); Text("응답 생성 중…").foregroundStyle(.secondary) } }
                    }.frame(maxWidth: .infinity, alignment: .leading).padding()
                }.background(.quaternary.opacity(0.22), in: RoundedRectangle(cornerRadius: 12))
                    .onChange(of: rooms[index].messages.count) { _ in
                        if let last = rooms[index].messages.last { proxy.scrollTo(last.id, anchor: .bottom) }
                    }
            }
            HStack(spacing: 12) {
                TextField("메시지 입력", text: $draft, axis: .vertical).lineLimit(2...6)
                    .textFieldStyle(.roundedBorder).disabled(sending).onSubmit { send(index: index) }
                Button(action: { send(index: index) }) {
                    Image(systemName: "paperplane.fill").frame(width: 22, height: 22)
                }.buttonStyle(.borderedProminent).disabled(!canSend(index: index))
            }
            HStack {
                Text("Provider를 바꿔도 이 방의 이전 메시지를 문맥으로 전송합니다. 실제 API 요금이 발생합니다.")
                    .font(.caption).foregroundStyle(.secondary)
                Spacer()
                TextField("최대 출력 토큰", text: $maxTokens).frame(width: 125).disabled(sending)
            }
        }.padding(20)
    }

    private func messageView(_ message: ChatMessage) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(message.role == "user" ? "나" : "AI").font(.caption.bold())
                if let provider = message.provider, let model = message.model {
                    Text("· \(provider.name) / \(model)").font(.caption2).foregroundStyle(.secondary)
                }
                if let input = message.inputTokens, let output = message.outputTokens {
                    Text("· 토큰 \(input)/\(output)").font(.caption2).foregroundStyle(.secondary)
                }
                if message.failed { Text("전송 실패").font(.caption2).foregroundStyle(.red) }
                Spacer()
                if message.role == "assistant" {
                    Button(rawMessageIDs.contains(message.id) ? "미리보기" : "원문") {
                        if rawMessageIDs.contains(message.id) { rawMessageIDs.remove(message.id) }
                        else { rawMessageIDs.insert(message.id) }
                    }.buttonStyle(.link).font(.caption)
                }
                Text(message.createdAt.formatted(date: .omitted, time: .shortened)).font(.caption2).foregroundStyle(.tertiary)
            }
            Group {
                if message.role == "assistant" && !rawMessageIDs.contains(message.id) {
                    MarkdownPreview(source: message.content)
                } else {
                    Text(message.content)
                }
            }.textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                .padding(11).background(message.role == "user" ? Color.accentColor.opacity(0.13) : Color.secondary.opacity(0.1),
                                        in: RoundedRectangle(cornerRadius: 10))
        }
    }

    private func canSend(index: Int) -> Bool {
        guard !sending, !dashboard.healthRunning, storageError == nil, dashboard.ready, index < rooms.count,
              dashboard.states[rooms[index].provider]?.busy == false,
              !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              let count = Int(maxTokens), (1...32768).contains(count), !activeModels.isEmpty,
              activeModels.contains(where: { $0.id == rooms[index].model }) else { return false }
        return true
    }

    private func send(index: Int, approved: Bool = false) {
        guard canSend(index: index) else { return }
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        if !approved {
            let room = rooms[index]
            let messages = conversationMessages(room.messages) + [["role": "user", "content": text]]
            sending = true
            dashboard.states[room.provider]?.busy = true
            Task { @MainActor in
                do {
                    let data = try await dashboard.transport(["method": "chat.preflight", "provider": room.provider.rawValue,
                        "request": ["model": room.model, "system": room.systemPrompt, "messages": messages, "maxOutputTokens": Int(maxTokens) ?? 1024]])
                    let context = try JSONDecoder().decode(ContextAssessment.self, from: data)
                    contextInfo = context.warning
                    sending = false; dashboard.states[room.provider]?.busy = false
                    guard let current = rooms.firstIndex(where: { $0.id == room.id }), selectedID == room.id else { return }
                    if context.status == "exceeded" { sendError = "문맥 또는 출력 한도 초과 위험으로 전송을 중단했습니다. 출력 예산을 줄이거나 더 큰 문맥 모델을 선택하세요.\n" + context.warning; return }
                    let state = activeModels.first(where: { $0.id == room.model }).map { validation($0, room.provider) } ?? .unsupported
                    let unverified = state.requiresConsent(acknowledged: acknowledgedModels.contains(room.provider.rawValue + ":" + room.model))
                    if unverified || context.status != "within_estimate" {
                        approvalRoomID = room.id
                        approvalMessage = (unverified ? "이 모델은 \(state.rawValue) 상태로 호환성을 보장하지 않습니다. " : "") + "실제 API 과금이 발생할 수 있습니다.\n" + context.warning
                    } else { send(index: current, approved: true) }
                } catch { sending = false; dashboard.states[room.provider]?.busy = false; sendError = error.localizedDescription }
            }
            return
        }
        draft = ""
        rooms[index].messages.append(ChatMessage(role: "user", content: text, provider: rooms[index].provider, model: rooms[index].model))
        if rooms[index].title == "새 채팅방" { rooms[index].title = String(text.prefix(48)) }
        rooms[index].updatedAt = Date()
        do { try store.save(rooms) }
        catch { storageError = "메시지를 로컬에 저장하지 못해 전송하지 않았습니다. 디스크 공간과 파일 권한을 확인해주세요."; return }
        let roomID = rooms[index].id
        let provider = rooms[index].provider
        let model = rooms[index].model
        let system = rooms[index].systemPrompt
        let messages = conversationMessages(rooms[index].messages)
        let tokenLimit = Int(maxTokens) ?? 1024
        sending = true
        dashboard.states[provider]?.busy = true
        Task { @MainActor in
            defer { sending = false; dashboard.states[provider]?.busy = false }
            do {
                let data = try await dashboard.transport(["method": "chat", "provider": provider.rawValue,
                    "request": ["model": model, "system": system, "messages": messages, "maxOutputTokens": tokenLimit]])
                let result = try JSONDecoder().decode(ChatResult.self, from: data)
                guard let roomIndex = rooms.firstIndex(where: { $0.id == roomID }) else { return }
                rooms[roomIndex].messages.append(ChatMessage(role: "assistant", content: result.text, provider: provider, model: model,
                                                             inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens))
                rooms[roomIndex].updatedAt = Date()
                do { try store.save(rooms) }
                catch { storageError = "응답은 도착했지만 채팅 기록 저장에 실패했습니다." }
            } catch {
                guard let roomIndex = rooms.firstIndex(where: { $0.id == roomID }),
                      let messageIndex = rooms[roomIndex].messages.lastIndex(where: { $0.role == "user" && $0.content == text }) else { return }
                rooms[roomIndex].messages[messageIndex].failed = true
                try? store.save(rooms)
                sendError = error.localizedDescription
            }
        }
    }

    private func loadRooms() {
        guard loading else { return }
        defer { loading = false }
        do { rooms = try store.load(); selectedID = rooms.first?.id }
        catch { storageError = "채팅 기록을 읽지 못했습니다. 기존 파일을 보존했으며 채팅을 시작하지 않습니다." }
    }
    private func createRoom() {
        guard !sending, storageError == nil else { return }
        let provider = readyProviders.first ?? .openai
        let model = selectableModels(for: provider).first?.id ?? ""
        rooms.insert(ChatRoom(provider: provider, model: model), at: 0)
        selectedID = rooms[0].id
        persist()
    }
    private func deleteSelected() {
        guard !sending, let index = selectedIndex else { return }
        let removed = rooms.remove(at: index)
        do {
            try store.save(rooms)
            selectedID = rooms.first?.id
        } catch {
            rooms.insert(removed, at: index)
            storageError = "채팅방을 삭제하지 못했습니다. 저장 공간과 파일 권한을 확인해주세요."
        }
    }
    private func selectProvider(_ provider: Provider, at index: Int) {
        rooms[index].provider = provider
        rooms[index].model = selectableModels(for: provider).first?.id ?? ""
        rooms[index].updatedAt = Date(); persist()
    }
    private func persist() {
        do { try store.save(rooms); storageError = nil }
        catch { storageError = "채팅 내용을 저장하지 못했습니다. 현재 변경사항은 앱을 닫으면 사라질 수 있습니다." }
    }
}
