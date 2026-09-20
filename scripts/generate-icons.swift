import AppKit
import Foundation

guard CommandLine.arguments.count == 3 else {
    fputs("usage: generate-icons.swift <mobile-symbol.png> <output-directory>\n", stderr)
    exit(2)
}

let sourceURL = URL(fileURLWithPath: CommandLine.arguments[1])
let outputURL = URL(fileURLWithPath: CommandLine.arguments[2], isDirectory: true)
try FileManager.default.createDirectory(at: outputURL, withIntermediateDirectories: true)

guard let symbol = NSImage(contentsOf: sourceURL) else {
    fputs("could not read the HomePlace Mobile symbol\n", stderr)
    exit(1)
}

let canvas = NSSize(width: 1024, height: 1024)

func tintedSymbol(color: NSColor) -> NSImage {
    let image = NSImage(size: symbol.size)
    image.lockFocus()
    color.setFill()
    NSRect(origin: .zero, size: symbol.size).fill()
    symbol.draw(
        in: NSRect(origin: .zero, size: symbol.size),
        from: NSRect(origin: .zero, size: symbol.size),
        operation: .destinationIn,
        fraction: 1
    )
    image.unlockFocus()
    return image
}

func writePNG(_ image: NSImage, to url: URL) throws {
    guard
        let data = image.tiffRepresentation,
        let bitmap = NSBitmapImageRep(data: data),
        let png = bitmap.representation(using: .png, properties: [:])
    else {
        throw NSError(domain: "HomePlaceIcons", code: 1)
    }
    try png.write(to: url, options: .atomic)
}

func appIcon(
    inset: CGFloat,
    radius: CGFloat,
    symbolInset: CGFloat,
    shadow: Bool
) -> NSImage {
    let result = NSImage(size: canvas)
    result.lockFocus()
    NSGraphicsContext.current?.imageInterpolation = .high

    let tile = NSRect(x: inset, y: inset, width: 1024 - inset * 2, height: 1024 - inset * 2)
    let path = NSBezierPath(roundedRect: tile, xRadius: radius, yRadius: radius)
    if shadow {
        NSGraphicsContext.saveGraphicsState()
        let iconShadow = NSShadow()
        iconShadow.shadowColor = NSColor(calibratedWhite: 0, alpha: 0.34)
        iconShadow.shadowBlurRadius = 42
        iconShadow.shadowOffset = NSSize(width: 0, height: -20)
        iconShadow.set()
        NSColor(calibratedRed: 0.12, green: 0.15, blue: 0.29, alpha: 1).setFill()
        path.fill()
        NSGraphicsContext.restoreGraphicsState()
    }

    let gradient = NSGradient(colors: [
        NSColor(calibratedRed: 0.22, green: 0.31, blue: 0.80, alpha: 1),
        NSColor(calibratedRed: 0.43, green: 0.25, blue: 0.76, alpha: 1),
    ])!
    gradient.draw(in: path, angle: -45)

    NSColor(calibratedWhite: 1, alpha: 0.18).setStroke()
    path.lineWidth = 3
    path.stroke()

    let mark = tintedSymbol(color: .white)
    let markRect = tile.insetBy(dx: symbolInset, dy: symbolInset)
    mark.draw(in: markRect, from: .zero, operation: .sourceOver, fraction: 1)

    result.unlockFocus()
    return result
}

let mac = appIcon(inset: 92, radius: 188, symbolInset: 65, shadow: true)
let windows = appIcon(inset: 36, radius: 198, symbolInset: 55, shadow: false)

try writePNG(mac, to: outputURL.appendingPathComponent("macos-master.png"))
try writePNG(windows, to: outputURL.appendingPathComponent("windows-master.png"))
