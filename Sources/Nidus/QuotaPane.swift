import SwiftUI

/// Limits and use of a Gemini provider, by model. Three numbers are kept apart: the limit, what
/// this Vault's own calls used (counted here), and what Google's monitoring saw (delayed, all callers).
struct QuotaPane: View {
    @EnvironmentObject private var store: VaultStore
    let provider: ProviderInfo

    @State private var view: QuotaView?
    @State private var project = ""
    @State private var showAll = false
    @State private var refreshing = false
    @State private var settingUpCloud = false
    @State private var editing: QuotaRow?
    @AppStorage("quotaAutoRefresh") private var autoRefresh = true

    private var free: Bool { provider.tier == "free" }
    private var other: String { free ? "gemini-paid" : "gemini-free" }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                notices
                settings
                Divider()
                header
                if let view {
                    ForEach(view.errors.all, id: \.0) { name, text in ProblemLine(name: name, text: text) }
                    table(view)
                    Text("\"이 Vault\"는 Nidus가 이 Vault에서 보낸 호출만 센 값입니다. 할당량은 프로젝트 단위라, 같은 프로젝트를 쓰는 다른 앱·다른 키의 호출은 여기에 없습니다. \"Google 관측\"은 Cloud Monitoring이 프로젝트 전체에 대해 센 값이고 몇 분 늦습니다. 두 값은 더하지 않습니다. 실제로 호출이 허용되는지는 서버의 답이 기준입니다.")
                        .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                } else {
                    ProgressView().controlSize(.small)
                }
            }
            .padding(Layout.inset)
        }
        .task(id: "\(provider.id)/\(provider.connected)/\(showAll)") { await load() }
        // This Vault's own count changes with every call: re-read it often. Google's numbers are asked for less often.
        .task(id: "\(provider.id)/\(autoRefresh)") {
            var ticks = 0
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 30_000_000_000)
                if Task.isCancelled { break }
                ticks += 1
                if autoRefresh, ticks % 10 == 0, view?.project != nil, view?.auth != nil { await refresh() } else { await load() }
            }
        }
        .sheet(isPresented: $settingUpCloud) { CloudSignInSheet(auth: view?.auth, project: view?.project) { await load() } }
        .sheet(item: $editing) { row in ManualLimitSheet(row: row) { limits in Task { await saveManual(row.model, limits) } } }
    }

    // MARK: notices

    @ViewBuilder private var notices: some View {
        if let view {
            if view.migrated {
                notice(color: .blue, icon: "arrow.right.circle") {
                    Text("이전의 Gemini 연결(키, 후보 모델, 검사 결과)을 **\(provider.name)**(으)로 옮겼습니다. 이 키가 결제 계정이 연결된 프로젝트의 것이라면 호출마다 과금됩니다. 그런 경우 \(free ? "Gemini Paid" : "Gemini Free")로 옮기세요.")
                    HStack {
                        Button("\(free ? "Gemini Paid" : "Gemini Free")로 옮기기") { Task { await store.moveGemini(from: provider.id, to: other) } }
                        Button("여기가 맞습니다") { Task { await store.acknowledgeGeminiMigration(); await load() } }
                    }
                }
            }
            if let risk = view.risk {
                notice(color: .red, icon: "exclamationmark.octagon.fill") {
                    Text(risk).bold()
                    Text("Gemini Free는 과금될 수 있는 호출을 하지 않습니다. 이 키가 유료 프로젝트의 것이면 Gemini Paid로 옮기고, 아니라면 프로젝트 ID를 확인한 뒤 새로고침하세요.").font(.caption)
                    Button("Gemini Paid로 옮기기") { Task { await store.moveGemini(from: provider.id, to: other) } }
                }
            }
            ForEach(view.warnings, id: \.self) { text in
                notice(color: .orange, icon: "exclamationmark.triangle.fill") { Text(text) }
            }
            if free, view.risk == nil {
                tierLine(view)
            }
        }
    }

    /// What is known about whether this really is a free-tier project. Never claimed without evidence.
    private func tierLine(_ view: QuotaView) -> some View {
        let (icon, color, text): (String, Color, String) = {
            if let billing = view.billing, !billing.enabled { return ("checkmark.seal.fill", .green, "프로젝트에 결제 계정이 연결돼 있지 않습니다 (Cloud Billing 확인, \(clock(billing.checkedAt))). 무료 등급입니다.") }
            if let evidence = view.tierEvidence, evidence.evidence == "free" { return ("checkmark.seal", .green, "Google이 무료 등급 할당량으로 답한 적이 있습니다 (\(clock(evidence.at))).") }
            return ("questionmark.circle", .secondary, "이 키의 프로젝트가 무료 등급인지 아직 확인하지 못했습니다. 프로젝트 ID와 Google Cloud 로그인을 설정하고 새로고침하면 결제 연결 여부를 확인합니다.")
        }()
        return Label(text, systemImage: icon).font(.caption).foregroundStyle(color).fixedSize(horizontal: false, vertical: true)
    }

    private func notice<Content: View>(color: Color, icon: String, @ViewBuilder content: () -> Content) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: icon).foregroundStyle(color)
            VStack(alignment: .leading, spacing: 6) { content() }.font(.callout).fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .padding(10)
        .background(RoundedRectangle(cornerRadius: 6).fill(color.opacity(0.1)))
    }

    // MARK: settings

    private var settings: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("Google Cloud 프로젝트").frame(width: 150, alignment: .leading)
                TextField("프로젝트 ID (예: my-project-123)", text: $project).frame(maxWidth: 260)
                Button("저장") { Task { if let fresh = await store.setProviderSettings(provider.id, ["project": project.trimmingCharacters(in: .whitespaces)]) { apply(fresh) } } }
                    .disabled(project.trimmingCharacters(in: .whitespaces) == (view?.project ?? ""))
                Spacer()
            }
            Text("이 Provider의 API 키가 속한 프로젝트입니다. Free와 Paid는 서로 다른 프로젝트를 쓰세요. 할당량은 프로젝트 단위이고, 결제가 연결된 프로젝트에는 무료 할당량이 없습니다.")
                .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            HStack {
                Text("할당량 조회용 로그인").frame(width: 150, alignment: .leading)
                Text(authText).foregroundStyle(view?.auth == nil ? .secondary : .primary).lineLimit(1).truncationMode(.middle)
                Button("설정…") { settingUpCloud = true }
                Spacer()
            }
            if !free, let view {
                Toggle("무료 모델을 쓸 수 없을 때 이 유료 모델로 넘어가도 됩니다", isOn: Binding(get: { view.allowFallback }, set: { on in
                    Task { if let fresh = await store.setProviderSettings(provider.id, ["allowFallback": on]) { apply(fresh) } }
                }))
                Text("꺼 두면 Gemini Paid의 모델은 배정 칸의 첫 번째 후보일 때만 쓰입니다. 앞 후보가 속도 제한에 걸리거나 실패해도 자동으로 유료 호출로 넘어가지 않습니다.")
                    .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private var authText: String {
        guard let auth = view?.auth else { return "설정 안 됨: \"설정…\"의 안내대로 gcloud로 로그인하세요" }
        switch auth.source {
        case "adc-service-account": return "서비스 계정 \(auth.account ?? "") (환경 설정 파일)"
        case "adc-user": return "gcloud 로그인" + (auth.account.map { " (\($0))" } ?? "")
        default: return "gcloud CLI 로그인"
        }
    }

    // MARK: table

    private var header: some View {
        HStack(spacing: 10) {
            Text("모델별 할당량").font(.headline)
            if refreshing { ProgressView().controlSize(.small) }
            Spacer()
            if let view {
                Text(view.fetchedAt.map { "Google 조회 \(clock($0))" } ?? "Google에서 조회한 적 없음").font(.caption).foregroundStyle(.secondary)
                Text("하루 할당량 초기화 \(clock(view.resetAt))").font(.caption).foregroundStyle(.secondary).help("Gemini API의 하루 요청 할당량은 태평양 시간 자정에 초기화됩니다.")
            }
            Toggle("자동 갱신", isOn: $autoRefresh).toggleStyle(.checkbox).help("이 Vault의 사용량은 30초마다, Google의 값은 5분마다 다시 읽습니다.")
            Button("새로고침") { Task { await refresh() } }.disabled(refreshing || view?.project == nil)
                .help(view?.project == nil ? "먼저 프로젝트 ID를 저장하세요." : "Cloud Quotas, Cloud Monitoring, Cloud Billing에서 다시 읽습니다. 모델 호출이 아니며 요금이 들지 않습니다.")
        }
    }

    private func table(_ view: QuotaView) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 12) {
                Text("Model").frame(maxWidth: .infinity, alignment: .leading)
                Text("RPM").frame(width: 150, alignment: .leading).help("분당 요청 수")
                Text("TPM").frame(width: 150, alignment: .leading).help("분당 입력 토큰 수")
                Text("RPD").frame(width: 150, alignment: .leading).help("하루 요청 수")
                Text("Status").frame(width: 110, alignment: .leading)
            }
            .font(.caption.weight(.semibold)).foregroundStyle(.secondary).padding(.vertical, 6)
            Divider()
            if view.rows.isEmpty {
                Text("배정 칸에 넣었거나 오늘 호출한 \(provider.name) 모델이 없습니다.").foregroundStyle(.secondary).padding(.vertical, 12)
            }
            ForEach(view.rows) { row in
                HStack(alignment: .top, spacing: 12) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(row.model).font(.system(.body, design: .monospaced)).lineLimit(1).truncationMode(.middle).help(row.model)
                        Button("제한 직접 입력…") { editing = row }.buttonStyle(.link).font(.caption)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    QuotaCellView(cell: row.rpm, observedLabel: "최근 1시간 최대").frame(width: 150, alignment: .leading)
                    QuotaCellView(cell: row.tpm, observedLabel: "최근 1시간 최대").frame(width: 150, alignment: .leading)
                    QuotaCellView(cell: row.rpd, observedLabel: "오늘 합계").frame(width: 150, alignment: .leading)
                    status(row).frame(width: 110, alignment: .leading)
                }
                .padding(.vertical, 8)
                Divider()
            }
            if view.otherModels > 0 || showAll {
                Toggle(showAll ? "쓰는 모델만 보기" : "제한이 알려진 다른 모델 \(view.otherModels)개도 보기", isOn: $showAll).toggleStyle(.button).controlSize(.small).padding(.top, 8)
            }
        }
    }

    private func status(_ row: QuotaRow) -> some View {
        let (label, color): (String, Color) = row.status == "limited" ? ("Limited", .orange) : row.status == "unknown" ? ("Unknown", .secondary) : ("Available", .green)
        return VStack(alignment: .leading, spacing: 2) {
            Label(label, systemImage: row.status == "limited" ? "pause.circle.fill" : row.status == "unknown" ? "questionmark.circle" : "checkmark.circle.fill")
                .foregroundStyle(color).font(.callout)
            if let detail = row.detail { Text(detail).font(.caption2).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true) }
            if let until = row.blockedUntil { Text("\(clock(until))까지 쉼").font(.caption2).foregroundStyle(.secondary) }
            if row.status == "unknown" { Text("제한을 알 수 없음").font(.caption2).foregroundStyle(.secondary) }
        }
    }

    // MARK: actions

    private func apply(_ fresh: QuotaView) {
        view = fresh
        project = fresh.project ?? ""
    }

    private func load() async {
        if let fresh = await store.quota(provider.id, all: showAll) {
            let typing = project != (view?.project ?? "")
            view = fresh
            if !typing { project = fresh.project ?? "" }
        }
    }

    private func refresh() async {
        refreshing = true
        defer { refreshing = false }
        if await store.refreshQuota(provider.id) != nil { await load(); await store.reload() }
    }

    private func saveManual(_ model: String, _ limits: [String: Int]) async {
        var all: [String: [String: Int]] = [:]
        for (name, manual) in view?.manual ?? [:] where name != model {
            var row: [String: Int] = [:]
            if let v = manual.rpm { row["rpm"] = Int(v) }
            if let v = manual.tpm { row["tpm"] = Int(v) }
            if let v = manual.rpd { row["rpd"] = Int(v) }
            all[name] = row
        }
        if !limits.isEmpty { all[model] = limits }
        if await store.setProviderSettings(provider.id, ["limits": all]) != nil { await load() }
    }
}

/// One source's problem. When the engine put a Console link in the text (Markdown "[title](url)"), the link
/// becomes a button beside the words, so the next step is one click.
private struct ProblemLine: View {
    let name: String
    let text: String

    /// The words, and the first Markdown link lifted out of them.
    private var parts: (words: String, title: String?, url: URL?) {
        guard let open = text.range(of: "["), let mid = text.range(of: "](", range: open.upperBound..<text.endIndex), let close = text.range(of: ")", range: mid.upperBound..<text.endIndex),
              let url = URL(string: String(text[mid.upperBound..<close.lowerBound])), url.scheme == "https" else { return (text, nil, nil) }
        let title = String(text[open.upperBound..<mid.lowerBound])
        var words = text.replacingCharacters(in: open.lowerBound..<close.upperBound, with: "")
        words = words.replacingOccurrences(of: "  ", with: " ").replacingOccurrences(of: " — ", with: " ").trimmingCharacters(in: .whitespaces)
        return (words, title, url)
    }

    var body: some View {
        let (words, title, url) = parts
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Label { Text(markdown("**\(name)**: \(words)")) } icon: { Image(systemName: "exclamationmark.triangle") }
                .font(.caption).foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true)
            if let title, let url {
                Button { NSWorkspace.shared.open(url) } label: { Label(title, systemImage: "arrow.up.right.square") }
                    .buttonStyle(.borderedProminent).controlSize(.small).tint(.orange)
                    .help(url.absoluteString)
            }
            Spacer(minLength: 0)
        }
    }
}

/// Inline Markdown (bold, links) for a line the engine wrote; the plain text when it does not parse.
func markdown(_ text: String) -> AttributedString {
    (try? AttributedString(markdown: text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(text)
}

/// "2026-11-15T19:50:00.000Z" as a local time, with the date when it is not today.
func clock(_ iso: String) -> String {
    let parser = ISO8601DateFormatter()
    parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    guard let date = parser.date(from: iso) ?? ISO8601DateFormatter().date(from: iso) else { return iso }
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "ko_KR")
    formatter.dateFormat = Calendar.current.isDateInToday(date) ? "HH:mm" : "M월 d일 HH:mm"
    return formatter.string(from: date)
}

func compact(_ value: Double) -> String {
    if value >= 1_000_000 { return String(format: "%.1fM", value / 1_000_000).replacingOccurrences(of: ".0M", with: "M") }
    if value >= 10_000 { return String(format: "%.0fK", value / 1_000) }
    return String(format: "%.0f", value)
}

/// One limit: a bar of this Vault's own count against the limit, and Google's delayed count under it.
private struct QuotaCellView: View {
    let cell: QuotaCell
    let observedLabel: String

    private var sourceText: String {
        switch cell.source {
        case "cloud": return "Google"
        case "manual": return "직접 입력"
        case "server": return "서버 응답"
        default: return ""
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            if let limit = cell.limit, limit > 0 {
                ProgressView(value: min(cell.local, limit), total: limit)
                    .tint(cell.local >= limit ? .orange : .accentColor)
                Text("이 Vault \(compact(cell.local)) / \(compact(limit))").font(.caption).monospacedDigit()
                Text("제한 출처: \(sourceText)").font(.caption2).foregroundStyle(.tertiary)
            } else {
                ProgressView(value: 0, total: 1).opacity(0.35)
                Text("이 Vault \(compact(cell.local)) / Unknown").font(.caption).monospacedDigit().foregroundStyle(.secondary)
            }
            if let observed = cell.observed, let usage = observed.usage {
                Text("Google 관측 \(compact(usage))\(observed.limit.map { " / \(compact($0))" } ?? "") · \(observedLabel)\(observed.at.map { " · \(clock($0)) 기준" } ?? "")")
                    .font(.caption2).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    .help("Cloud Monitoring의 값입니다. 몇 분 늦게 들어오고, 이 프로젝트를 쓰는 모든 호출을 셉니다. 지금 남은 양이 아닙니다.")
            } else {
                Text("Google 관측 없음").font(.caption2).foregroundStyle(.tertiary)
            }
        }
    }
}

/// How to let Nidus read quotas from Google Cloud, for someone doing it the first time: gcloud's own
/// sign-in in the browser, which Nidus picks up by itself. No key file, no settings in the app.
private struct CloudSignInSheet: View {
    @Environment(\.dismiss) private var dismiss
    let auth: QuotaView.Auth?
    let project: String?
    let onChange: () async -> Void
    @State private var checking = false

    private var enableQuotasURL: URL? {
        URL(string: "https://console.cloud.google.com/apis/library/cloudquotas.googleapis.com" + (project.map { "?project=\($0)" } ?? ""))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("할당량 조회용 Google Cloud 로그인").font(.headline)
            Text("Gemini API 키로는 프로젝트의 제한과 사용량을 볼 수 없어서, Google의 명령줄 도구 gcloud로 내 Google 계정에 한 번 로그인합니다. 읽기 전용이고 모델을 호출하지 않으며 요금이 들지 않습니다. 로그인하지 않아도 모델 호출은 그대로 되고, 할당량 표의 제한만 Unknown으로 남습니다.")
                .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            current
            GroupBox("터미널에서 (한 번만, 5분)") {
                VStack(alignment: .leading, spacing: 6) {
                    step(1, "터미널 앱을 열고(Spotlight에서 \"터미널\" 검색) gcloud를 설치합니다. Homebrew가 있으면 한 줄입니다:")
                    command("brew install --cask gcloud-cli")
                    Text("Homebrew가 없으면 cloud.google.com/sdk/docs/install의 macOS 안내대로 설치합니다. 설치 뒤 터미널을 한 번 닫았다 엽니다.")
                        .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true).padding(.leading, 18)
                    step(2, "내 Google 계정으로 로그인합니다. 브라우저가 열리면 Gemini API 키를 만든 그 Google 계정을 고르고 \"허용\"을 누릅니다:")
                    command("gcloud auth application-default login")
                    Text("\"command not found: gcloud\"가 나오면 1번이 아직 안 된 것입니다. 로그인은 이 Mac에만 저장되고 만료되지 않습니다(계정 비밀번호를 바꾸거나 권한을 취소하면 다시 로그인).")
                        .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true).padding(.leading, 18)
                    step(3, "이 창의 \"다시 확인\"을 누릅니다. \"지금: gcloud 로그인 사용 중\"으로 바뀝니다.")
                }.frame(maxWidth: .infinity, alignment: .leading).padding(4)
            }
            GroupBox("Google Cloud Console에서 (브라우저, 1분)") {
                VStack(alignment: .leading, spacing: 6) {
                    step(4, "모델별 제한을 읽는 Cloud Quotas API를 이 프로젝트에서 한 번 켭니다. 아래 링크를 열고 \"사용\"을 누른 뒤 1~2분 기다려 할당량 화면의 \"새로고침\"을 누릅니다. (사용량과 결제 상태는 켤 것 없이 바로 읽힙니다.)")
                    HStack(spacing: 12) {
                        if let url = enableQuotasURL { Link(project == nil ? "Cloud Quotas API 켜기 (프로젝트는 직접 고름)" : "Cloud Quotas API 켜기", destination: url) }
                    }.font(.caption).padding(.leading, 18)
                    Text("권한: 로그인한 계정이 이 프로젝트의 소유자(직접 만든 프로젝트면 그렇습니다)면 더 할 것이 없습니다. 남이 만든 프로젝트면 관리자에게 역할 세 개를 부탁하세요: Cloud Quotas 뷰어, Monitoring 뷰어, Service Usage 소비자.")
                        .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                }.frame(maxWidth: .infinity, alignment: .leading).padding(4)
            }
            Text("할당량 화면에 주황색 줄이 남아 있으면 그 줄이 무엇이 빠졌는지와 바로 가는 링크를 알려 줍니다. 로그인 정보는 gcloud가 이 Mac의 홈 폴더에 두고, Nidus는 읽기만 하며 Vault나 로그에 남기지 않습니다.")
                .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            HStack {
                if checking { ProgressView().controlSize(.small) }
                Spacer()
                Button("닫기") { dismiss() }.keyboardShortcut(.cancelAction)
                Button("다시 확인") { Task { checking = true; await onChange(); checking = false; dismiss() } }.keyboardShortcut(.defaultAction).disabled(checking)
            }
        }
        .padding(Layout.margin)
        .frame(width: 600)
    }

    @ViewBuilder private var current: some View {
        if let auth {
            let text: String = {
                switch auth.source {
                case "adc-service-account": return "지금: 서비스 계정 \(auth.account ?? "") 사용 중 (환경 설정 파일)"
                case "adc-user": return "지금: gcloud 로그인 사용 중" + (auth.account.map { " (\($0))" } ?? "")
                default: return "지금: gcloud CLI 로그인 사용 중"
                }
            }()
            Label(text, systemImage: "checkmark.circle.fill").foregroundStyle(.green).font(.callout)
        } else {
            Label("지금: 로그인이 없습니다. 아래 1~2번을 하면 됩니다.", systemImage: "circle.dashed").foregroundStyle(.secondary).font(.callout)
        }
    }

    private func command(_ text: String) -> some View {
        Text(text).font(.system(.callout, design: .monospaced)).textSelection(.enabled)
            .padding(.horizontal, 8).padding(.vertical, 4)
            .background(RoundedRectangle(cornerRadius: 4).fill(Color.primary.opacity(0.06)))
            .padding(.leading, 18)
            .help("드래그해 복사한 뒤 터미널에 붙여 넣고 Return을 누릅니다.")
    }

    private func step(_ n: Int, _ text: String) -> some View {
        HStack(alignment: .top, spacing: 6) {
            Text("\(n).").monospacedDigit().foregroundStyle(.secondary)
            Text(text).fixedSize(horizontal: false, vertical: true)
        }.font(.callout)
    }
}

/// Limits typed by the user, for when Google gives none. An empty field means "not set".
private struct ManualLimitSheet: View {
    @Environment(\.dismiss) private var dismiss
    let row: QuotaRow
    let onSave: ([String: Int]) -> Void
    @State private var rpm = ""
    @State private var tpm = ""
    @State private var rpd = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("\(row.model) 제한 직접 입력").font(.headline).lineLimit(1).truncationMode(.middle)
            Text("Google AI Studio의 Rate limit 화면에 보이는 값을 적습니다. 직접 입력한 값은 Google에서 조회한 값보다 먼저 쓰입니다. 비워 두면 조회한 값(없으면 Unknown)을 씁니다.")
                .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            Form {
                TextField("RPM (분당 요청)", text: $rpm)
                TextField("TPM (분당 입력 토큰)", text: $tpm)
                TextField("RPD (하루 요청)", text: $rpd)
            }
            HStack {
                if let url = URL(string: "https://aistudio.google.com/rate-limit") { Link("AI Studio에서 제한 보기", destination: url) }
                Spacer()
                Button("취소", role: .cancel) { dismiss() }
                Button("저장") {
                    var limits: [String: Int] = [:]
                    for (name, text) in [("rpm", rpm), ("tpm", tpm), ("rpd", rpd)] {
                        if let value = Int(text.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: ",", with: "")), value >= 0 { limits[name] = value }
                    }
                    onSave(limits)
                    dismiss()
                }
                .buttonStyle(.borderedProminent)
            }
        }
        .padding(Layout.margin)
        .frame(width: 460)
        .onAppear {
            if row.rpm.source == "manual", let v = row.rpm.limit { rpm = String(Int(v)) }
            if row.tpm.source == "manual", let v = row.tpm.limit { tpm = String(Int(v)) }
            if row.rpd.source == "manual", let v = row.rpd.limit { rpd = String(Int(v)) }
        }
    }
}
