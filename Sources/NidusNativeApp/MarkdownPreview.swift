import SwiftUI
import Foundation

private enum MarkdownBlock {
    case heading(Int, String)
    case paragraph(String)
    case list([String], ordered: Bool)
    case quote(String)
    case code(String, String)
    case table([String], [[String]])
    case divider
}

private enum MarkdownParser {
    static func parse(_ source: String) -> [MarkdownBlock] {
        let lines = source.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n").components(separatedBy: "\n")
        var blocks: [MarkdownBlock] = []
        var index = 0
        while index < lines.count {
            let line = lines[index]
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.isEmpty { index += 1; continue }

            if trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~") {
                let fence = String(trimmed.prefix(3))
                let language = String(trimmed.dropFirst(3)).trimmingCharacters(in: .whitespaces)
                index += 1
                var code: [String] = []
                while index < lines.count && !lines[index].trimmingCharacters(in: .whitespaces).hasPrefix(fence) {
                    code.append(lines[index]); index += 1
                }
                if index < lines.count { index += 1 }
                blocks.append(.code(language, code.joined(separator: "\n")))
                continue
            }

            if let heading = heading(trimmed) { blocks.append(.heading(heading.0, heading.1)); index += 1; continue }
            if ["---", "***", "___"].contains(trimmed) { blocks.append(.divider); index += 1; continue }

            if trimmed.hasPrefix(">") {
                var quote: [String] = []
                while index < lines.count {
                    let current = lines[index].trimmingCharacters(in: .whitespaces)
                    guard current.hasPrefix(">") else { break }
                    quote.append(String(current.dropFirst()).trimmingCharacters(in: .whitespaces))
                    index += 1
                }
                blocks.append(.quote(quote.joined(separator: "\n")))
                continue
            }

            if let item = listItem(trimmed) {
                var items: [String] = []
                let ordered = item.0
                while index < lines.count, let next = listItem(lines[index].trimmingCharacters(in: .whitespaces)), next.0 == ordered {
                    items.append(next.1); index += 1
                }
                blocks.append(.list(items, ordered: ordered))
                continue
            }

            if index + 1 < lines.count, trimmed.contains("|"), isTableDivider(lines[index + 1]) {
                let headers = cells(trimmed)
                index += 2
                var rows: [[String]] = []
                while index < lines.count {
                    let current = lines[index].trimmingCharacters(in: .whitespaces)
                    guard current.contains("|"), !current.isEmpty else { break }
                    let parsed = cells(current)
                    rows.append(Array(parsed.prefix(headers.count)) + Array(repeating: "", count: max(0, headers.count - parsed.count)))
                    index += 1
                }
                blocks.append(.table(headers, rows))
                continue
            }

            var paragraph = [trimmed]
            index += 1
            while index < lines.count {
                let next = lines[index].trimmingCharacters(in: .whitespaces)
                if next.isEmpty || isBlockStart(next) || isTableStart(lines, index) { break }
                paragraph.append(next); index += 1
            }
            blocks.append(.paragraph(paragraph.joined(separator: "\n")))
        }
        return blocks
    }

    private static func heading(_ line: String) -> (Int, String)? {
        let count = line.prefix(while: { $0 == "#" }).count
        guard (1...6).contains(count), line.dropFirst(count).first == " " else { return nil }
        return (count, String(line.dropFirst(count)).trimmingCharacters(in: .whitespaces))
    }
    private static func listItem(_ line: String) -> (Bool, String)? {
        let chars = Array(line)
        guard chars.count >= 3 else { return nil }
        if ["-", "*", "+"].contains(chars[0]), chars[1] == " " { return (false, String(chars.dropFirst(2))) }
        var digits = 0
        while digits < chars.count && chars[digits].isNumber { digits += 1 }
        if digits > 0, digits + 1 < chars.count, [".", ")"].contains(chars[digits]), chars[digits + 1] == " " {
            return (true, String(chars.dropFirst(digits + 2)))
        }
        return nil
    }
    private static func isBlockStart(_ line: String) -> Bool {
        line.hasPrefix("```") || line.hasPrefix("~~~") || heading(line) != nil || line.hasPrefix(">") ||
        listItem(line) != nil || ["---", "***", "___"].contains(line)
    }
    private static func isTableStart(_ lines: [String], _ index: Int) -> Bool {
        guard index + 1 < lines.count else { return false }
        return lines[index].contains("|") && isTableDivider(lines[index + 1])
    }
    private static func cells(_ line: String) -> [String] {
        var value = line.trimmingCharacters(in: .whitespaces)
        if value.hasPrefix("|") { value.removeFirst() }
        if value.hasSuffix("|") { value.removeLast() }
        return value.split(separator: "|", omittingEmptySubsequences: false).map {
            $0.trimmingCharacters(in: .whitespaces)
        }
    }
    private static func isTableDivider(_ line: String) -> Bool {
        let parts = cells(line)
        return !parts.isEmpty && parts.allSatisfy { part in
            let clean = part.replacingOccurrences(of: ":", with: "").replacingOccurrences(of: "-", with: "")
            return !part.isEmpty && clean.trimmingCharacters(in: .whitespaces).isEmpty
        }
    }
}

struct MarkdownPreview: View {
    let source: String
    private var blocks: [MarkdownBlock] { MarkdownParser.parse(source) }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(blocks.indices, id: \.self) { index in render(blocks[index]) }
        }.frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder private func render(_ block: MarkdownBlock) -> some View {
        switch block {
        case .heading(let level, let value):
            Text(inline(value)).font(level == 1 ? .title.bold() : level == 2 ? .title2.bold() : level == 3 ? .title3.bold() : .headline)
                .fixedSize(horizontal: false, vertical: true)
        case .paragraph(let value):
            inlineLines(value, font: .body, spacing: 2)
        case .list(let items, let ordered):
            VStack(alignment: .leading, spacing: 7) {
                ForEach(items.indices, id: \.self) { index in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(ordered ? "\(index + 1)." : "•").foregroundStyle(.secondary)
                        Text(inline(items[index])).fixedSize(horizontal: false, vertical: true)
                    }
                }
            }.padding(.leading, 4)
        case .quote(let value):
            HStack(alignment: .top, spacing: 9) {
                RoundedRectangle(cornerRadius: 2).fill(.secondary.opacity(0.65)).frame(width: 3)
                inlineLines(value, font: .body, spacing: 2).foregroundStyle(.secondary)
            }.fixedSize(horizontal: false, vertical: true).padding(.vertical, 2)
        case .code(let language, let value):
            VStack(alignment: .leading, spacing: 5) {
                if !language.isEmpty { Text(language).font(.caption2).foregroundStyle(.secondary) }
                ScrollView(.horizontal) {
                    Text(value).font(.system(.callout, design: .monospaced)).textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading).padding(10)
                }
            }.background(.black.opacity(0.055), in: RoundedRectangle(cornerRadius: 8))
        case .table(let headers, let rows):
            ScrollView(.horizontal) {
                VStack(alignment: .leading, spacing: 0) {
                    tableRow(headers, header: true)
                    ForEach(rows.indices, id: \.self) { index in tableRow(rows[index], header: false) }
                }.fixedSize(horizontal: true, vertical: false)
            }
        case .divider:
            Divider()
        }
    }

    private func tableRow(_ values: [String], header: Bool) -> some View {
        HStack(alignment: .top, spacing: 0) {
            ForEach(values.indices, id: \.self) { index in
                Text(inline(values[index])).font(header ? .callout.bold() : .callout)
                    .frame(minWidth: 110, maxWidth: 220, alignment: .leading)
                    .padding(8).background(header ? Color.secondary.opacity(0.13) : .clear)
                    .overlay(alignment: .trailing) { Rectangle().fill(.secondary.opacity(0.16)).frame(width: 1) }
            }
        }.overlay(alignment: .bottom) { Rectangle().fill(.secondary.opacity(0.2)).frame(height: 1) }
    }

    private func inline(_ value: String) -> AttributedString {
        (try? AttributedString(markdown: value)) ?? AttributedString(value)
    }
    private func inlineLines(_ value: String, font: Font, spacing: CGFloat) -> some View {
        VStack(alignment: .leading, spacing: spacing) {
            ForEach(Array(value.components(separatedBy: "\n").enumerated()), id: \.offset) { _, line in
                Text(inline(line)).font(font).fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }
}
