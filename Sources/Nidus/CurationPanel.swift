import SwiftUI

/// The Library Manager's suggestions for the user's own notes: links between notes, and moves
/// where the filing rules call for them. Nothing changes until the user picks and applies.
struct CurationPanel: View {
    @EnvironmentObject private var session: WorkspaceSession
    let curation: NoteCuration?

    @State private var picked: Set<String> = []
    @State private var editingRules = false
    @State private var rules = ""

    private var pending: [NoteSuggestion] { curation?.suggestions.filter { $0.status != "applied" } ?? [] }
    private var applied: [NoteSuggestion] { curation?.suggestions.filter { $0.status == "applied" } ?? [] }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("문서 연결 제안").font(.headline)
                Spacer()
                if session.curating { ProgressView().controlSize(.small) }
            }
            if session.curating {
                Text(session.curatingProgress.isEmpty ? "노트를 살펴보고 있습니다…" : "\(session.curatingProgress)…").foregroundStyle(.secondary)
            } else if let curation {
                if curation.suggestions.isEmpty {
                    Text("노트 \(curation.read)개를 살펴봤습니다. 제안할 것이 없었습니다.").font(.callout).foregroundStyle(.secondary)
                } else {
                    Text("고른 것만 적용합니다. 연결은 노트 끝의 \"관련 문서\"에 한 줄을 더하고, 이동은 파일을 그 폴더로 옮깁니다.").font(.caption).foregroundStyle(.secondary)
                }
                ForEach(pending) { suggestion in row(suggestion) }
                if !applied.isEmpty {
                    Text("적용함 \(applied.count)건").font(.caption).foregroundStyle(.secondary)
                    ForEach(applied) { suggestion in
                        Label(summary(suggestion), systemImage: "checkmark").font(.caption).foregroundStyle(.secondary).lineLimit(2)
                    }
                }
                HStack {
                    if !pending.isEmpty {
                        Button("고른 \(picked.count)건 적용") { session.applyCuration(Array(picked)); picked = [] }
                            .buttonStyle(.borderedProminent).disabled(picked.isEmpty)
                        Button(picked.count == pending.count ? "모두 해제" : "모두 고르기") {
                            picked = picked.count == pending.count ? [] : Set(pending.map(\.id))
                        }
                    }
                    Spacer()
                    Button("닫기") { session.discardCuration() }.help("적용하지 않은 제안을 버립니다. 이미 적용한 것은 그대로 남습니다.")
                }
            }
            Divider()
            HStack {
                Button("다시 살펴보기") { session.curate() }.controlSize(.small).disabled(session.curating)
                Button("분류 규칙…") { Task { rules = await session.libraryRules(); editingRules = true } }.controlSize(.small)
                Spacer()
                if session.curating { Button("멈춤") { session.cancelCurate() }.controlSize(.small) }
            }
        }
        .padding(Layout.inset)
        .panel()
        .sheet(isPresented: $editingRules) {
            VStack(alignment: .leading, spacing: 10) {
                Text("분류 규칙").font(.headline)
                Text("노트가 어느 폴더에 있어야 하는지 평소 말로 적습니다. 비워 두면 이동은 제안하지 않고 연결만 제안합니다.").font(.callout).foregroundStyle(.secondary)
                TextEditor(text: $rules).font(.body).frame(minHeight: 160)
                    .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Color(nsColor: .separatorColor)))
                Text("예: 회의록은 회의/<연도>/ 폴더에. 책을 읽고 쓴 노트는 독서/ 폴더에.").font(.caption).foregroundStyle(.tertiary)
                HStack {
                    Spacer()
                    Button("취소", role: .cancel) { editingRules = false }
                    Button("저장") { session.setLibraryRules(rules); editingRules = false }.buttonStyle(.borderedProminent)
                }
            }
            .padding(20).frame(width: 480)
        }
    }

    private func name(_ path: String) -> String {
        let file = (path as NSString).lastPathComponent
        return file.hasSuffix(".md") ? String(file.dropLast(3)) : file
    }

    private func summary(_ s: NoteSuggestion) -> String {
        s.kind == "move" ? "\(name(s.path)) → \(s.target)/" : "\(name(s.path)) → [[\(name(s.target))]]"
    }

    private func row(_ s: NoteSuggestion) -> some View {
        Toggle(isOn: Binding(get: { picked.contains(s.id) }, set: { on in if on { picked.insert(s.id) } else { picked.remove(s.id) } })) {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(s.kind == "move" ? "이동" : "연결").font(.caption2).padding(.horizontal, 5).padding(.vertical, 1)
                        .background(Capsule().fill((s.kind == "move" ? Color.orange : Color.accentColor).opacity(0.18)))
                    Text(summary(s)).font(.callout).lineLimit(2)
                }
                Text(s.path).font(.caption2).foregroundStyle(.tertiary).lineLimit(1).truncationMode(.middle)
                if !s.reason.isEmpty { Text(s.reason).font(.caption).foregroundStyle(.secondary) }
                if let error = s.error, s.status == "failed" { Text("적용하지 못했습니다: \(error)").font(.caption).foregroundStyle(.red) }
            }
        }
        .toggleStyle(.checkbox)
    }
}
