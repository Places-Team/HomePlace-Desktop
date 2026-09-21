import AppKit
import CoreGraphics
import Darwin
import Foundation
import LocalAuthentication

private func writeLine(_ value: String) {
    FileHandle.standardOutput.write(Data((value + "\n").utf8))
}

private func authenticate(reason: String) -> Never {
    let context = LAContext()
    context.localizedCancelTitle = "Cancel"
    context.localizedFallbackTitle = "Use Password"

    var error: NSError?
    guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else {
        writeLine("unavailable")
        exit(2)
    }

    let semaphore = DispatchSemaphore(value: 0)
    var accepted = false
    context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) { success, _ in
        accepted = success
        semaphore.signal()
    }
    semaphore.wait()
    writeLine(accepted ? "accepted" : "denied")
    exit(accepted ? 0 : 1)
}

private func monitorDragPasteboard(parentPID: pid_t) -> Never {
    let pasteboard = NSPasteboard(name: .drag)
    var previousChangeCount = pasteboard.changeCount
    var dragActive = false

    while true {
        if kill(parentPID, 0) != 0 {
            exit(0)
        }
        autoreleasepool {
            let changeCount = pasteboard.changeCount
            let leftButtonDown = CGEventSource.buttonState(
                .combinedSessionState,
                button: .left
            )
            let supportedContent = pasteboard.pasteboardItems?.contains { item in
                item.types.contains(.fileURL)
                    || item.types.contains(.URL)
                    || item.types.contains(.string)
            } ?? false

            if !dragActive,
               leftButtonDown,
               supportedContent,
               changeCount != previousChangeCount {
                dragActive = true
                previousChangeCount = changeCount
                writeLine("drag-start")
            } else if dragActive && !leftButtonDown {
                dragActive = false
                previousChangeCount = changeCount
                writeLine("drag-end")
            } else if !leftButtonDown {
                previousChangeCount = changeCount
            }
        }
        Thread.sleep(forTimeInterval: 0.075)
    }
}

let arguments = CommandLine.arguments
switch arguments.dropFirst().first {
case "authenticate":
    let reason = arguments.dropFirst(2).first ?? "Confirm this HomePlace action"
    authenticate(reason: String(reason.prefix(160)))
case "monitor-drag":
    guard arguments.count > 2, let parentPID = pid_t(arguments[2]) else {
        writeLine("invalid-parent")
        exit(64)
    }
    monitorDragPasteboard(parentPID: parentPID)
default:
    writeLine("unsupported")
    exit(64)
}
