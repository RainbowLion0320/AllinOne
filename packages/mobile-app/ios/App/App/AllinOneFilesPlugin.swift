import Foundation
import Photos
import UIKit
import Capacitor

/// Lightweight zero-dependency Capacitor bridge allowing decrypted E2EE deliverables & images
/// to be saved into iOS Photos or exported via the native iOS share sheet (`UIActivityViewController`),
/// supporting both single-shot exports (<= 50 MB) and streaming chunked exports (up to 2 GB).
@objc(AllinOneFilesPlugin)
public class AllinOneFilesPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "AllinOneFilesPlugin"
    public let jsName = "AllinOneFiles"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "saveAndShare", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openExport", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "writeExportChunk", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "finishExport", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clearSharedCache", returnType: CAPPluginReturnPromise),
    ]

    private static let staleCacheSeconds: TimeInterval = 2 * 60 * 60
    private static let exportSessionTtlSeconds: TimeInterval = 10 * 60
    private static let maxBase64Length = 68 * 1024 * 1024 // ~50 MB decoded (single-shot)
    private static let maxDecodedBytes = 50 * 1024 * 1024
    private static let maxChunkBase64Length = 6 * 1024 * 1024 // ~4.5 MB per streaming chunk
    private static let maxStreamExportBytes: Int64 = 2 * 1024 * 1024 * 1024 // 2 GB streaming cap
    private static let maxConcurrentExports = 4

    private static let allowedExtMime: [String: String] = [
        "png": "image/png",
        "jpg": "image/jpeg",
        "jpeg": "image/jpeg",
        "webp": "image/webp",
        "gif": "image/gif",
        "bmp": "image/bmp",
        "avif": "image/avif",
        "ico": "image/x-icon",
        "svg": "image/svg+xml",
        "html": "text/html",
        "htm": "text/html",
        "pdf": "application/pdf",
        "doc": "application/msword",
        "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xls": "application/vnd.ms-excel",
        "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "csv": "text/csv",
        "ppt": "application/vnd.ms-powerpoint",
        "pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "md": "text/markdown",
        "markdown": "text/markdown",
        "txt": "text/plain",
        "log": "text/plain",
        "json": "application/json",
        "rtf": "application/rtf",
        "epub": "application/epub+zip",
        "zip": "application/zip",
    ]

    private static let blockedMimes: Set<String> = [
        "application/xhtml+xml",
        "application/javascript",
        "text/javascript",
        "application/x-javascript",
        "application/vnd.android.package-archive",
        "application/java-archive",
        "application/x-sh",
        "application/x-shellscript",
        "application/x-executable",
        "application/x-msdownload",
        "text/xml",
        "application/xml",
    ]

    private static let photoLibrarySaveableMimes: Set<String> = [
        "image/png",
        "image/jpeg",
        "image/webp",
        "image/gif",
        "image/bmp",
        "image/avif",
        "image/heic",
        "image/heif",
    ]

    private final class ExportSession {
        let filename: String
        let mimeType: String
        let mode: String
        let tempDir: URL
        let tempFile: URL
        var fileHandle: FileHandle?
        var totalBytes: Int64 = 0
        var lastActivityAt: Date = Date()
        var aborted = false

        init(filename: String, mimeType: String, mode: String, tempDir: URL, tempFile: URL, fileHandle: FileHandle) {
            self.filename = filename
            self.mimeType = mimeType
            self.mode = mode
            self.tempDir = tempDir
            self.tempFile = tempFile
            self.fileHandle = fileHandle
        }
    }

    // Serial background queue keeps all file I/O off the main thread and preserves strict chunk ordering.
    private let ioQueue = DispatchQueue(label: "com.allinone.dshmobile.files.io", qos: .userInitiated)
    private var activeExports: [String: ExportSession] = [:]

    deinit {
        for (_, session) in activeExports {
            abortExportSessionLocked(session)
        }
        activeExports.removeAll()
    }

    // MARK: - Validation Helpers

    private static func sanitizeFilename(_ raw: String?) -> String {
        var base = (raw ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if let lastSlash = base.lastIndex(where: { $0 == "/" || $0 == "\\" }) {
            base = String(base[base.index(after: lastSlash)...])
        }
        var filtered = String()
        filtered.reserveCapacity(base.count)
        for scalar in base.unicodeScalars {
            let v = scalar.value
            let isAsciiSafe =
                (v >= 0x30 && v <= 0x39) || // 0-9
                (v >= 0x41 && v <= 0x5A) || // A-Z
                (v >= 0x61 && v <= 0x7A) || // a-z
                v == 0x2E || v == 0x5F || v == 0x2D // . _ -
            let isCjk = (v >= 0x4E00 && v <= 0x9FA5)
            if isAsciiSafe || isCjk {
                filtered.unicodeScalars.append(scalar)
            } else {
                filtered.append("_")
            }
        }
        while filtered.hasPrefix(".") {
            filtered.removeFirst()
        }
        if filtered.isEmpty {
            return "allinone-file.bin"
        }
        if filtered.count <= 120 {
            return filtered
        }
        if let dotIdx = filtered.lastIndex(of: "."), dotIdx > filtered.startIndex {
            let afterDot = filtered.index(after: dotIdx)
            if afterDot < filtered.endIndex {
                let ext = String(filtered[dotIdx...])
                if ext.count <= 16 {
                    let maxStem = max(1, 120 - ext.count)
                    let stemEnd = filtered.index(filtered.startIndex, offsetBy: min(filtered.distance(from: filtered.startIndex, to: dotIdx), maxStem))
                    return String(filtered[..<stemEnd]) + ext
                }
            }
        }
        return String(filtered.prefix(120))
    }

    private static func extractExtension(_ filename: String) -> String {
        guard let dotIdx = filename.lastIndex(of: "."), dotIdx > filename.startIndex else {
            return ""
        }
        let afterDot = filename.index(after: dotIdx)
        guard afterDot < filename.endIndex else {
            return ""
        }
        return String(filename[afterDot...]).lowercased()
    }

    private static func resolveSafeMimeType(filename: String, rawMime: String?) -> String? {
        let ext = extractExtension(filename)
        guard let canonical = allowedExtMime[ext] else {
            return nil
        }
        var norm = (rawMime ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if let semi = norm.firstIndex(of: ";") {
            norm = String(norm[..<semi]).trimmingCharacters(in: .whitespacesAndNewlines)
        }
        if norm.isEmpty || norm == "application/octet-stream" {
            return canonical
        }
        if blockedMimes.contains(norm) {
            return nil
        }
        if norm == "text/html" && ext != "html" && ext != "htm" {
            return nil
        }
        if norm == "image/svg+xml" && ext != "svg" {
            return nil
        }
        if let slash = canonical.firstIndex(of: "/") {
            let expectedPrefix = String(canonical[...slash])
            if norm.hasPrefix(expectedPrefix) {
                return norm
            }
        }
        if ext == "json" && norm == "text/plain" {
            return norm
        }
        if ext == "rtf" && norm == "text/rtf" {
            return norm
        }
        return nil
    }

    // MARK: - Cache & Session Lifecycle (called on ioQueue)

    private func sharedCacheRootURL() throws -> URL {
        let caches = try FileManager.default.url(
            for: .cachesDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        )
        let dir = caches.appendingPathComponent("allinone_shared", isDirectory: true)
        if !FileManager.default.fileExists(atPath: dir.path) {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        }
        return dir
    }

    private func pruneShareCacheLocked(rootDir: URL) {
        let fm = FileManager.default
        guard let entries = try? fm.contentsOfDirectory(
            at: rootDir,
            includingPropertiesForKeys: [.contentModificationDateKey],
            options: [.skipsHiddenFiles]
        ) else {
            return
        }
        let activeDirs = Set(activeExports.values.map { $0.tempDir.standardizedFileURL })
        let cutoff = Date().addingTimeInterval(-Self.staleCacheSeconds)
        for entry in entries {
            if activeDirs.contains(entry.standardizedFileURL) { continue }
            let modDate = (try? entry.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? Date.distantPast
            if modDate < cutoff {
                try? fm.removeItem(at: entry)
            }
        }
    }

    private func reapExpiredExportsLocked() {
        let cutoff = Date().addingTimeInterval(-Self.exportSessionTtlSeconds)
        let expiredIds = activeExports.compactMap { id, session -> String? in
            session.lastActivityAt < cutoff ? id : nil
        }
        for id in expiredIds {
            if let session = activeExports.removeValue(forKey: id) {
                abortExportSessionLocked(session)
            }
        }
    }

    private func abortExportSessionLocked(_ session: ExportSession) {
        guard !session.aborted else { return }
        session.aborted = true
        if let fh = session.fileHandle {
            try? fh.close()
            session.fileHandle = nil
        }
        try? FileManager.default.removeItem(at: session.tempDir)
    }

    // MARK: - Delivery (Photos / Share Sheet)

    private func topMostViewController() -> UIViewController? {
        guard var top = bridge?.viewController else { return nil }
        while let presented = top.presentedViewController, !presented.isBeingDismissed {
            top = presented
        }
        return top
    }

    private func presentShareSheet(fileURL: URL, call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self, let presenter = self.topMostViewController() else {
                call.reject("Unable to locate view controller for share sheet")
                return
            }
            let activityVC = UIActivityViewController(activityItems: [fileURL], applicationActivities: nil)
            if let popover = activityVC.popoverPresentationController {
                popover.sourceView = presenter.view
                popover.sourceRect = CGRect(
                    x: presenter.view.bounds.midX,
                    y: presenter.view.bounds.midY,
                    width: 1,
                    height: 1
                )
                popover.permittedArrowDirections = []
            }
            presenter.present(activityVC, animated: true) {
                call.resolve([
                    "ok": true,
                    "uri": fileURL.absoluteString,
                ])
            }
        }
    }

    private func deliverExportedFile(fileURL: URL, tempDir: URL, mimeType: String, mode: String, call: CAPPluginCall) {
        if mode == "save" && Self.photoLibrarySaveableMimes.contains(mimeType) {
            let saveToLibrary: () -> Void = { [weak self] in
                PHPhotoLibrary.shared().performChanges({
                    let req = PHAssetCreationRequest.forAsset()
                    req.addResource(with: .photo, fileURL: fileURL, options: nil)
                }) { success, _ in
                    if success {
                        self?.ioQueue.async {
                            try? FileManager.default.removeItem(at: tempDir)
                        }
                        call.resolve([
                            "ok": true,
                            "savedToPhotos": true,
                        ])
                    } else {
                        self?.presentShareSheet(fileURL: fileURL, call: call)
                    }
                }
            }

            let status = PHPhotoLibrary.authorizationStatus(for: .addOnly)
            if status == .authorized || status == .limited {
                saveToLibrary()
            } else if status == .notDetermined {
                PHPhotoLibrary.requestAuthorization(for: .addOnly) { [weak self] newStatus in
                    if newStatus == .authorized || newStatus == .limited {
                        saveToLibrary()
                    } else {
                        self?.presentShareSheet(fileURL: fileURL, call: call)
                    }
                }
            } else {
                presentShareSheet(fileURL: fileURL, call: call)
            }
            return
        }

        presentShareSheet(fileURL: fileURL, call: call)
    }

    // MARK: - Plugin Methods

    @objc public func clearSharedCache(_ call: CAPPluginCall) {
        ioQueue.async { [weak self] in
            guard let self = self else {
                call.reject("Files plugin is unavailable")
                return
            }
            do {
                self.reapExpiredExportsLocked()
                let rootDir = try self.sharedCacheRootURL()
                let activeDirs = Set(self.activeExports.values.map { $0.tempDir.standardizedFileURL })
                let entries = try FileManager.default.contentsOfDirectory(at: rootDir, includingPropertiesForKeys: nil)
                for entry in entries {
                    if activeDirs.contains(entry.standardizedFileURL) { continue }
                    try? FileManager.default.removeItem(at: entry)
                }
                call.resolve(["ok": true])
            } catch {
                call.reject("Failed to clear shared cache: \(error.localizedDescription)")
            }
        }
    }

    @objc public func openExport(_ call: CAPPluginCall) {
        let filename = Self.sanitizeFilename(call.getString("filename") ?? "document")
        let rawMime = call.getString("mimeType") ?? "application/octet-stream"
        guard let mimeType = Self.resolveSafeMimeType(filename: filename, rawMime: rawMime) else {
            call.reject("Blocked or unsupported file type")
            return
        }
        let mode = call.getString("mode") == "share" ? "share" : "save"

        ioQueue.async { [weak self] in
            guard let self = self else {
                call.reject("Files plugin is unavailable")
                return
            }
            self.reapExpiredExportsLocked()
            if self.activeExports.count >= Self.maxConcurrentExports {
                call.reject("Too many concurrent exports in progress")
                return
            }
            var createdDir: URL?
            do {
                let rootDir = try self.sharedCacheRootURL()
                self.pruneShareCacheLocked(rootDir: rootDir)
                let tempDir = rootDir.appendingPathComponent(UUID().uuidString, isDirectory: true)
                try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
                createdDir = tempDir
                let tempFile = tempDir.appendingPathComponent(filename, isDirectory: false)
                guard FileManager.default.createFile(atPath: tempFile.path, contents: nil) else {
                    throw NSError(domain: "AllinOneFiles", code: 1, userInfo: [NSLocalizedDescriptionKey: "Could not create export file"])
                }
                let handle = try FileHandle(forWritingTo: tempFile)
                let exportId = UUID().uuidString
                self.activeExports[exportId] = ExportSession(
                    filename: filename,
                    mimeType: mimeType,
                    mode: mode,
                    tempDir: tempDir,
                    tempFile: tempFile,
                    fileHandle: handle
                )
                call.resolve(["exportId": exportId])
            } catch {
                if let dir = createdDir {
                    try? FileManager.default.removeItem(at: dir)
                }
                call.reject("Failed to open export stream: \(error.localizedDescription)")
            }
        }
    }

    @objc public func writeExportChunk(_ call: CAPPluginCall) {
        guard let exportId = call.getString("exportId"), !exportId.isEmpty else {
            call.reject("Missing exportId")
            return
        }
        let chunkBase64 = call.getString("chunkBase64") ?? ""
        if chunkBase64.count > Self.maxChunkBase64Length {
            call.reject("Export chunk exceeds maximum allowed chunk size")
            return
        }

        ioQueue.async { [weak self] in
            guard let self = self else {
                call.reject("Files plugin is unavailable")
                return
            }
            self.reapExpiredExportsLocked()
            guard let session = self.activeExports[exportId], !session.aborted else {
                call.reject("Unknown or closed export session")
                return
            }
            if chunkBase64.isEmpty {
                session.lastActivityAt = Date()
                call.resolve(["ok": true, "totalBytes": session.totalBytes])
                return
            }
            guard let data = Data(base64Encoded: chunkBase64, options: .ignoreUnknownCharacters) else {
                call.reject("Invalid base64 chunk")
                return
            }
            let nextTotal = session.totalBytes + Int64(data.count)
            if nextTotal > Self.maxStreamExportBytes {
                self.activeExports.removeValue(forKey: exportId)
                self.abortExportSessionLocked(session)
                call.reject("File exceeds maximum allowed streaming export size (2 GB)")
                return
            }
            do {
                guard let handle = session.fileHandle else {
                    throw NSError(domain: "AllinOneFiles", code: 2, userInfo: [NSLocalizedDescriptionKey: "Export stream is closed"])
                }
                try handle.write(contentsOf: data)
                session.totalBytes = nextTotal
                session.lastActivityAt = Date()
                call.resolve(["ok": true, "totalBytes": session.totalBytes])
            } catch {
                self.activeExports.removeValue(forKey: exportId)
                self.abortExportSessionLocked(session)
                call.reject("Failed writing export chunk: \(error.localizedDescription)")
            }
        }
    }

    @objc public func finishExport(_ call: CAPPluginCall) {
        let exportId = call.getString("exportId") ?? ""
        let cancel = call.getBool("cancel") ?? false

        ioQueue.async { [weak self] in
            guard let self = self else {
                call.reject("Files plugin is unavailable")
                return
            }
            guard let session = self.activeExports.removeValue(forKey: exportId) else {
                if cancel {
                    call.resolve(["ok": true])
                } else {
                    call.reject("Unknown export session")
                }
                return
            }
            if cancel {
                self.abortExportSessionLocked(session)
                call.resolve(["ok": true])
                return
            }
            do {
                if let handle = session.fileHandle {
                    try? handle.synchronize()
                    try handle.close()
                    session.fileHandle = nil
                }
                self.deliverExportedFile(
                    fileURL: session.tempFile,
                    tempDir: session.tempDir,
                    mimeType: session.mimeType,
                    mode: session.mode,
                    call: call
                )
            } catch {
                self.abortExportSessionLocked(session)
                call.reject("Failed to finalize export: \(error.localizedDescription)")
            }
        }
    }

    @objc public func saveAndShare(_ call: CAPPluginCall) {
        guard let dataBase64 = call.getString("dataBase64"), !dataBase64.isEmpty else {
            call.reject("Missing file data")
            return
        }
        if dataBase64.count > Self.maxBase64Length {
            call.reject("File exceeds maximum allowed size (50 MB)")
            return
        }
        let filename = Self.sanitizeFilename(call.getString("filename") ?? "document")
        let rawMime = call.getString("mimeType") ?? "application/octet-stream"
        guard let mimeType = Self.resolveSafeMimeType(filename: filename, rawMime: rawMime) else {
            call.reject("Blocked or unsupported file type")
            return
        }
        let mode = call.getString("mode") == "share" ? "share" : "save"

        ioQueue.async { [weak self] in
            guard let self = self else {
                call.reject("Files plugin is unavailable")
                return
            }
            guard let data = Data(base64Encoded: dataBase64, options: .ignoreUnknownCharacters) else {
                call.reject("Invalid base64 payload")
                return
            }
            if data.count > Self.maxDecodedBytes {
                call.reject("File exceeds maximum allowed size (50 MB)")
                return
            }
            var isolatedDir: URL?
            do {
                let rootDir = try self.sharedCacheRootURL()
                self.pruneShareCacheLocked(rootDir: rootDir)
                let dir = rootDir.appendingPathComponent(UUID().uuidString, isDirectory: true)
                try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
                isolatedDir = dir
                let fileURL = dir.appendingPathComponent(filename, isDirectory: false)
                try data.write(to: fileURL, options: .atomic)
                self.deliverExportedFile(
                    fileURL: fileURL,
                    tempDir: dir,
                    mimeType: mimeType,
                    mode: mode,
                    call: call
                )
            } catch {
                if let dir = isolatedDir {
                    try? FileManager.default.removeItem(at: dir)
                }
                call.reject("Failed to export file: \(error.localizedDescription)")
            }
        }
    }
}
