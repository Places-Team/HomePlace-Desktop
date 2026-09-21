import AppKit
import Foundation
import UniformTypeIdentifiers

@objc(HomePlaceShareExtension)
final class HomePlaceShareExtension: NSObject, NSExtensionRequestHandling {
    private let lock = NSLock()
    private var arguments: [String] = []

    func beginRequest(with context: NSExtensionContext) {
        let providers = (context.inputItems as? [NSExtensionItem] ?? [])
            .flatMap { $0.attachments ?? [] }
            .prefix(20)
        let group = DispatchGroup()

        for provider in providers {
            if provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
                loadFile(from: provider, group: group)
            } else if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier) {
                loadText(from: provider, type: .url, group: group)
            } else if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) {
                loadText(from: provider, type: .plainText, group: group)
            }
        }

        group.notify(queue: .main) { [weak self] in
            guard let self else {
                context.cancelRequest(withError: ShareError.unavailable)
                return
            }
            let stagedArguments = self.lock.withLock { self.arguments }
            guard !stagedArguments.isEmpty else {
                context.cancelRequest(withError: ShareError.unsupportedContent)
                return
            }
            self.openContainingApplication(arguments: stagedArguments) { opened in
                if opened {
                    context.completeRequest(returningItems: [], completionHandler: nil)
                } else {
                    context.cancelRequest(withError: ShareError.couldNotOpenApplication)
                }
            }
        }
    }

    private func loadFile(from provider: NSItemProvider, group: DispatchGroup) {
        group.enter()
        provider.loadItem(forTypeIdentifier: UTType.fileURL.identifier, options: nil) { [weak self] item, _ in
            defer { group.leave() }
            guard let source = item as? URL,
                  source.isFileURL,
                  let staged = try? self?.stageFile(source) else { return }
            self?.lock.withLock {
                self?.arguments.append(contentsOf: ["--homeplace-share-file", staged.path])
            }
        }
    }

    private func loadText(from provider: NSItemProvider, type: UTType, group: DispatchGroup) {
        group.enter()
        provider.loadItem(forTypeIdentifier: type.identifier, options: nil) { [weak self] item, _ in
            defer { group.leave() }
            let value: String?
            if let url = item as? URL {
                value = url.absoluteString
            } else if let text = item as? String {
                value = text
            } else if let data = item as? Data {
                value = String(data: data, encoding: .utf8)
            } else {
                value = nil
            }
            guard let value = value?.trimmingCharacters(in: .whitespacesAndNewlines),
                  !value.isEmpty else { return }
            self?.lock.withLock {
                self?.arguments.append(contentsOf: ["--homeplace-share-text", String(value.prefix(8_000))])
            }
        }
    }

    private func stageFile(_ source: URL) throws -> URL {
        let root = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
            .appendingPathComponent("HomePlaceShare", isDirectory: true)
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let name = source.lastPathComponent.isEmpty ? "Shared file" : source.lastPathComponent
        let destination = root.appendingPathComponent(name, isDirectory: false)
        let accessed = source.startAccessingSecurityScopedResource()
        defer { if accessed { source.stopAccessingSecurityScopedResource() } }
        try FileManager.default.copyItem(at: source, to: destination)
        return destination
    }

    private func openContainingApplication(arguments: [String], completion: @escaping (Bool) -> Void) {
        let appURL = Bundle.main.bundleURL
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        guard appURL.pathExtension == "app" else {
            completion(false)
            return
        }
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = false
        configuration.arguments = arguments
        NSWorkspace.shared.openApplication(at: appURL, configuration: configuration) { _, error in
            completion(error == nil)
        }
    }
}

private enum ShareError: LocalizedError {
    case unavailable
    case unsupportedContent
    case couldNotOpenApplication

    var errorDescription: String? {
        switch self {
        case .unavailable: return "HomePlace Share is unavailable."
        case .unsupportedContent: return "This item cannot be shared with HomePlace."
        case .couldNotOpenApplication: return "HomePlace Desktop could not be opened."
        }
    }
}

private extension NSLock {
    func withLock<T>(_ body: () -> T) -> T {
        lock()
        defer { unlock() }
        return body()
    }
}
