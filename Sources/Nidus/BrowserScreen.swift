import SwiftUI
import AppKit

/// The VM browser's live screen. While the user has control, mouse and keyboard go to the page:
/// plain keys as key events, input-method text (Korean) as finished text, ⌘ shortcuts as Ctrl.
struct BrowserScreen: NSViewRepresentable {
    let image: NSImage?
    let frameSize: CGSize
    let interactive: Bool
    let send: ([String: Any]) -> Void

    func makeNSView(context: Context) -> ScreenView {
        let view = ScreenView()
        view.send = send
        return view
    }

    func updateNSView(_ view: ScreenView, context: Context) {
        view.image = image
        view.frameSize = frameSize
        view.interactive = interactive
        view.send = send
        view.needsDisplay = true
    }
}

final class ScreenView: NSView, NSTextInputClient {
    var image: NSImage?
    var frameSize = CGSize(width: 1280, height: 800)
    var interactive = false { didSet { if !interactive, window?.firstResponder === self { window?.makeFirstResponder(nil) } } }
    var send: ([String: Any]) -> Void = { _ in }

    private var marked = NSAttributedString()
    private var currentKey: NSEvent?
    private var lastMove = Date.distantPast
    private var tracking: NSTrackingArea?

    override var acceptsFirstResponder: Bool { interactive }
    override var isFlipped: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    /// Where the frame is drawn: aspect-fit and centered.
    private var drawRect: CGRect {
        let scale = min(bounds.width / frameSize.width, bounds.height / frameSize.height)
        let size = CGSize(width: frameSize.width * scale, height: frameSize.height * scale)
        return CGRect(x: (bounds.width - size.width) / 2, y: (bounds.height - size.height) / 2, width: size.width, height: size.height)
    }

    override func draw(_ dirtyRect: NSRect) {
        NSColor.black.setFill()
        bounds.fill()
        if let image {
            image.draw(in: drawRect, from: .zero, operation: .copy, fraction: 1, respectFlipped: true, hints: [.interpolation: NSImageInterpolation.high])
        } else {
            let text = NSAttributedString(string: "브라우저 화면이 여기에 나옵니다", attributes: [.foregroundColor: NSColor.white.withAlphaComponent(0.55), .font: NSFont.systemFont(ofSize: 13)])
            let size = text.size()
            text.draw(at: CGPoint(x: (bounds.width - size.width) / 2, y: (bounds.height - size.height) / 2))
        }
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let tracking { removeTrackingArea(tracking) }
        let area = NSTrackingArea(rect: bounds, options: [.mouseMoved, .activeInKeyWindow, .inVisibleRect], owner: self)
        addTrackingArea(area)
        tracking = area
    }

    override func resetCursorRects() {
        addCursorRect(bounds, cursor: interactive ? .arrow : .operationNotAllowed)
    }

    // MARK: mouse

    private func point(_ event: NSEvent) -> [String: Double] {
        let p = convert(event.locationInWindow, from: nil), r = drawRect
        let x = (p.x - r.minX) / r.width * frameSize.width, y = (p.y - r.minY) / r.height * frameSize.height
        return ["x": max(0, min(frameSize.width, x)), "y": max(0, min(frameSize.height, y))]
    }

    private func modifiers(_ event: NSEvent) -> Int {
        let f = event.modifierFlags
        // ⌘ becomes Ctrl: the page runs on Linux, where shortcuts use Ctrl.
        return (f.contains(.option) ? 1 : 0) | (f.contains(.control) || f.contains(.command) ? 2 : 0) | (f.contains(.shift) ? 8 : 0)
    }

    private func mouse(_ action: String, _ event: NSEvent, button: String) {
        guard interactive else { return }
        var message: [String: Any] = ["type": "mouse", "action": action, "button": button, "clickCount": max(1, event.clickCount), "modifiers": modifiers(event)]
        point(event).forEach { message[$0] = $1 }
        send(message)
    }

    override func mouseDown(with event: NSEvent) { window?.makeFirstResponder(self); mouse("down", event, button: "left") }
    override func mouseUp(with event: NSEvent) { mouse("up", event, button: "left") }
    override func rightMouseDown(with event: NSEvent) { mouse("down", event, button: "right") }
    override func rightMouseUp(with event: NSEvent) { mouse("up", event, button: "right") }
    override func mouseMoved(with event: NSEvent) { move(event, buttons: 0) }
    override func mouseDragged(with event: NSEvent) { move(event, buttons: 1) }

    private func move(_ event: NSEvent, buttons: Int) {
        guard interactive, Date().timeIntervalSince(lastMove) > 0.03 else { return }
        lastMove = Date()
        var message: [String: Any] = ["type": "mouse", "action": "move", "modifiers": modifiers(event), "buttons": buttons]
        point(event).forEach { message[$0] = $1 }
        send(message)
    }

    override func scrollWheel(with event: NSEvent) {
        guard interactive else { return }
        let factor: CGFloat = event.hasPreciseScrollingDeltas ? 1 : 40
        var message: [String: Any] = ["type": "wheel", "deltaX": Double(-event.scrollingDeltaX * factor), "deltaY": Double(-event.scrollingDeltaY * factor), "modifiers": modifiers(event)]
        point(event).forEach { message[$0] = $1 }
        send(message)
    }

    // MARK: keyboard

    private static let special: [UInt16: (key: String, code: String)] = [
        36: ("Enter", "Enter"), 76: ("Enter", "NumpadEnter"), 48: ("Tab", "Tab"), 51: ("Backspace", "Backspace"), 117: ("Delete", "Delete"), 53: ("Escape", "Escape"),
        123: ("ArrowLeft", "ArrowLeft"), 124: ("ArrowRight", "ArrowRight"), 125: ("ArrowDown", "ArrowDown"), 126: ("ArrowUp", "ArrowUp"),
        115: ("Home", "Home"), 119: ("End", "End"), 116: ("PageUp", "PageUp"), 121: ("PageDown", "PageDown"),
    ]

    private func key(_ action: String, key: String, code: String, text: String? = nil, modifiers: Int) {
        var message: [String: Any] = ["type": "key", "action": action, "key": key, "code": code, "modifiers": modifiers]
        if let text { message["text"] = text }
        send(message)
    }

    override func keyDown(with event: NSEvent) {
        guard interactive else { return super.keyDown(with: event) }
        let mods = modifiers(event)
        // ⌘V pastes the Mac clipboard as typed text; the VM has its own clipboard.
        if event.modifierFlags.contains(.command), event.charactersIgnoringModifiers?.lowercased() == "v" {
            if let text = NSPasteboard.general.string(forType: .string), !text.isEmpty { send(["type": "text", "text": String(text.prefix(4096))]) }
            return
        }
        if !hasMarkedText(), let special = Self.special[event.keyCode] {
            key("down", key: special.key, code: special.code, modifiers: mods)
            return
        }
        if mods & 2 != 0, let chars = event.charactersIgnoringModifiers, chars.count == 1 {
            key("down", key: chars.lowercased(), code: "Key\(chars.uppercased())", modifiers: mods)
            key("up", key: chars.lowercased(), code: "Key\(chars.uppercased())", modifiers: mods)
            return
        }
        currentKey = event
        interpretKeyEvents([event])
        currentKey = nil
    }

    override func keyUp(with event: NSEvent) {
        guard interactive else { return super.keyUp(with: event) }
        if let special = Self.special[event.keyCode] { key("up", key: special.key, code: special.code, modifiers: modifiers(event)) }
    }

    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        // While controlling the page, ⌘ shortcuts belong to the page, not the app menu (except quit and close).
        guard interactive, window?.firstResponder === self, let chars = event.charactersIgnoringModifiers?.lowercased(), !["q", "w"].contains(chars) else { return super.performKeyEquivalent(with: event) }
        keyDown(with: event)
        return true
    }

    // NSTextInputClient: the input method (Korean, Japanese, ...) composes here; finished text is sent.
    func insertText(_ string: Any, replacementRange: NSRange) {
        let text = (string as? NSAttributedString)?.string ?? (string as? String) ?? ""
        let composed = hasMarkedText()
        marked = NSAttributedString()
        guard !text.isEmpty else { return }
        // A plain key typed without an input method goes as a real key press (pages listen for those).
        if !composed, let event = currentKey, text == event.characters, text.count == 1, let scalar = text.unicodeScalars.first, scalar.isASCII {
            let code = scalar.properties.isAlphabetic ? "Key\(text.uppercased())" : scalar == " " ? "Space" : ""
            key("down", key: text, code: code, text: text, modifiers: modifiers(event))
            key("up", key: text, code: code, modifiers: modifiers(event))
        } else {
            send(["type": "text", "text": text])
        }
    }

    override func doCommand(by selector: Selector) {}
    func setMarkedText(_ string: Any, selectedRange: NSRange, replacementRange: NSRange) {
        marked = (string as? NSAttributedString) ?? NSAttributedString(string: string as? String ?? "")
    }
    func unmarkText() { marked = NSAttributedString() }
    func selectedRange() -> NSRange { NSRange(location: NSNotFound, length: 0) }
    func markedRange() -> NSRange { marked.length > 0 ? NSRange(location: 0, length: marked.length) : NSRange(location: NSNotFound, length: 0) }
    func hasMarkedText() -> Bool { marked.length > 0 }
    func attributedSubstring(forProposedRange range: NSRange, actualRange: NSRangePointer?) -> NSAttributedString? { nil }
    func validAttributesForMarkedText() -> [NSAttributedString.Key] { [] }
    func firstRect(forCharacterRange range: NSRange, actualRange: NSRangePointer?) -> NSRect {
        guard let window else { return .zero }
        return window.convertToScreen(convert(CGRect(x: drawRect.minX + 20, y: drawRect.minY + 20, width: 1, height: 20), to: nil))
    }
    func characterIndex(for point: NSPoint) -> Int { 0 }
}
