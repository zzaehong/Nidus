import SwiftUI
import WebKit

/// One file or folder of the Vault, as the Library shows it.
struct LibraryNode: Identifiable, Hashable {
    let url: URL
    let isDirectory: Bool
    var children: [LibraryNode]?
    var id: URL { url }
    var name: String { url.lastPathComponent }

    enum Kind { case markdown, html, text, image, other }
    var kind: Kind {
        switch url.pathExtension.lowercased() {
        case "md", "markdown": return .markdown
        case "html", "htm": return .html
        case "txt", "json", "csv", "yaml", "yml", "py", "js", "ts", "swift", "sh", "css", "xml", "toml": return .text
        case "png", "jpg", "jpeg", "gif", "webp", "svg", "heic", "bmp", "tiff": return .image
        default: return .other
        }
    }
}

/// The Vault as a tree of notes, and the one that is open. Read-only: the user edits in Obsidian
/// (or any editor); here the notes and the team's results are read, and links between them followed.
@MainActor
final class LibraryModel: ObservableObject {
    @Published private(set) var root: URL?
    @Published private(set) var tree: [LibraryNode] = []
    @Published private(set) var selected: LibraryNode?
    @Published private(set) var text = ""
    @Published var problem: String?
    @Published private(set) var loading = false
    /// Notes by lower-cased name without extension, for wiki links.
    private var byName: [String: URL] = [:]

    func open(root path: String) async {
        let url = URL(fileURLWithPath: path).standardizedFileURL
        if root != url { root = url; selected = nil; text = "" }
        await refresh()
    }

    /// Reads the tree again (the AI team or another app may have added notes).
    func refresh() async {
        guard let root else { return }
        loading = true
        let scanned = await Task.detached(priority: .userInitiated) { LibraryModel.scan(root) }.value
        tree = scanned.nodes
        byName = scanned.names
        loading = false
        // An open note that changed on disk is read again.
        if let selected, let current = try? String(contentsOf: selected.url, encoding: .utf8), current != text { text = current }
    }

    nonisolated static func scan(_ root: URL) -> (nodes: [LibraryNode], names: [String: URL]) {
        var names: [String: URL] = [:], count = 0
        func children(of directory: URL, depth: Int) -> [LibraryNode] {
            guard depth < 12, count < 20_000, let items = try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: [.isDirectoryKey, .isSymbolicLinkKey], options: [.skipsHiddenFiles]) else { return [] }
            var nodes: [LibraryNode] = []
            for item in items {
                let values = try? item.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
                // Links are not followed: the Library stays inside the Vault.
                if values?.isSymbolicLink == true { continue }
                count += 1
                if values?.isDirectory == true {
                    nodes.append(LibraryNode(url: item, isDirectory: true, children: children(of: item, depth: depth + 1)))
                } else {
                    nodes.append(LibraryNode(url: item, isDirectory: false, children: nil))
                    let key = item.deletingPathExtension().lastPathComponent.lowercased()
                    if names[key] == nil || item.pathExtension.lowercased() == "md" { names[key] = item }
                    names[item.lastPathComponent.lowercased()] = names[item.lastPathComponent.lowercased()] ?? item
                }
            }
            return nodes.sorted { a, b in a.isDirectory != b.isDirectory ? a.isDirectory : a.name.localizedStandardCompare(b.name) == .orderedAscending }
        }
        return (children(of: root, depth: 0), names)
    }

    /// Opens a file for reading.
    func select(_ node: LibraryNode?) {
        guard node?.url != selected?.url else { return }
        selected = node
        text = ""; problem = nil
        guard let node, !node.isDirectory, [.markdown, .html, .text].contains(node.kind) else { return }
        do {
            let size = (try node.url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
            guard size <= 4_000_000 else { problem = "파일이 너무 큽니다(4MB 초과). Finder에서 여세요."; return }
            text = try String(contentsOf: node.url, encoding: .utf8)
        } catch { problem = "파일을 읽지 못했습니다: \(error.localizedDescription)" }
    }

    /// A vault-relative path (from a link or a search hit); ".md" may be left off.
    @discardableResult
    func select(path relative: String) -> Bool {
        guard let root else { return false }
        for candidate in [relative, relative + ".md"] {
            let url = root.appendingPathComponent(candidate).standardizedFileURL
            if url.path.hasPrefix(root.path + "/"), FileManager.default.fileExists(atPath: url.path) { select(LibraryNode(url: url, isDirectory: false, children: nil)); return true }
        }
        // The folder may be wrong while the name is right (a link written from memory).
        if let found = note(named: (relative as NSString).lastPathComponent) { select(LibraryNode(url: found, isDirectory: false, children: nil)); return true }
        problem = "\"\(relative)\" 파일이 Vault에 없습니다. AI가 만들었다고 한 파일이라면, 실제로 만들어진 파일은 \(root.lastPathComponent)/Nidus/Projects 폴더에 있습니다."
        return false
    }

    // MARK: links and images

    func note(named target: String) -> URL? {
        let name = (target.split(separator: "#", maxSplits: 1).first.map(String.init) ?? target).trimmingCharacters(in: .whitespaces)
        if let root, name.contains("/") {
            for candidate in [name, name + ".md"] {
                let url = root.appendingPathComponent(candidate).standardizedFileURL
                if url.path.hasPrefix(root.path + "/"), FileManager.default.fileExists(atPath: url.path) { return url }
            }
        }
        return byName[name.lowercased()]
    }

    /// An image named in a note as a data URI: relative to the note, to the Vault, or by name.
    func imageData(_ path: String) -> String? {
        guard let root, let selected else { return nil }
        let candidates = [selected.url.deletingLastPathComponent().appendingPathComponent(path), root.appendingPathComponent(path)].map(\.standardizedFileURL) + [byName[(path as NSString).lastPathComponent.lowercased()]].compactMap { $0 }
        for url in candidates where url.path.hasPrefix(root.path + "/") {
            guard LibraryNode(url: url, isDirectory: false, children: nil).kind == .image, let data = try? Data(contentsOf: url), data.count <= 6_000_000 else { continue }
            let type = ["png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "gif": "image/gif", "webp": "image/webp", "svg": "image/svg+xml", "bmp": "image/bmp", "tiff": "image/tiff", "heic": "image/heic"][url.pathExtension.lowercased()] ?? "application/octet-stream"
            return "data:\(type);base64,\(data.base64EncodedString())"
        }
        return nil
    }

    func previewHTML() -> String {
        guard let selected else { return "" }
        var context = MarkdownHTML.Context()
        context.image = { [weak self] in self?.imageData($0) }
        context.noteExists = { [weak self] in self?.note(named: $0) != nil }
        let body = selected.kind == .markdown ? MarkdownHTML.render(text, context) : "<pre><code>\(MarkdownHTML.escape(text))</code></pre>"
        return MarkdownHTML.page(body: body, title: selected.name)
    }

    /// A link clicked in a preview: a wiki link or a relative link opens the note, a web link the browser.
    func follow(_ url: URL) {
        if url.scheme == "nidus-wiki" {
            let target = String(url.absoluteString.dropFirst("nidus-wiki:".count)).removingPercentEncoding ?? ""
            if let found = note(named: target) { select(LibraryNode(url: found, isDirectory: false, children: nil)) }
            else { problem = "\"\(target)\" 노트가 없습니다." }
        } else if url.scheme == "http" || url.scheme == "https" || url.scheme == "mailto" {
            NSWorkspace.shared.open(url)
        } else if let root, let selected {
            // A relative link in a note (about:blank/… or file:…): resolved against the note's folder.
            let relative = (url.scheme == "file" ? url.path : url.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))).removingPercentEncoding ?? url.path
            let target = url.scheme == "file" ? url.standardizedFileURL : selected.url.deletingLastPathComponent().appendingPathComponent(relative).standardizedFileURL
            if target.path.hasPrefix(root.path + "/"), FileManager.default.fileExists(atPath: target.path) { select(LibraryNode(url: target, isDirectory: false, children: nil)) }
        }
    }
}

/// A web view for previews. Scripts and anything loaded from the network are off unless allowed.
struct WebPreview: NSViewRepresentable {
    enum Content: Equatable {
        case html(String)
        case file(URL, root: URL)
    }
    let content: Content
    var allowActive = false
    let onLink: (URL) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(onLink: onLink) }

    func makeNSView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = allowActive
        configuration.websiteDataStore = .nonPersistent()
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.navigationDelegate = context.coordinator
        view.setValue(false, forKey: "drawsBackground")
        context.coordinator.prepare(view, blockNetwork: !allowActive) { [content] in context.coordinator.show(content, in: view) }
        return view
    }

    func updateNSView(_ view: WKWebView, context: Context) {
        context.coordinator.onLink = onLink
        context.coordinator.show(content, in: view)
    }

    final class Coordinator: NSObject, WKNavigationDelegate {
        var onLink: (URL) -> Void
        private var shown: Content?
        private var ready = false
        init(onLink: @escaping (URL) -> Void) { self.onLink = onLink }

        /// Blocks every http(s) load of the page (images, styles, frames) before anything is shown.
        func prepare(_ view: WKWebView, blockNetwork: Bool, then: @escaping () -> Void) {
            guard blockNetwork else { ready = true; then(); return }
            let rules = "[{\"trigger\":{\"url-filter\":\"^https?://\"},\"action\":{\"type\":\"block\"}}]"
            WKContentRuleListStore.default().compileContentRuleList(forIdentifier: "nidus-library-offline", encodedContentRuleList: rules) { [weak self] list, _ in
                if let list { view.configuration.userContentController.add(list) }
                self?.ready = true
                then()
            }
        }

        func show(_ content: Content, in view: WKWebView) {
            guard ready, content != shown else { return }
            shown = content
            switch content {
            case .html(let html): view.loadHTMLString(html, baseURL: nil)
            case .file(let url, let root): view.loadFileURL(url, allowingReadAccessTo: root)
            }
        }

        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            if action.navigationType == .linkActivated, let url = action.request.url {
                // In-page anchors of an HTML file stay in the page.
                if url.scheme == "file", url.fragment != nil, url.path == webView.url?.path { decisionHandler(.allow); return }
                decisionHandler(.cancel)
                onLink(url)
            } else {
                decisionHandler(.allow)
            }
        }
    }
}

/// The tree's rows. A folder opens and closes on a click anywhere in its row, not only on the
/// triangle, and is never "selected"; a file row selects the file, and only files are highlighted.
/// (The List's own selection is not used: it would highlight folders too.)
private struct TreeRows: View {
    let nodes: [LibraryNode]
    @Binding var expanded: Set<URL>
    let selected: URL?
    /// While a name filter is on, every folder with a match stays open.
    let forceOpen: Bool
    let aiFolder: String
    let icon: (LibraryNode) -> String
    let onSelect: (LibraryNode) -> Void

    var body: some View {
        ForEach(nodes) { node in
            if node.isDirectory {
                DisclosureGroup(isExpanded: Binding(
                    get: { forceOpen || expanded.contains(node.url) },
                    set: { open in if open { expanded.insert(node.url) } else { expanded.remove(node.url) } }
                )) {
                    TreeRows(nodes: node.children ?? [], expanded: $expanded, selected: selected, forceOpen: forceOpen, aiFolder: aiFolder, icon: icon, onSelect: onSelect)
                } label: {
                    Button { if expanded.contains(node.url) { expanded.remove(node.url) } else { expanded.insert(node.url) } } label: {
                        label(node).frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            } else {
                Button { onSelect(node) } label: {
                    label(node).frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
                        .padding(.horizontal, 6).padding(.vertical, 3)
                        .background(RoundedRectangle(cornerRadius: 5).fill(selected == node.url ? Color.accentColor.opacity(0.22) : .clear))
                        .padding(.horizontal, -6).padding(.vertical, -3)
                }
                .buttonStyle(.plain)
            }
        }
    }

    private func label(_ node: LibraryNode) -> some View {
        Label {
            Text(node.isDirectory ? node.name : (node.kind == .markdown ? node.url.deletingPathExtension().lastPathComponent : node.name)).lineLimit(1)
        } icon: {
            Image(systemName: icon(node)).foregroundStyle(node.isDirectory && node.name == aiFolder ? Color.accentColor : .secondary)
        }
        .help(node.isDirectory && node.name == aiFolder ? "AI 팀이 쓴 문서가 모이는 폴더입니다" : node.name)
    }
}

/// The Library tab: the Vault's notes as a tree, with a read-only preview (Markdown rendered,
/// HTML shown as a page). Main's answers link the files that hold results; the links open here.
struct LibraryView: View {
    @EnvironmentObject private var store: VaultStore
    @EnvironmentObject private var session: WorkspaceSession
    @StateObject private var model = LibraryModel()

    /// The note that was open last, as a path in the Vault: opened again next time.
    @AppStorage("libraryLast") private var last = ""
    @State private var filter = ""
    @State private var hits: [(path: String, line: String)]?
    @State private var searching = false
    @State private var allowActive = false
    @State private var rendered = ""
    @State private var renderTask: Task<Void, Never>?
    /// Folders the user opened. A folder on the way to the open note is opened for them.
    @State private var expanded: Set<URL> = []

    private var aiFolder: String { "Nidus" }

    var body: some View {
        GeometryReader { proxy in
            HStack(spacing: 0) {
                // The tree keeps a modest share; the note gets the rest.
                sidebar.frame(width: min(280, max(180, proxy.size.width * 0.26)))
                Divider()
                detail.frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .task(id: store.vault) {
            guard let vault = store.vault else { return }
            await model.open(root: vault)
            if let requested = store.libraryRequest { store.libraryRequest = nil; model.select(path: requested) }
            else if model.selected == nil, !last.isEmpty { _ = model.select(path: last) }
            await session.attach(vault)
        }
        // A link asked for a file while this tab was already open.
        .onChange(of: store.libraryRequest) { requested in
            guard let requested else { return }
            store.libraryRequest = nil
            Task { await model.refresh(); model.select(path: requested) }
        }
        .onChange(of: session.project?.knowledge) { _ in Task { await model.refresh() } }
        .onChange(of: model.selected) { node in
            allowActive = false; render(now: true)
            // The folders above the open note are opened, so it is visible in the tree.
            if let node, let root = model.root {
                var folder = node.url.deletingLastPathComponent().standardizedFileURL
                while folder.path.hasPrefix(root.path + "/") { expanded.insert(folder); folder = folder.deletingLastPathComponent().standardizedFileURL }
            }
            if let node, !node.isDirectory, let root = model.root, node.url.path.hasPrefix(root.path + "/") { last = String(node.url.path.dropFirst(root.path.count + 1)) }
        }
        .onChange(of: model.text) { _ in render(now: true) }
    }

    private func find(_ url: URL, in nodes: [LibraryNode]) -> LibraryNode? {
        for node in nodes {
            if node.url == url { return node }
            if let children = node.children, let found = find(url, in: children) { return found }
        }
        return nil
    }

    private func render(now: Bool) {
        renderTask?.cancel()
        renderTask = Task { if !Task.isCancelled { rendered = model.previewHTML() } }
    }

    // MARK: sidebar

    private func filtered(_ nodes: [LibraryNode]) -> [LibraryNode] {
        let query = filter.trimmingCharacters(in: .whitespaces).lowercased()
        guard !query.isEmpty else { return nodes }
        return nodes.compactMap { node in
            if node.isDirectory {
                let kept = filtered(node.children ?? [])
                return kept.isEmpty ? nil : LibraryNode(url: node.url, isDirectory: true, children: kept)
            }
            return node.name.lowercased().contains(query) ? node : nil
        }
    }

    private var sidebar: some View {
        VStack(spacing: 0) {
            HStack(spacing: 6) {
                Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                TextField("이름 거르기 · ⏎ 내용 검색", text: $filter).textFieldStyle(.plain).onSubmit(search)
                if !filter.isEmpty || hits != nil { Button { filter = ""; hits = nil } label: { Image(systemName: "xmark.circle.fill") }.buttonStyle(.plain).foregroundStyle(.secondary) }
            }
            .padding(8)
            Divider()
            if let hits {
                List {
                    Section(searching ? "찾는 중…" : "내용 검색 결과 \(hits.count)개") {
                        ForEach(hits, id: \.path) { hit in
                            Button { model.select(path: hit.path) } label: {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(hit.path).font(.callout).lineLimit(1).truncationMode(.head)
                                    Text(hit.line).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                                }
                            }.buttonStyle(.plain)
                        }
                    }
                }.listStyle(.sidebar)
            } else {
                List {
                    TreeRows(nodes: filtered(model.tree), expanded: $expanded, selected: model.selected?.url, forceOpen: !filter.trimmingCharacters(in: .whitespaces).isEmpty, aiFolder: aiFolder, icon: icon) { node in
                        model.select(node)
                    }
                }
                .listStyle(.sidebar)
            }
            Divider()
            HStack {
                Text("읽기 전용 · 고치기는 Obsidian에서").font(.caption).foregroundStyle(.secondary)
                Spacer()
                if model.loading { ProgressView().controlSize(.small) }
                Button { Task { await model.refresh() } } label: { Image(systemName: "arrow.clockwise") }.help("다시 읽기")
            }
            .buttonStyle(.borderless).padding(8)
        }
    }

    private func icon(_ node: LibraryNode) -> String {
        if node.isDirectory { return node.name == aiFolder ? "sparkles.rectangle.stack" : "folder" }
        switch node.kind {
        case .markdown: return "doc.text"
        case .html: return "globe"
        case .image: return "photo"
        case .text: return "doc.plaintext"
        case .other: return "doc"
        }
    }

    private func search() {
        let query = filter.trimmingCharacters(in: .whitespaces)
        guard query.count >= 2 else { return }
        searching = true; hits = []
        Task {
            if let result = try? await session.send("librarySearch", ["query": query]), let list = result["hits"] as? [[String: Any]] {
                hits = list.compactMap { item in (item["path"] as? String).map { (path: $0, line: item["line"] as? String ?? "") } }
            }
            searching = false
        }
    }

    // MARK: detail

    @ViewBuilder
    private var detail: some View {
        if let node = model.selected, !node.isDirectory {
            VStack(spacing: 0) {
                toolbar(node)
                Divider()
                if let problem = model.problem {
                    Label(problem, systemImage: "exclamationmark.triangle").font(.callout).foregroundStyle(.orange).padding(8).frame(maxWidth: .infinity, alignment: .leading)
                }
                content(node)
            }
        } else {
            VStack(spacing: 10) {
                if let problem = model.problem {
                    Label(problem, systemImage: "exclamationmark.triangle").font(.callout).foregroundStyle(.orange).multilineTextAlignment(.center).padding(.bottom, 8)
                }
                Image(systemName: "books.vertical").font(.system(size: 40)).foregroundStyle(.tertiary)
                Text("Library").font(.title2)
                Text("이 Vault의 노트를 읽는 곳입니다. 왼쪽에서 문서를 고르면 미리보기로 열립니다(Markdown·HTML). 고치는 것은 Obsidian에서 하세요.\nAI 팀이 쓴 문서는 \(aiFolder) 폴더에 모이고, Main의 답에 있는 링크를 누르면 그 문서가 여기서 열립니다.")
                    .multilineTextAlignment(.center).foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private func toolbar(_ node: LibraryNode) -> some View {
        HStack(spacing: 10) {
            Text(node.kind == .markdown ? node.url.deletingPathExtension().lastPathComponent : node.name).font(.headline).lineLimit(1).truncationMode(.middle).layoutPriority(1)
            Spacer(minLength: 4)
            if node.kind == .html {
                Toggle("스크립트 허용", isOn: $allowActive).toggleStyle(.checkbox).font(.callout).fixedSize()
                    .help("꺼 두면 이 HTML의 스크립트와 인터넷에서 불러오는 것을 막습니다. 믿는 파일에서만 켜세요.")
            }
            Button { openInObsidian(node.url) } label: { Image(systemName: "pencil") }.help("Obsidian에서 열기 (없으면 기본 앱)")
            Button { NSWorkspace.shared.activateFileViewerSelecting([node.url]) } label: { Image(systemName: "folder") }.help("Finder에서 보기")
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
    }

    /// Opens the file in Obsidian, where the user keeps the Vault; otherwise in its default app.
    private func openInObsidian(_ file: URL) {
        var link = URLComponents(string: "obsidian://open")!
        link.queryItems = [URLQueryItem(name: "path", value: file.path)]
        if let url = link.url, NSWorkspace.shared.urlForApplication(toOpen: url) != nil, NSWorkspace.shared.open(url) { return }
        NSWorkspace.shared.open(file)
    }

    @ViewBuilder
    private func preview(_ node: LibraryNode) -> some View {
        if node.kind == .html, let root = model.root {
            // An HTML file is shown as the file it is, so its relative images and styles load.
            WebPreview(content: .file(node.url, root: root), allowActive: allowActive, onLink: model.follow).id("\(node.url.path)-\(allowActive)-\(model.text.hashValue)")
        } else {
            WebPreview(content: .html(rendered), onLink: model.follow).id(node.url.path)
        }
    }

    @ViewBuilder
    private func content(_ node: LibraryNode) -> some View {
        switch node.kind {
        case .markdown, .html:
            preview(node)
        case .text:
            ScrollView { Text(model.text).font(.system(.body, design: .monospaced)).textSelection(.enabled).padding(12).frame(maxWidth: .infinity, alignment: .leading) }
        case .image:
            if let image = NSImage(contentsOf: node.url) {
                ScrollView([.horizontal, .vertical]) { Image(nsImage: image).padding() }
            } else { unsupported(node) }
        case .other:
            unsupported(node)
        }
    }

    private func unsupported(_ node: LibraryNode) -> some View {
        VStack(spacing: 10) {
            Image(systemName: "doc").font(.system(size: 36)).foregroundStyle(.tertiary)
            Text("이 형식은 여기서 미리 볼 수 없습니다.").foregroundStyle(.secondary)
            Button("기본 앱으로 열기") { NSWorkspace.shared.open(node.url) }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
