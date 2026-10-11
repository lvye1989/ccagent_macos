import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

private enum HelperError: Error, CustomStringConvertible {
    case message(String)
    var description: String {
        switch self { case .message(let value): return value }
    }
}

private struct WindowRecord {
    let id: CGWindowID
    let pid: pid_t
    let processName: String
    let title: String
    let executable: String?
    let bounds: CGRect
}

private func jsonData(_ value: Any) throws -> Data {
    try JSONSerialization.data(withJSONObject: value, options: [])
}

private func printJSON(_ value: Any) throws {
    FileHandle.standardOutput.write(try jsonData(value))
    FileHandle.standardOutput.write(Data("\n".utf8))
}

private func stringValue(_ dictionary: [String: Any], _ key: CFString) -> String? {
    dictionary[key as String] as? String
}

private func intValue(_ dictionary: [String: Any], _ key: CFString) -> Int? {
    if let number = dictionary[key as String] as? NSNumber { return number.intValue }
    return dictionary[key as String] as? Int
}

private func windowRecords(including windowID: CGWindowID? = nil) -> [WindowRecord] {
    let options: CGWindowListOption = windowID == nil
        ? [.optionOnScreenOnly, .excludeDesktopElements]
        : [.optionIncludingWindow, .excludeDesktopElements]
    let relative = windowID ?? kCGNullWindowID
    guard let raw = CGWindowListCopyWindowInfo(options, relative) as? [[String: Any]] else { return [] }
    return raw.compactMap { item in
        guard
            intValue(item, kCGWindowLayer) == 0,
            let idValue = intValue(item, kCGWindowNumber),
            let pidValue = intValue(item, kCGWindowOwnerPID),
            let boundsValue = item[kCGWindowBounds as String],
            let bounds = CGRect(dictionaryRepresentation: boundsValue as! CFDictionary),
            bounds.width >= 2,
            bounds.height >= 2
        else { return nil }
        let pid = pid_t(pidValue)
        let owner = stringValue(item, kCGWindowOwnerName)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let windowTitle = stringValue(item, kCGWindowName)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !owner.isEmpty else { return nil }
        let title = windowTitle.isEmpty ? owner : windowTitle
        let executable = NSRunningApplication(processIdentifier: pid)?.executableURL?.path
        return WindowRecord(
            id: CGWindowID(idValue),
            pid: pid,
            processName: owner,
            title: title,
            executable: executable,
            bounds: bounds
        )
    }
}

private func exactWindow(_ id: CGWindowID) throws -> WindowRecord {
    guard let match = windowRecords(including: id).first(where: { $0.id == id }) else {
        throw HelperError.message("Target window no longer exists or is not visible.")
    }
    return match
}

private func axCopy(_ element: AXUIElement, _ attribute: CFString) -> CFTypeRef? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute, &value) == .success else { return nil }
    return value
}

private func axString(_ element: AXUIElement, _ attribute: CFString) -> String? {
    axCopy(element, attribute) as? String
}

private func axBool(_ element: AXUIElement, _ attribute: CFString, fallback: Bool = false) -> Bool {
    (axCopy(element, attribute) as? NSNumber)?.boolValue ?? fallback
}

private func axPoint(_ element: AXUIElement, _ attribute: CFString) -> CGPoint? {
    guard let raw = axCopy(element, attribute), CFGetTypeID(raw) == AXValueGetTypeID() else { return nil }
    let value = unsafeBitCast(raw, to: AXValue.self)
    guard AXValueGetType(value) == .cgPoint else { return nil }
    var point = CGPoint.zero
    return AXValueGetValue(value, .cgPoint, &point) ? point : nil
}

private func axSize(_ element: AXUIElement, _ attribute: CFString) -> CGSize? {
    guard let raw = axCopy(element, attribute), CFGetTypeID(raw) == AXValueGetTypeID() else { return nil }
    let value = unsafeBitCast(raw, to: AXValue.self)
    guard AXValueGetType(value) == .cgSize else { return nil }
    var size = CGSize.zero
    return AXValueGetValue(value, .cgSize, &size) ? size : nil
}

private func axChildren(_ element: AXUIElement) -> [AXUIElement] {
    axCopy(element, kAXChildrenAttribute as CFString) as? [AXUIElement] ?? []
}

private func ensureAccessibility() throws {
    let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
    guard AXIsProcessTrustedWithOptions(options) else {
        throw HelperError.message(
            "macOS Accessibility permission is required. Open System Settings > Privacy & Security > Accessibility, allow the CCAGENT macOS helper, then retry."
        )
    }
}

private func matchAXWindow(_ window: WindowRecord) throws -> AXUIElement {
    let application = AXUIElementCreateApplication(window.pid)
    let candidates = axCopy(application, kAXWindowsAttribute as CFString) as? [AXUIElement] ?? []
    let normalizedTitle = window.title.trimmingCharacters(in: .whitespacesAndNewlines)
    var closest: (AXUIElement, CGFloat)?
    for candidate in candidates {
        let title = axString(candidate, kAXTitleAttribute as CFString)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let position = axPoint(candidate, kAXPositionAttribute as CFString)
        let size = axSize(candidate, kAXSizeAttribute as CFString)
        if !normalizedTitle.isEmpty && title == normalizedTitle { return candidate }
        if let position, let size {
            let distance = abs(position.x - window.bounds.minX) + abs(position.y - window.bounds.minY)
                + abs(size.width - window.bounds.width) + abs(size.height - window.bounds.height)
            if closest == nil || distance < closest!.1 { closest = (candidate, distance) }
        }
    }
    if let closest, closest.1 <= 12 { return closest.0 }
    throw HelperError.message("Could not match the exact macOS Accessibility window. Re-list windows and retry.")
}

private func boundedText(_ value: String?, max: Int = 500) -> String {
    guard let value else { return "" }
    let compact = value.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
    return String(compact.prefix(max))
}

private func observe(_ window: WindowRecord) throws -> [String: Any] {
    try ensureAccessibility()
    let root = try matchAXWindow(window)
    var queue = axChildren(root)
    var cursor = 0
    var elements: [[String: Any]] = []
    var focusedDescription: String?
    while cursor < queue.count && elements.count < 300 {
        let element = queue[cursor]
        cursor += 1
        if queue.count < 1_200 { queue.append(contentsOf: axChildren(element)) }
        let role = boundedText(axString(element, kAXRoleAttribute as CFString), max: 100)
            .replacingOccurrences(of: "AX", with: "", options: [.anchored])
        let title = boundedText(axString(element, kAXTitleAttribute as CFString))
        let description = boundedText(axString(element, kAXDescriptionAttribute as CFString))
        let value = boundedText(axString(element, kAXValueAttribute as CFString))
        let name = !title.isEmpty ? title : (!description.isEmpty ? description : value)
        let identifier = boundedText(axString(element, kAXIdentifierAttribute as CFString), max: 120)
        let enabled = axBool(element, kAXEnabledAttribute as CFString, fallback: true)
        let focused = axBool(element, kAXFocusedAttribute as CFString)
        var settable = DarwinBoolean(false)
        _ = AXUIElementIsAttributeSettable(element, kAXFocusedAttribute as CFString, &settable)
        var item: [String: Any] = [
            "index": elements.count,
            "controlType": role.isEmpty ? "Element" : role,
            "name": name,
            "automationId": identifier,
            "className": boundedText(axString(element, kAXSubroleAttribute as CFString), max: 100),
            "enabled": enabled,
            "focusable": settable.boolValue,
            "focused": focused,
        ]
        if let position = axPoint(element, kAXPositionAttribute as CFString),
           let size = axSize(element, kAXSizeAttribute as CFString),
           size.width > 0, size.height > 0 {
            item["x"] = Int((position.x - window.bounds.minX).rounded())
            item["y"] = Int((position.y - window.bounds.minY).rounded())
            item["width"] = Int(size.width.rounded())
            item["height"] = Int(size.height.rounded())
        }
        if focused { focusedDescription = "\(role): \(name)" }
        if !role.isEmpty || !name.isEmpty { elements.append(item) }
    }
    var result: [String: Any] = [
        "title": window.title,
        "width": Int(window.bounds.width.rounded()),
        "height": Int(window.bounds.height.rounded()),
        "nativeWidth": Int(window.bounds.width.rounded()),
        "nativeHeight": Int(window.bounds.height.rounded()),
        "elements": elements,
    ]
    if let focusedDescription { result["focusedElement"] = focusedDescription }
    return result
}

private let keyCodes: [String: CGKeyCode] = [
    "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9,
    "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17, "1": 18, "2": 19,
    "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26, "-": 27, "8": 28,
    "0": 29, "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35, "return": 36,
    "enter": 36, "l": 37, "j": 38, "'": 39, "k": 40, ";": 41, "\\": 42, ",": 43,
    "/": 44, "n": 45, "m": 46, ".": 47, "tab": 48, "space": 49, "backspace": 51,
    "escape": 53, "esc": 53, "delete": 117, "home": 115, "end": 119, "pageup": 116,
    "page_up": 116, "pagedown": 121, "page_down": 121, "left": 123, "right": 124,
    "down": 125, "up": 126, "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96,
    "f6": 97, "f7": 98, "f8": 100, "f9": 101, "f10": 109, "f11": 103, "f12": 111,
]

private func postKey(_ chord: String) throws {
    let parts = chord.split(separator: "+").map { $0.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }
    guard let main = parts.last, let keyCode = keyCodes[main] ?? (main.count == 1 ? keyCodes[main] : nil) else {
        throw HelperError.message("Unsupported macOS key chord: \(chord)")
    }
    var flags: CGEventFlags = []
    for modifier in parts.dropLast() {
        switch modifier {
        case "control", "ctrl", "control_l", "control_r": flags.insert(.maskControl)
        case "alt", "option", "alt_l", "alt_r", "option_l", "option_r": flags.insert(.maskAlternate)
        case "shift", "shift_l", "shift_r": flags.insert(.maskShift)
        case "command", "cmd", "command_l", "command_r": flags.insert(.maskCommand)
        default: throw HelperError.message("Unsupported macOS key modifier: \(modifier)")
        }
    }
    guard
        let down = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: true),
        let up = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: false)
    else { throw HelperError.message("Could not create a macOS keyboard event.") }
    down.flags = flags
    up.flags = flags
    down.post(tap: .cghidEventTap)
    up.post(tap: .cghidEventTap)
    Thread.sleep(forTimeInterval: 0.06)
}

private func typeText(_ text: String) throws {
    for chunkStart in stride(from: 0, to: text.utf16.count, by: 20) {
        let units = Array(text.utf16.dropFirst(chunkStart).prefix(20))
        guard
            let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true),
            let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false)
        else { throw HelperError.message("Could not create a macOS text event.") }
        down.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
        up.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
        down.post(tap: .cghidEventTap)
        up.post(tap: .cghidEventTap)
    }
}

private func mouseButton(_ value: String) -> CGMouseButton {
    value == "right" ? .right : (value == "middle" ? .center : .left)
}

private func mouseTypes(_ button: CGMouseButton) -> (CGEventType, CGEventType, CGEventType) {
    switch button {
    case .right: return (.rightMouseDown, .rightMouseUp, .rightMouseDragged)
    case .center: return (.otherMouseDown, .otherMouseUp, .otherMouseDragged)
    default: return (.leftMouseDown, .leftMouseUp, .leftMouseDragged)
    }
}

private func postClick(at point: CGPoint, button: CGMouseButton, count: Int) throws {
    let types = mouseTypes(button)
    for index in 1...max(1, min(2, count)) {
        guard
            let down = CGEvent(mouseEventSource: nil, mouseType: types.0, mouseCursorPosition: point, mouseButton: button),
            let up = CGEvent(mouseEventSource: nil, mouseType: types.1, mouseCursorPosition: point, mouseButton: button)
        else { throw HelperError.message("Could not create a macOS pointer event.") }
        down.setIntegerValueField(.mouseEventClickState, value: Int64(index))
        up.setIntegerValueField(.mouseEventClickState, value: Int64(index))
        down.post(tap: .cghidEventTap)
        up.post(tap: .cghidEventTap)
        Thread.sleep(forTimeInterval: 0.07)
    }
}

private func point(_ action: [String: Any], x: String, y: String, in window: WindowRecord) throws -> CGPoint {
    guard let xValue = (action[x] as? NSNumber)?.doubleValue, let yValue = (action[y] as? NSNumber)?.doubleValue,
          xValue >= 0, yValue >= 0, xValue < window.bounds.width, yValue < window.bounds.height else {
        throw HelperError.message("Agent pointer coordinates are outside the verified target window.")
    }
    return CGPoint(x: window.bounds.minX + xValue, y: window.bounds.minY + yValue)
}

private func perform(_ window: WindowRecord, actions: [[String: Any]], expectedWidth: Int, expectedHeight: Int) throws {
    try ensureAccessibility()
    let current = try exactWindow(window.id)
    guard Int(current.bounds.width.rounded()) == expectedWidth, Int(current.bounds.height.rounded()) == expectedHeight else {
        throw HelperError.message("Target window size changed after the snapshot; no input was sent. Re-observe before retrying.")
    }
    guard let application = NSRunningApplication(processIdentifier: current.pid) else {
        throw HelperError.message("Target application is no longer running.")
    }
    if #available(macOS 14.0, *) {
        _ = application.activate()
    } else {
        _ = application.activate(options: [.activateIgnoringOtherApps])
    }
    let axWindow = try matchAXWindow(current)
    _ = AXUIElementPerformAction(axWindow, kAXRaiseAction as CFString)
    Thread.sleep(forTimeInterval: 0.18)
    guard NSWorkspace.shared.frontmostApplication?.processIdentifier == current.pid else {
        throw HelperError.message("Could not safely activate the exact target application; no input was sent.")
    }
    let savedPointer = CGEvent(source: nil)?.location
    defer { if let savedPointer { CGWarpMouseCursorPosition(savedPointer) } }
    for action in actions {
        let name = action["action"] as? String ?? ""
        switch name {
        case "activate": break
        case "click":
            let location = try point(action, x: "x", y: "y", in: current)
            let button = mouseButton(action["button"] as? String ?? "left")
            try postClick(at: location, button: button, count: (action["clickCount"] as? NSNumber)?.intValue ?? 1)
        case "type_text": try typeText(action["text"] as? String ?? "")
        case "press_key": try postKey(action["key"] as? String ?? "")
        case "scroll":
            let location = try point(action, x: "x", y: "y", in: current)
            guard let event = CGEvent(
                scrollWheelEvent2Source: nil,
                units: .pixel,
                wheelCount: 2,
                wheel1: Int32(-((action["scrollY"] as? NSNumber)?.intValue ?? 0)),
                wheel2: Int32((action["scrollX"] as? NSNumber)?.intValue ?? 0),
                wheel3: 0
            ) else { throw HelperError.message("Could not create a macOS scroll event.") }
            event.location = location
            event.post(tap: .cghidEventTap)
        case "drag":
            let start = try point(action, x: "fromX", y: "fromY", in: current)
            let end = try point(action, x: "toX", y: "toY", in: current)
            let types = mouseTypes(.left)
            CGEvent(mouseEventSource: nil, mouseType: types.0, mouseCursorPosition: start, mouseButton: .left)?.post(tap: .cghidEventTap)
            for step in 1...20 {
                let ratio = CGFloat(step) / 20
                let location = CGPoint(x: start.x + (end.x - start.x) * ratio, y: start.y + (end.y - start.y) * ratio)
                CGEvent(mouseEventSource: nil, mouseType: types.2, mouseCursorPosition: location, mouseButton: .left)?.post(tap: .cghidEventTap)
                Thread.sleep(forTimeInterval: 0.012)
            }
            CGEvent(mouseEventSource: nil, mouseType: types.1, mouseCursorPosition: end, mouseButton: .left)?.post(tap: .cghidEventTap)
        case "set_value":
            let location = try point(action, x: "x", y: "y", in: current)
            try postClick(at: location, button: .left, count: 1)
            try postKey("Command+a")
            try typeText(action["text"] as? String ?? "")
        case "wait":
            let milliseconds = max(0, min(5_000, (action["durationMs"] as? NSNumber)?.intValue ?? 0))
            Thread.sleep(forTimeInterval: Double(milliseconds) / 1_000)
        default: throw HelperError.message("Unsupported Computer Use action: \(name)")
        }
    }
}

private func environmentInt(_ name: String) throws -> Int {
    guard let raw = ProcessInfo.processInfo.environment[name], let value = Int(raw) else {
        throw HelperError.message("Missing or invalid environment value: \(name)")
    }
    return value
}

private func main() throws {
    let arguments = CommandLine.arguments
    guard arguments.count >= 2 else { throw HelperError.message("Expected command: list, observe, or action.") }
    switch arguments[1] {
    case "list":
        let result = windowRecords().map { window -> [String: Any] in
            var item: [String: Any] = [
                "id": String(window.id),
                "processId": Int(window.pid),
                "processName": window.processName,
                "title": window.title,
            ]
            if let executable = window.executable { item["executable"] = executable }
            return item
        }
        try printJSON(result)
    case "observe":
        guard arguments.count == 3, let id = UInt32(arguments[2]) else { throw HelperError.message("observe requires a window id.") }
        try printJSON(try observe(exactWindow(CGWindowID(id))))
    case "action":
        guard arguments.count == 3, let id = UInt32(arguments[2]) else { throw HelperError.message("action requires a window id.") }
        guard let input = ProcessInfo.processInfo.environment["CC_ACTION_INPUT"], let data = input.data(using: .utf8) else {
            throw HelperError.message("CC_ACTION_INPUT is required.")
        }
        let decoded = try JSONSerialization.jsonObject(with: data)
        let actions: [[String: Any]]
        if let array = decoded as? [[String: Any]] { actions = array }
        else if let single = decoded as? [String: Any] { actions = [single] }
        else { throw HelperError.message("CC_ACTION_INPUT must be an action object or array.") }
        guard (1...8).contains(actions.count) else { throw HelperError.message("Computer Use action batch must contain 1-8 actions.") }
        try perform(
            exactWindow(CGWindowID(id)),
            actions: actions,
            expectedWidth: try environmentInt("CC_EXPECTED_WIDTH"),
            expectedHeight: try environmentInt("CC_EXPECTED_HEIGHT")
        )
        try printJSON(["ok": true, "actions": actions.count])
    default: throw HelperError.message("Unsupported command: \(arguments[1])")
    }
}

do {
    try main()
} catch {
    FileHandle.standardError.write(Data("\(error)\n".utf8))
    exit(1)
}
