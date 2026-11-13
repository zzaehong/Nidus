import Foundation

/// Markdown to HTML for the Library preview: the Markdown people write in a notes vault
/// (headings, lists and task lists, tables, code, quotes and callouts, front matter, links,
/// `[[wiki links]]`, `![[embeds]]`, ==highlights==). Raw HTML in a note is shown as text, not run.
enum MarkdownHTML {
    struct Context {
        /// An image path in the note to something an `<img>` can show (a data URI), or nil.
        var image: (String) -> String? = { _ in nil }
        /// Whether a `[[wiki link]]` leads to a note that exists.
        var noteExists: (String) -> Bool = { _ in true }
    }

    static func escape(_ text: String) -> String {
        text.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;").replacingOccurrences(of: "\"", with: "&quot;")
    }

    // MARK: inline

    private static func replace(_ text: String, _ pattern: String, _ transform: ([String]) -> String) -> String {
        guard let regex = try? NSRegularExpression(pattern: pattern, options: []) else { return text }
        let source = text as NSString
        var out = "", last = 0
        for match in regex.matches(in: text, range: NSRange(location: 0, length: source.length)) {
            out += source.substring(with: NSRange(location: last, length: match.range.location - last))
            let groups = (0..<match.numberOfRanges).map { match.range(at: $0).location == NSNotFound ? "" : source.substring(with: match.range(at: $0)) }
            out += transform(groups)
            last = match.range.location + match.range.length
        }
        return out + source.substring(from: last)
    }

    private static func percent(_ text: String) -> String {
        text.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? text
    }

    /// Links a page may follow: web, mail, a note in the Vault (relative), or a wiki link.
    private static func safeHref(_ escaped: String) -> String {
        let lower = escaped.lowercased().trimmingCharacters(in: .whitespaces)
        if lower.hasPrefix("javascript:") || lower.hasPrefix("data:") || lower.hasPrefix("vbscript:") || lower.hasPrefix("file:") { return "#" }
        return escaped
    }

    static func inline(_ raw: String, _ context: Context = Context()) -> String {
        var text = escape(raw)
        // Code spans are kept aside so nothing inside them is styled.
        var kept: [String] = []
        let keep = { (html: String) -> String in kept.append(html); return "\u{0}\(kept.count - 1)\u{0}" }
        text = replace(text, "`([^`\\n]+)`") { keep("<code>\($0[1])</code>") }
        text = replace(text, "!\\[\\[([^\\]\\|\\n]+)(?:\\|([^\\]\\n]*))?\\]\\]") { g in
            if let source = context.image(g[1]) { return keep("<img src=\"\(source)\" alt=\"\(g[1])\"\(Int(g[2]).map { " width=\"\($0)\"" } ?? "")>") }
            return keep("<a class=\"wiki\(context.noteExists(g[1]) ? "" : " missing")\" href=\"nidus-wiki:\(percent(g[1]))\">\(g[1])</a>")
        }
        text = replace(text, "!\\[([^\\]\\n]*)\\]\\(([^)\\s]+)(?:\\s+&quot;[^)]*&quot;)?\\)") { g in
            let source = g[2].hasPrefix("http://") || g[2].hasPrefix("https://") ? g[2] : (context.image(g[2].removingPercentEncoding ?? g[2]) ?? "")
            return keep(source.isEmpty ? "<span class=\"missing\">[이미지 없음: \(g[2])]</span>" : "<img src=\"\(source)\" alt=\"\(g[1])\">")
        }
        text = replace(text, "\\[\\[([^\\]\\|\\n]+)(?:\\|([^\\]\\n]*))?\\]\\]") { g in
            let target = g[1].split(separator: "#", maxSplits: 1).first.map(String.init) ?? g[1]
            return keep("<a class=\"wiki\(context.noteExists(target) ? "" : " missing")\" href=\"nidus-wiki:\(percent(g[1]))\">\(g[2].isEmpty ? g[1] : g[2])</a>")
        }
        text = replace(text, "\\[([^\\]\\n]+)\\]\\(([^)\\s]+)(?:\\s+&quot;[^)]*&quot;)?\\)") { g in keep("<a href=\"\(safeHref(g[2]))\">") + g[1] + keep("</a>") }
        text = replace(text, "(?<![\"=\\w/])(https?://[^\\s<]+[^\\s<.,;:!?)\\]])") { g in keep("<a href=\"\(g[1])\">\(g[1])</a>") }
        text = replace(text, "\\*\\*([^*\\n]+?)\\*\\*") { "<strong>\($0[1])</strong>" }
        text = replace(text, "__([^_\\n]+?)__") { "<strong>\($0[1])</strong>" }
        text = replace(text, "(?<![*\\w])\\*([^*\\s][^*\\n]*?)\\*(?![*\\w])") { "<em>\($0[1])</em>" }
        text = replace(text, "(?<![_\\w])_([^_\\s][^_\\n]*?)_(?![_\\w])") { "<em>\($0[1])</em>" }
        text = replace(text, "~~([^~\\n]+?)~~") { "<del>\($0[1])</del>" }
        text = replace(text, "==([^=\\n]+?)==") { "<mark>\($0[1])</mark>" }
        text = replace(text, "(?<![\\w&/])#([\\p{L}\\p{N}_][\\p{L}\\p{N}_/-]*)") { g in Int(g[1]) == nil ? "<span class=\"tag\">#\(g[1])</span>" : g[0] }
        // Twice: a kept link may hold a kept code span.
        for _ in 0..<2 { text = replace(text, "\u{0}(\\d+)\u{0}") { kept[Int($0[1]) ?? 0] } }
        return text
    }

    // MARK: blocks

    private static func matches(_ line: String, _ pattern: String) -> [String]? {
        guard let regex = try? NSRegularExpression(pattern: pattern), let match = regex.firstMatch(in: line, range: NSRange(location: 0, length: (line as NSString).length)) else { return nil }
        return (0..<match.numberOfRanges).map { match.range(at: $0).location == NSNotFound ? "" : (line as NSString).substring(with: match.range(at: $0)) }
    }

    private static func indent(_ line: String) -> Int {
        var count = 0
        for character in line { if character == " " { count += 1 } else if character == "\t" { count += 4 } else { break } }
        return count
    }

    private static func cells(_ row: String) -> [String] {
        var text = row.trimmingCharacters(in: .whitespaces)
        if text.hasPrefix("|") { text.removeFirst() }
        if text.hasSuffix("|") && !text.hasSuffix("\\|") { text.removeLast() }
        return text.replacingOccurrences(of: "\\|", with: "\u{1}").split(separator: "|", omittingEmptySubsequences: false)
            .map { $0.replacingOccurrences(of: "\u{1}", with: "|").trimmingCharacters(in: .whitespaces) }
    }

    private static let listItem = "^(\\s*)([-*+]|\\d{1,9}[.)])\\s+(.*)$"

    /// The body HTML of a note.
    static func render(_ markdown: String, _ context: Context = Context()) -> String {
        var lines = markdown.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n")
        var html: [String] = []
        // Front matter: shown as the note's properties.
        if lines.first == "---", let end = lines.dropFirst().firstIndex(of: "---") {
            let rows = lines[1..<end].compactMap { line -> String? in
                guard let colon = line.firstIndex(of: ":"), !line.hasPrefix(" ") else { return line.trimmingCharacters(in: .whitespaces).isEmpty ? nil : "<tr><td colspan=\"2\">\(escape(line))</td></tr>" }
                return "<tr><th>\(escape(String(line[..<colon])))</th><td>\(escape(String(line[line.index(after: colon)...]).trimmingCharacters(in: .whitespaces)))</td></tr>"
            }
            if !rows.isEmpty { html.append("<table class=\"props\">\(rows.joined())</table>") }
            lines = Array(lines[(end + 1)...])
        }
        html.append(blocks(lines, context))
        return html.joined(separator: "\n")
    }

    private static func blocks(_ lines: [String], _ context: Context) -> String {
        var out: [String] = []
        var paragraph: [String] = []
        let flush = { if !paragraph.isEmpty { out.append("<p>\(paragraph.map { inline($0, context) }.joined(separator: "<br>\n"))</p>"); paragraph = [] } }
        var i = 0
        while i < lines.count {
            let line = lines[i], trimmed = line.trimmingCharacters(in: .whitespaces)
            if let fence = matches(trimmed, "^(```+|~~~+)\\s*([^`\\s]*)") {
                flush()
                var code: [String] = []
                i += 1
                while i < lines.count, !lines[i].trimmingCharacters(in: .whitespaces).hasPrefix(fence[1]) { code.append(lines[i]); i += 1 }
                i += 1
                out.append("<pre><code\(fence[2].isEmpty ? "" : " class=\"language-\(escape(fence[2]))\"")>\(escape(code.joined(separator: "\n")))</code></pre>")
                continue
            }
            if trimmed.isEmpty { flush(); i += 1; continue }
            if let heading = matches(trimmed, "^(#{1,6})\\s+(.*?)\\s*#*$") {
                flush()
                out.append("<h\(heading[1].count)>\(inline(heading[2], context))</h\(heading[1].count)>")
                i += 1; continue
            }
            if matches(trimmed, "^(\\*\\s*){3,}$|^(-\\s*){3,}$|^(_\\s*){3,}$") != nil { flush(); out.append("<hr>"); i += 1; continue }
            if trimmed.hasPrefix(">") {
                flush()
                var quoted: [String] = []
                while i < lines.count, lines[i].trimmingCharacters(in: .whitespaces).hasPrefix(">") {
                    var text = lines[i].trimmingCharacters(in: .whitespaces); text.removeFirst()
                    quoted.append(text.hasPrefix(" ") ? String(text.dropFirst()) : text)
                    i += 1
                }
                // An Obsidian callout: > [!note] Title
                if let callout = matches(quoted[0], "^\\[!(\\w+)\\][+-]?\\s*(.*)$") {
                    let title = callout[2].isEmpty ? callout[1].capitalized : callout[2]
                    out.append("<div class=\"callout callout-\(escape(callout[1].lowercased()))\"><div class=\"callout-title\">\(inline(title, context))</div>\(blocks(Array(quoted.dropFirst()), context))</div>")
                } else {
                    out.append("<blockquote>\(blocks(quoted, context))</blockquote>")
                }
                continue
            }
            if trimmed.contains("|"), i + 1 < lines.count, matches(lines[i + 1].trimmingCharacters(in: .whitespaces), "^\\|?\\s*:?-{1,}:?\\s*(\\|\\s*:?-{1,}:?\\s*)*\\|?$") != nil, lines[i + 1].contains("-") {
                flush()
                let head = cells(trimmed), align = cells(lines[i + 1]).map { $0.hasPrefix(":") && $0.hasSuffix(":") ? "center" : $0.hasSuffix(":") ? "right" : "" }
                let style = { (column: Int) in column < align.count && !align[column].isEmpty ? " style=\"text-align:\(align[column])\"" : "" }
                var table = "<div class=\"table\"><table><thead><tr>\(head.enumerated().map { "<th\(style($0.offset))>\(inline($0.element, context))</th>" }.joined())</tr></thead><tbody>"
                i += 2
                while i < lines.count, lines[i].contains("|"), !lines[i].trimmingCharacters(in: .whitespaces).isEmpty {
                    let row = cells(lines[i])
                    table += "<tr>\((0..<head.count).map { "<td\(style($0))>\($0 < row.count ? inline(row[$0], context) : "")</td>" }.joined())</tr>"
                    i += 1
                }
                out.append(table + "</tbody></table></div>")
                continue
            }
            if matches(line, listItem) != nil {
                flush()
                var block: [String] = []
                let numbered = { (text: String) in matches(text, listItem)?[2].first?.isNumber == true }
                let base = indent(line), ordered = numbered(line)
                // A list runs until a blank line that is not followed by more of it, or a list of the other kind.
                while i < lines.count {
                    let current = lines[i]
                    if !block.isEmpty, matches(current, listItem) != nil, indent(current) <= base + 1, numbered(current) != ordered { break }
                    if current.trimmingCharacters(in: .whitespaces).isEmpty {
                        if i + 1 < lines.count, matches(lines[i + 1], listItem) != nil || (indent(lines[i + 1]) >= 2 && !lines[i + 1].trimmingCharacters(in: .whitespaces).isEmpty) {
                            if matches(lines[i + 1], listItem) != nil, indent(lines[i + 1]) <= base + 1, numbered(lines[i + 1]) != ordered { break }
                            i += 1; continue
                        }
                        break
                    }
                    if matches(current, listItem) == nil && indent(current) < 2 { break }
                    block.append(current); i += 1
                }
                out.append(list(block, context))
                continue
            }
            paragraph.append(trimmed)
            i += 1
        }
        flush()
        return out.joined(separator: "\n")
    }

    /// A list with its nested lists: items deeper indented than the first belong to the item before them.
    private static func list(_ lines: [String], _ context: Context) -> String {
        guard let first = matches(lines[0], listItem) else { return "" }
        let base = indent(lines[0]), ordered = first[2].first?.isNumber == true
        var items: [(text: [String], children: [String])] = []
        for line in lines {
            if let item = matches(line, listItem), indent(line) <= base + 1 { items.append(([item[3]], [])) }
            else if items.isEmpty { continue }
            else if matches(line, listItem) != nil || !items[items.count - 1].children.isEmpty { items[items.count - 1].children.append(line) }
            else { items[items.count - 1].text.append(line.trimmingCharacters(in: .whitespaces)) }
        }
        let start = ordered ? Int(first[2].dropLast()) ?? 1 : 1
        let body = items.map { item -> String in
            var text = item.text.joined(separator: "\n"), attribute = ""
            if let task = matches(text, "^\\[([ xX])\\]\\s+([\\s\\S]*)$") {
                attribute = " class=\"task\""
                text = "<input type=\"checkbox\" disabled\(task[1] == " " ? "" : " checked")> " + inline(task[2], context).replacingOccurrences(of: "\n", with: "<br>\n")
            } else {
                text = inline(text, context).replacingOccurrences(of: "\n", with: "<br>\n")
            }
            return "<li\(attribute)>\(text)\(item.children.isEmpty ? "" : "\n" + list(item.children, context))</li>"
        }.joined(separator: "\n")
        return ordered ? "<ol\(start == 1 ? "" : " start=\"\(start)\"")>\n\(body)\n</ol>" : "<ul>\n\(body)\n</ul>"
    }

    // MARK: page

    /// A whole page for the preview, in the system's light or dark appearance.
    static func page(body: String, title: String) -> String {
        """
        <!doctype html><html><head><meta charset="utf-8">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: https: http:; style-src 'unsafe-inline'">
        <title>\(escape(title))</title><style>
        :root { color-scheme: light dark; --fg: #1f2328; --soft: #59636e; --line: #d1d9e0; --bg: #ffffff; --code: #f3f5f7; --accent: #0b6bcb; --mark: #fff3a3; }
        @media (prefers-color-scheme: dark) { :root { --fg: #e6e9ed; --soft: #9aa4af; --line: #343b44; --bg: #1c1f24; --code: #272b32; --accent: #6cb0ff; --mark: #6b5a00; } }
        html { background: var(--bg); }
        body { font: 15px/1.7 -apple-system, "Apple SD Gothic Neo", "Noto Sans KR", sans-serif; color: var(--fg); max-width: 760px; margin: 0 auto; padding: 28px 32px 80px; word-break: keep-all; overflow-wrap: anywhere; }
        h1, h2, h3, h4, h5, h6 { line-height: 1.3; margin: 1.6em 0 0.5em; } h1 { font-size: 1.9em; } h2 { font-size: 1.45em; padding-bottom: 0.2em; border-bottom: 1px solid var(--line); } h3 { font-size: 1.2em; }
        h1:first-child, h2:first-child, h3:first-child, table.props + h1 { margin-top: 0.2em; }
        p { margin: 0.7em 0; } a { color: var(--accent); text-decoration: none; } a:hover { text-decoration: underline; }
        a.wiki.missing, .missing { color: var(--soft); text-decoration: underline dotted; }
        ul, ol { padding-left: 1.6em; margin: 0.5em 0; } li { margin: 0.15em 0; } li.task { list-style: none; margin-left: -1.3em; }
        code { font: 0.9em ui-monospace, "SF Mono", Menlo, monospace; background: var(--code); padding: 0.1em 0.35em; border-radius: 4px; }
        pre { background: var(--code); padding: 12px 14px; border-radius: 8px; overflow-x: auto; line-height: 1.5; } pre code { background: none; padding: 0; }
        blockquote { margin: 0.8em 0; padding: 0.1em 1em; border-left: 3px solid var(--line); color: var(--soft); }
        .callout { margin: 0.9em 0; padding: 10px 14px; border-radius: 8px; background: var(--code); border-left: 3px solid var(--accent); } .callout-title { font-weight: 600; }
        .table { overflow-x: auto; } table { border-collapse: collapse; margin: 0.8em 0; } th, td { border: 1px solid var(--line); padding: 5px 10px; text-align: left; vertical-align: top; } thead th { background: var(--code); }
        table.props { font-size: 0.86em; color: var(--soft); margin: 0 0 1.2em; } table.props th { font-weight: 500; background: none; }
        hr { border: 0; border-top: 1px solid var(--line); margin: 1.6em 0; } img { max-width: 100%; border-radius: 4px; }
        mark { background: var(--mark); color: inherit; padding: 0 0.15em; } .tag { color: var(--accent); background: var(--code); padding: 0.05em 0.45em; border-radius: 999px; font-size: 0.9em; }
        </style></head><body>
        \(body)
        </body></html>
        """
    }
}
