import SwiftUI

/// Shared measurements so every page lines up on the same edges.
enum Layout {
    /// Distance from the window content edge to page content, on all four sides.
    static let margin: CGFloat = 20
    /// Gap between sibling blocks on a page.
    static let spacing: CGFloat = 14
    /// Padding inside a panel.
    static let inset: CGFloat = 14
    static let radius: CGFloat = 8
}

private struct Panel: ViewModifier {
    func body(content: Content) -> some View {
        content
            .background(Color(nsColor: .controlBackgroundColor))
            .clipShape(RoundedRectangle(cornerRadius: Layout.radius))
            .overlay(RoundedRectangle(cornerRadius: Layout.radius).strokeBorder(Color(nsColor: .separatorColor)))
    }
}

extension View {
    /// The one surface style for cards, lists and tables: same fill, corner and border everywhere.
    func panel() -> some View { modifier(Panel()) }
}

extension View {
    /// Keeps the window title for the Window menu and Mission Control but leaves it out of the toolbar.
    @ViewBuilder
    func toolbarTitleHidden() -> some View {
        if #available(macOS 15.0, *) {
            toolbar(removing: .title)
        } else {
            self
        }
    }
}

/// Vault name, page title and one-line explanation at the top of each page.
struct PageHeader: View {
    @EnvironmentObject private var store: VaultStore
    let title: String
    let subtitle: String

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(URL(fileURLWithPath: store.vault ?? "").lastPathComponent)
                .font(.caption.weight(.semibold)).foregroundStyle(.secondary).lineLimit(1)
                .help(store.vault ?? "")
            Text(title).font(.title2.bold())
            Text(subtitle).font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// A page whose content scrolls as a whole.
struct ScrollingPage<Content: View>: View {
    @ViewBuilder let content: Content

    var body: some View {
        // No scroll bar: with always-visible scroll bars it would take a strip off the
        // right side and the page's right edge would no longer match the other pages.
        ScrollView(showsIndicators: false) {
            VStack(alignment: .leading, spacing: Layout.spacing) { content }
                .padding(Layout.margin)
                .frame(maxWidth: .infinity, alignment: .topLeading)
        }
        // One point clear of the toolbar: a scroll view that touches it extends underneath,
        // and with no toolbar background the scrolled content would show behind the buttons.
        .padding(.top, 1)
    }
}

/// A page that fills the window and lets one inner list or table take the remaining height.
struct FixedPage<Content: View>: View {
    @ViewBuilder let content: Content

    var body: some View {
        // Pin the page to the size the window offers. Without this, a list or table
        // inside a split-view detail can claim its full content height and push the
        // rest of the page under the toolbar.
        GeometryReader { proxy in
            VStack(alignment: .leading, spacing: Layout.spacing) { content }
                .padding(Layout.margin)
                .frame(width: proxy.size.width, height: proxy.size.height, alignment: .topLeading)
        }
    }
}
