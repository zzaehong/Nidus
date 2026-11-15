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
                    ForEach(view.errors.all, id: \.0) { name, text in
                        Label("\(name): \(text)", systemImage: "exclamationmark.triangle").font(.caption).foregroundStyle(.orange)
                            .fixedSize(horizontal: false, vertical: true)
                    }
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
        .sheet(isPresented: $settingUpCloud) { CloudSignInSheet(auth: view?.auth) { await load() } }
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
        guard let auth = view?.auth else { return "설정 안 됨: \"설정…\"에서 Google 계정으로 로그인하세요" }
        switch auth.source {
        case "user": return "Google 계정 \(auth.account ?? "")"
        case "service-account": return "서비스 계정 \(auth.account ?? "")"
        case "adc-service-account": return "서비스 계정 \(auth.account ?? "") (환경 설정 파일)"
        case "adc-user": return "gcloud 로그인 (Application Default Credentials)"
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

/// How to let Nidus read quotas from Google Cloud, for someone doing it the first time. Three ways,
/// any one is enough: sign in with a Google account in the browser (no key, no terminal; works
/// where an organization policy forbids service account keys), a service account key file, or gcloud.
private struct CloudSignInSheet: View {
    @EnvironmentObject private var store: VaultStore
    @Environment(\.dismiss) private var dismiss
    let auth: QuotaView.Auth?
    let onChange: () async -> Void

    private enum Way: String, CaseIterable, Identifiable {
        case account, key, gcloud
        var id: String { rawValue }
        var title: String {
            switch self {
            case .account: return "Google 계정 로그인 (권장)"
            case .key: return "서비스 계정 키 파일"
            case .gcloud: return "gcloud (터미널)"
            }
        }
    }

    @State private var way: Way = .account
    @State private var choosing = false
    @State private var signingIn = false
    @State private var problem: String?

    private static let clientsURL = URL(string: "https://console.cloud.google.com/auth/clients")
    private static let overviewURL = URL(string: "https://console.cloud.google.com/auth/overview")
    private static let serviceAccountsURL = URL(string: "https://console.cloud.google.com/iam-admin/serviceaccounts")
    private static let libraryURL = URL(string: "https://console.cloud.google.com/apis/library")

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("할당량 조회용 Google Cloud 로그인").font(.headline)
            Text("Gemini API 키로는 프로젝트의 제한과 사용량을 볼 수 없습니다. 그래서 Google Cloud에 읽기 전용으로 따로 로그인합니다. 모델을 호출하지 않고 요금이 들지 않으며, 로그인하지 않아도 모델 호출은 그대로 됩니다. 아래 세 방법 중 하나면 충분합니다.")
                .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            current
            Picker("방법", selection: $way) { ForEach(Way.allCases) { Text($0.title).tag($0) } }.pickerStyle(.segmented).labelsHidden()
            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    switch way {
                    case .account: accountWay
                    case .key: keyWay
                    case .gcloud: gcloudWay
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(maxHeight: 440)
            Text("로그인 정보는 이 Mac의 Keychain에만 저장합니다. Vault 폴더나 로그에는 남기지 않고, Google의 주소로만 보냅니다.")
                .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            if let problem { Label(problem, systemImage: "exclamationmark.triangle").font(.caption).foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true) }
            HStack {
                if auth?.source == "service-account" || auth?.source == "user" {
                    Button("저장한 로그인 지우기", role: .destructive) { Task { await store.clearCloudKey(); await onChange(); dismiss() } }.disabled(signingIn)
                }
                if signingIn {
                    ProgressView().controlSize(.small)
                    Text("브라우저에서 로그인을 마치면 이 창이 닫힙니다 (최대 4분).").font(.caption).foregroundStyle(.secondary)
                } else if store.busy { ProgressView().controlSize(.small) }
                Spacer()
                Button("닫기") { dismiss() }.keyboardShortcut(.cancelAction).disabled(signingIn)
                switch way {
                case .account:
                    if auth?.source == "user" { Button("다시 로그인") { Task { await signIn(client: nil) } }.disabled(signingIn) }
                    Button("클라이언트 파일 고르고 로그인…") { problem = nil; choosing = true }.keyboardShortcut(.defaultAction).disabled(signingIn)
                case .key:
                    Button("키 파일 고르기…") { problem = nil; choosing = true }.keyboardShortcut(.defaultAction).disabled(store.busy)
                case .gcloud:
                    Button("다시 확인") { Task { await onChange(); dismiss() } }.keyboardShortcut(.defaultAction)
                }
            }
        }
        .padding(Layout.margin)
        .frame(width: 620)
        .onAppear { if auth?.source == "service-account" { way = .key } else if auth?.source == "gcloud" || auth?.source == "adc-user" { way = .gcloud } }
        .fileImporter(isPresented: $choosing, allowedContentTypes: [.json]) { result in
            guard case .success(let url) = result else { return }
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            guard let data = try? Data(contentsOf: url), data.count < 64 * 1024, let text = String(data: data, encoding: .utf8) else {
                problem = "파일을 읽지 못했습니다. Cloud Console에서 다운로드한 JSON 파일을 고르세요."
                return
            }
            if way == .account { Task { await signIn(client: text) } }
            else {
                Task {
                    if await store.setCloudKey(text) != nil { await onChange(); dismiss() }
                    else { problem = "이 파일로 로그인하지 못했습니다. 서비스 계정 키(JSON)인지, 계정이 지워지지 않았는지 확인하세요. OAuth 클라이언트 파일이라면 \"Google 계정 로그인\"에서 고르세요." }
                }
            }
        }
    }

    // MARK: now

    @ViewBuilder private var current: some View {
        if let auth {
            let text: String = {
                switch auth.source {
                case "user": return "지금: Google 계정 \(auth.account ?? "")(으)로 로그인됨"
                case "service-account", "adc-service-account": return "지금: 서비스 계정 \(auth.account ?? "") 사용 중"
                default: return "지금: gcloud 로그인 사용 중"
                }
            }()
            Label(text, systemImage: "checkmark.circle.fill").foregroundStyle(.green).font(.callout)
        } else {
            Label("지금: 로그인이 설정되지 않았습니다. 할당량 표의 제한은 Unknown으로 나옵니다.", systemImage: "circle.dashed").foregroundStyle(.secondary).font(.callout)
        }
    }

    // MARK: the three ways

    private var accountWay: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("키를 만들지 않고, 터미널도 쓰지 않습니다. 브라우저에서 내 Google 계정으로 한 번 로그인하면 됩니다. 조직 정책으로 서비스 계정 키를 만들 수 없을 때도 됩니다. 준비는 Cloud Console에서 한 번만 하면 되고 10분쯤 걸립니다.")
                .font(.callout).fixedSize(horizontal: false, vertical: true)
            GroupBox("준비 (Google Cloud Console, 브라우저에서 한 번만)") {
                VStack(alignment: .leading, spacing: 6) {
                    step(1, "console.cloud.google.com에 들어가 화면 위쪽의 프로젝트 선택에서 Gemini API 키가 속한 프로젝트를 고릅니다. 어느 프로젝트인지 모르면 AI Studio의 API 키 화면에 프로젝트 이름이 있습니다.")
                    step(2, "왼쪽 메뉴 \"API 및 서비스\" → \"OAuth 동의 화면\"(Google Auth Platform). 처음이면 \"시작하기\"를 누르고 앱 이름(예: Nidus)과 지원 이메일을 적습니다. \"대상\"은 회사·학교 Google 계정이면 \"내부\", 개인 Gmail이면 \"외부\"를 고르고, 연락처 이메일을 적은 뒤 만듭니다.")
                    step(3, "\"외부\"를 골랐다면 \"대상\" 페이지의 \"테스트 사용자\"에 내 Google 계정을 추가합니다. (외부·테스트 상태의 로그인은 7일마다 만료돼 \"다시 로그인\"을 눌러야 합니다. \"내부\"는 만료되지 않습니다.)")
                    step(4, "\"클라이언트\" → \"클라이언트 만들기\" → 애플리케이션 유형 \"데스크톱 앱\" → 이름(예: Nidus) → 만들기. 나오는 창에서 \"JSON 다운로드\"를 누릅니다. 이 파일이 아래에서 고를 클라이언트 파일입니다.")
                    step(5, "\"API 및 서비스\" → \"라이브러리\"에서 Cloud Quotas API, Cloud Monitoring API, Cloud Billing API를 찾아 각각 \"사용\"을 누릅니다.")
                    step(6, "로그인할 Google 계정에 이 프로젝트를 볼 권한이 있어야 합니다. 프로젝트를 직접 만든 소유자면 이미 충분합니다. 아니라면 관리자에게 역할 세 개를 부탁하세요: Cloud Quotas 뷰어, Monitoring 뷰어, Service Usage 소비자.")
                    HStack(spacing: 12) {
                        if let url = Self.overviewURL { Link("OAuth 동의 화면 열기", destination: url) }
                        if let url = Self.clientsURL { Link("클라이언트 페이지 열기", destination: url) }
                        if let url = Self.libraryURL { Link("API 라이브러리 열기", destination: url) }
                    }.font(.caption)
                }.frame(maxWidth: .infinity, alignment: .leading).padding(4)
            }
            GroupBox("앱에서") {
                VStack(alignment: .leading, spacing: 6) {
                    step(1, "아래 \"클라이언트 파일 고르고 로그인…\"으로 다운로드한 JSON을 고릅니다. 브라우저가 열립니다.")
                    step(2, "Google 계정을 고르고 \"허용\"을 누릅니다. \"Google에서 확인하지 않은 앱\" 경고가 나오면(외부 대상일 때 정상) \"고급\" → \"Nidus(으)로 이동\"을 누릅니다.")
                    step(3, "\"로그인됐습니다\" 페이지가 보이면 앱으로 돌아옵니다. 이 창이 닫히고, 할당량 화면에서 \"새로고침\"을 누르면 Google의 값이 들어옵니다. 다운로드한 파일은 지워도 됩니다.")
                }.frame(maxWidth: .infinity, alignment: .leading).padding(4)
            }
        }
    }

    private var keyWay: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("읽기 권한만 가진 서비스 계정을 만들고 그 키 파일을 고릅니다. 사람 계정과 상관없이 동작하고 만료되지 않지만, 회사·학교 조직의 프로젝트에서는 키 만들기가 정책으로 막혀 있는 경우가 많습니다.")
                .font(.callout).fixedSize(horizontal: false, vertical: true)
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: "hand.raised.fill").foregroundStyle(.orange)
                VStack(alignment: .leading, spacing: 4) {
                    Text("키를 만들 때 \"Key creation is not allowed on this service account\"나 \"조직 정책(iam.disableServiceAccountKeyCreation)에 의해 사용 중지됨\" 같은 메시지가 나오면").bold()
                    Text("조직(회사·학교)이 서비스 계정 키 만들기를 막아 둔 것입니다. 이 Mac이나 Nidus의 문제가 아니고, 조직 정책 관리자만 바꿀 수 있습니다. 바꿀 필요는 없습니다: \"Google 계정 로그인\" 방법은 키를 만들지 않으므로 이 정책과 무관하게 됩니다. 그쪽으로 진행하세요.")
                        .fixedSize(horizontal: false, vertical: true)
                }.font(.callout)
                Spacer(minLength: 0)
            }
            .padding(10).background(RoundedRectangle(cornerRadius: 6).fill(Color.orange.opacity(0.1)))
            GroupBox("Google Cloud Console에서 (브라우저, 5분)") {
                VStack(alignment: .leading, spacing: 6) {
                    step(1, "Gemini API 키가 속한 프로젝트를 고르고, \"IAM 및 관리자\" → \"서비스 계정\" → \"서비스 계정 만들기\". 이름은 예: nidus-quota-reader")
                    step(2, "역할 두 개를 줍니다: Cloud Quotas 뷰어(제한과 결제 연결 여부), Monitoring 뷰어(Google이 센 사용량). 하나만 줘도 되고, 빠진 항목은 Unknown으로 나옵니다.")
                    step(3, "만든 계정 → \"키\" 탭 → \"키 추가\" → \"새 키 만들기\" → JSON. 파일이 다운로드됩니다. 여기서 위의 메시지가 나오면 이 방법은 쓸 수 없습니다.")
                    step(4, "\"API 및 서비스\" → \"라이브러리\"에서 Cloud Quotas API, Cloud Monitoring API, Cloud Billing API를 \"사용\"으로 켭니다.")
                    step(5, "아래 \"키 파일 고르기…\"로 다운로드한 JSON을 고릅니다. 고른 뒤에는 다운로드 폴더의 파일을 지워도 됩니다.")
                    HStack(spacing: 12) {
                        if let url = Self.serviceAccountsURL { Link("서비스 계정 페이지 열기", destination: url) }
                        if let url = Self.libraryURL { Link("API 라이브러리 열기", destination: url) }
                    }.font(.caption)
                }.frame(maxWidth: .infinity, alignment: .leading).padding(4)
            }
        }
    }

    private var gcloudWay: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("터미널을 쓸 수 있고 Google의 명령줄 도구(gcloud, 약 500MB)를 설치해도 괜찮다면 이 방법도 됩니다. 설치한 뒤 로그인하면 Nidus가 자동으로 알아봅니다. 설정할 것은 없습니다.")
                .font(.callout).fixedSize(horizontal: false, vertical: true)
            GroupBox("터미널에서 (한 줄씩)") {
                VStack(alignment: .leading, spacing: 6) {
                    step(1, "설치 (Homebrew가 있을 때):")
                    Text("brew install --cask gcloud-cli").font(.system(.callout, design: .monospaced)).textSelection(.enabled).padding(.leading, 18)
                    step(2, "로그인 (브라우저가 열립니다):")
                    Text("gcloud auth application-default login").font(.system(.callout, design: .monospaced)).textSelection(.enabled).padding(.leading, 18)
                    step(3, "이 창의 \"다시 확인\"을 누릅니다. \"지금: gcloud 로그인 사용 중\"으로 바뀝니다.")
                    Text("\"command not found: gcloud\"가 나오면 아직 설치되지 않은 것입니다. 설치가 안 되는 환경이면 \"Google 계정 로그인\" 방법을 쓰세요.")
                        .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                }.frame(maxWidth: .infinity, alignment: .leading).padding(4)
            }
        }
    }

    // MARK: actions

    private func signIn(client: String?) async {
        problem = nil
        signingIn = true
        defer { signingIn = false }
        if await store.signInCloud(client: client) != nil {
            await onChange()
            dismiss()
        } else {
            problem = "로그인이 끝나지 않았습니다. 브라우저에서 \"허용\"을 눌렀는지, 고른 파일이 \"데스크톱 앱\" 유형의 OAuth 클라이언트인지, \"외부\" 대상이면 테스트 사용자에 내 계정을 넣었는지 확인하세요."
        }
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
