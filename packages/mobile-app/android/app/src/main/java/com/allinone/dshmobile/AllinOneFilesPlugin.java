package com.allinone.dshmobile;

import android.app.Activity;
import android.content.ClipData;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.widget.Toast;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.BufferedOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Lightweight zero-dependency Capacitor bridge allowing decrypted E2EE deliverables & images
 * to be saved into Android Downloads (MediaStore) or shared via the system share sheet (FileProvider),
 * working around Android System WebView ignoring `<a download="blob:...">` and lacking `navigator.share`.
 */
@CapacitorPlugin(name = "AllinOneFiles")
public class AllinOneFilesPlugin extends Plugin {
    private static final long STALE_CACHE_MS = 2L * 60L * 60L * 1000L;
    private static final long EXPORT_SESSION_TTL_MS = 10L * 60L * 1000L;
    private static final int MAX_BASE64_LENGTH = 68 * 1024 * 1024; // ~50 MB decoded (single-shot saveAndShare)
    private static final int MAX_DECODED_BYTES = 50 * 1024 * 1024; // 50 MB single-shot cap
    private static final int MAX_CHUNK_BASE64_LENGTH = 6 * 1024 * 1024; // ~4.5 MB per streaming chunk
    private static final long MAX_STREAM_EXPORT_BYTES = 2L * 1024L * 1024L * 1024L; // 2 GB streaming cap
    private static final int MAX_CONCURRENT_EXPORTS = 4;

    private static class ExportSession {
        final String filename;
        final String mimeType;
        final String mode;
        final Uri mediaStoreUri;
        final File tempDir;
        final File tempFile;
        final OutputStream stream;
        long totalBytes = 0L;
        volatile long lastActivityAt;
        boolean aborted = false;

        ExportSession(String filename, String mimeType, String mode, Uri mediaStoreUri, File tempDir, File tempFile, OutputStream stream) {
            this.filename = filename;
            this.mimeType = mimeType;
            this.mode = mode;
            this.mediaStoreUri = mediaStoreUri;
            this.tempDir = tempDir;
            this.tempFile = tempFile;
            this.stream = stream;
            this.lastActivityAt = System.currentTimeMillis();
        }
    }

    private final ConcurrentHashMap<String, ExportSession> activeExports = new ConcurrentHashMap<>();
    // Single-threaded I/O executor keeps heavy file writes off the UI thread while preserving chunk ordering.
    private final ExecutorService ioExecutor = Executors.newSingleThreadExecutor();
    private final AtomicBoolean isDestroyed = new AtomicBoolean(false);

    private static final Map<String, String> ALLOWED_EXT_MIME;
    private static final Set<String> BLOCKED_MIMES;

    static {
        Map<String, String> m = new HashMap<>();
        m.put("png", "image/png");
        m.put("jpg", "image/jpeg");
        m.put("jpeg", "image/jpeg");
        m.put("webp", "image/webp");
        m.put("gif", "image/gif");
        m.put("bmp", "image/bmp");
        m.put("avif", "image/avif");
        m.put("ico", "image/x-icon");
        m.put("svg", "image/svg+xml");
        m.put("html", "text/html");
        m.put("htm", "text/html");
        m.put("pdf", "application/pdf");
        m.put("doc", "application/msword");
        m.put("docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
        m.put("xls", "application/vnd.ms-excel");
        m.put("xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        m.put("csv", "text/csv");
        m.put("ppt", "application/vnd.ms-powerpoint");
        m.put("pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation");
        m.put("md", "text/markdown");
        m.put("markdown", "text/markdown");
        m.put("txt", "text/plain");
        m.put("log", "text/plain");
        m.put("json", "application/json");
        m.put("rtf", "application/rtf");
        m.put("epub", "application/epub+zip");
        m.put("zip", "application/zip");
        ALLOWED_EXT_MIME = Collections.unmodifiableMap(m);

        Set<String> blocked = new HashSet<>();
        blocked.add("application/xhtml+xml");
        blocked.add("application/javascript");
        blocked.add("text/javascript");
        blocked.add("application/x-javascript");
        blocked.add("application/vnd.android.package-archive");
        blocked.add("application/java-archive");
        blocked.add("application/x-sh");
        blocked.add("application/x-shellscript");
        blocked.add("application/x-executable");
        blocked.add("application/x-msdownload");
        blocked.add("text/xml");
        blocked.add("application/xml");
        BLOCKED_MIMES = Collections.unmodifiableSet(blocked);
    }

    private static String sanitizeFilename(String raw) {
        String base = raw == null ? "" : raw.trim();
        int slash = Math.max(base.lastIndexOf('/'), base.lastIndexOf('\\'));
        if (slash >= 0) base = base.substring(slash + 1);
        base = base.replaceAll("[^a-zA-Z0-9._\\u4e00-\\u9fa5-]", "_").replaceAll("^\\.+", "");
        if (base.isEmpty()) return "allinone-file.bin";
        if (base.length() <= 120) return base;
        int dot = base.lastIndexOf('.');
        if (dot > 0 && dot < base.length() - 1) {
            String ext = base.substring(dot); // includes leading '.'
            if (ext.length() <= 16) {
                int maxStem = Math.max(1, 120 - ext.length());
                return base.substring(0, Math.min(dot, maxStem)) + ext;
            }
        }
        return base.substring(0, 120);
    }

    private static String extractExtension(String filename) {
        if (filename == null) return "";
        int dot = filename.lastIndexOf('.');
        if (dot <= 0 || dot >= filename.length() - 1) return "";
        return filename.substring(dot + 1).toLowerCase(Locale.ROOT);
    }

    private static String resolveSafeMimeType(String filename, String rawMime) {
        String ext = extractExtension(filename);
        String canonical = ALLOWED_EXT_MIME.get(ext);
        if (canonical == null) {
            return null;
        }
        String norm = rawMime == null ? "" : rawMime.trim().toLowerCase(Locale.ROOT);
        int semi = norm.indexOf(';');
        if (semi >= 0) norm = norm.substring(0, semi).trim();
        if (norm.isEmpty() || "application/octet-stream".equals(norm)) {
            return canonical;
        }
        if (BLOCKED_MIMES.contains(norm)) {
            return null;
        }
        if ("text/html".equals(norm) && !"html".equals(ext) && !"htm".equals(ext)) {
            return null;
        }
        if ("image/svg+xml".equals(norm) && !"svg".equals(ext)) {
            return null;
        }
        int slashIdx = canonical.indexOf('/');
        String expectedPrefix = slashIdx > 0 ? canonical.substring(0, slashIdx + 1) : "";
        if (norm.startsWith(expectedPrefix)) {
            return norm;
        }
        if ("json".equals(ext) && "text/plain".equals(norm)) {
            return norm;
        }
        if ("rtf".equals(ext) && "text/rtf".equals(norm)) {
            return norm;
        }
        return null;
    }

    private static void deleteRecursively(File target) {
        if (target == null || !target.exists()) return;
        if (target.isDirectory()) {
            File[] children = target.listFiles();
            if (children != null) {
                for (File child : children) {
                    deleteRecursively(child);
                }
            }
        }
        //noinspection ResultOfMethodCallIgnored
        target.delete();
    }

    private void pruneShareCache(File dir) {
        File[] entries = dir.listFiles();
        if (entries == null) return;
        long cutoff = System.currentTimeMillis() - STALE_CACHE_MS;
        for (File entry : entries) {
            if (entry.lastModified() < cutoff) {
                deleteRecursively(entry);
            }
        }
    }

    private void reapExpiredExports() {
        long cutoff = System.currentTimeMillis() - EXPORT_SESSION_TTL_MS;
        for (Map.Entry<String, ExportSession> entry : activeExports.entrySet()) {
            ExportSession session = entry.getValue();
            if (session != null && session.lastActivityAt < cutoff) {
                if (activeExports.remove(entry.getKey(), session)) {
                    synchronized (session) {
                        abortExportSession(session);
                    }
                }
            }
        }
    }

    private void submitIo(PluginCall call, Runnable task) {
        if (isDestroyed.get() || ioExecutor.isShutdown()) {
            call.reject("Files plugin is shutting down");
            return;
        }
        try {
            ioExecutor.execute(() -> {
                if (isDestroyed.get()) {
                    call.reject("Files plugin is shutting down");
                    return;
                }
                task.run();
            });
        } catch (RejectedExecutionException err) {
            call.reject("Files plugin is shutting down");
        }
    }

    private void launchShareSheet(Context ctx, String filename, String mimeType, Uri contentUri) {
        Intent sendIntent = new Intent(Intent.ACTION_SEND);
        sendIntent.setType(mimeType);
        sendIntent.putExtra(Intent.EXTRA_STREAM, contentUri);
        sendIntent.putExtra(Intent.EXTRA_SUBJECT, filename);
        sendIntent.setClipData(ClipData.newRawUri(filename, contentUri));
        sendIntent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        Intent chooser = Intent.createChooser(sendIntent, filename);
        chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_GRANT_READ_URI_PERMISSION);
        Activity act = getActivity();
        if (act != null && !act.isFinishing()) {
            act.runOnUiThread(() -> {
                try {
                    act.startActivity(chooser);
                } catch (Exception ignored) {
                    ctx.startActivity(chooser);
                }
            });
        } else {
            ctx.startActivity(chooser);
        }
    }

    @PluginMethod
    public void clearSharedCache(PluginCall call) {
        final Context ctx = getContext();
        submitIo(call, () -> {
            try {
                reapExpiredExports();
                File shareDir = new File(ctx.getCacheDir(), "allinone_shared");
                if (shareDir.exists()) {
                    File[] children = shareDir.listFiles();
                    if (children != null) {
                        for (File child : children) {
                            deleteRecursively(child);
                        }
                    }
                }
                JSObject ret = new JSObject();
                ret.put("ok", true);
                call.resolve(ret);
            } catch (Exception err) {
                call.reject("Failed to clear shared cache: " + err.getMessage());
            }
        });
    }

    private void showToastSafe(Context ctx, String text) {
        Activity act = getActivity();
        if (act != null && !act.isFinishing()) {
            act.runOnUiThread(() -> Toast.makeText(ctx, text, Toast.LENGTH_SHORT).show());
        }
    }

    private void abortExportSession(ExportSession session) {
        if (session == null || session.aborted) return;
        session.aborted = true;
        try { session.stream.close(); } catch (Exception ignored) {}
        if (session.mediaStoreUri != null) {
            try {
                getContext().getContentResolver().delete(session.mediaStoreUri, null, null);
            } catch (Exception ignored) {}
        }
        if (session.tempDir != null) {
            deleteRecursively(session.tempDir);
        }
    }

    @Override
    protected void handleOnDestroy() {
        isDestroyed.set(true);
        ioExecutor.shutdownNow();
        for (String id : activeExports.keySet()) {
            ExportSession s = activeExports.remove(id);
            if (s != null) {
                synchronized (s) {
                    abortExportSession(s);
                }
            }
        }
        super.handleOnDestroy();
    }

    @PluginMethod
    public void openExport(PluginCall call) {
        final String filename = sanitizeFilename(call.getString("filename", "document"));
        final String rawMime = call.getString("mimeType", "application/octet-stream");
        final String mimeType = resolveSafeMimeType(filename, rawMime);
        if (mimeType == null) {
            call.reject("Blocked or unsupported file type");
            return;
        }
        final String mode = "share".equals(call.getString("mode", "save")) ? "share" : "save";
        final Context ctx = getContext();

        submitIo(call, () -> {
            reapExpiredExports();
            if (activeExports.size() >= MAX_CONCURRENT_EXPORTS) {
                call.reject("Too many concurrent exports in progress");
                return;
            }

            Uri mediaStoreUri = null;
            File tempDir = null;
            File tempFile = null;
            OutputStream out = null;

            try {
                if ("save".equals(mode) && Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    ContentResolver resolver = ctx.getContentResolver();
                    ContentValues values = new ContentValues();
                    values.put(MediaStore.MediaColumns.DISPLAY_NAME, filename);
                    values.put(MediaStore.MediaColumns.MIME_TYPE, mimeType);
                    values.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/AllinOne");
                    values.put(MediaStore.MediaColumns.IS_PENDING, 1);
                    Uri uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
                    if (uri != null) {
                        OutputStream msOut = resolver.openOutputStream(uri);
                        if (msOut != null) {
                            mediaStoreUri = uri;
                            out = new BufferedOutputStream(msOut, 65536);
                        } else {
                            try { resolver.delete(uri, null, null); } catch (Exception ignored) {}
                        }
                    }
                }
                if (out == null) {
                    File shareDir = new File(ctx.getCacheDir(), "allinone_shared");
                    if (!shareDir.exists()) {
                        //noinspection ResultOfMethodCallIgnored
                        shareDir.mkdirs();
                    }
                    pruneShareCache(shareDir);
                    tempDir = new File(shareDir, UUID.randomUUID().toString());
                    if (!tempDir.mkdirs()) {
                        throw new IllegalStateException("Could not create isolated export directory");
                    }
                    tempFile = new File(tempDir, filename);
                    out = new BufferedOutputStream(new FileOutputStream(tempFile), 65536);
                }
                String exportId = UUID.randomUUID().toString();
                activeExports.put(exportId, new ExportSession(filename, mimeType, mode, mediaStoreUri, tempDir, tempFile, out));
                JSObject ret = new JSObject();
                ret.put("exportId", exportId);
                call.resolve(ret);
            } catch (Exception err) {
                if (out != null) {
                    try { out.close(); } catch (Exception ignored) {}
                }
                if (mediaStoreUri != null) {
                    try { ctx.getContentResolver().delete(mediaStoreUri, null, null); } catch (Exception ignored) {}
                }
                if (tempDir != null) {
                    deleteRecursively(tempDir);
                }
                call.reject("Failed to open export stream: " + err.getMessage());
            }
        });
    }

    @PluginMethod
    public void writeExportChunk(PluginCall call) {
        final String exportId = call.getString("exportId", "");
        final String chunkBase64 = call.getString("chunkBase64", "");
        if (exportId == null || exportId.isEmpty()) {
            call.reject("Missing exportId");
            return;
        }
        if (chunkBase64 != null && chunkBase64.length() > MAX_CHUNK_BASE64_LENGTH) {
            call.reject("Export chunk exceeds maximum allowed chunk size");
            return;
        }
        if (chunkBase64 == null || chunkBase64.isEmpty()) {
            ExportSession existing = activeExports.get(exportId);
            if (existing == null) {
                call.reject("Unknown or closed export session");
                return;
            }
            existing.lastActivityAt = System.currentTimeMillis();
            JSObject ret = new JSObject();
            ret.put("ok", true);
            call.resolve(ret);
            return;
        }

        submitIo(call, () -> {
            reapExpiredExports();
            ExportSession session = activeExports.get(exportId);
            if (session == null) {
                call.reject("Unknown or closed export session");
                return;
            }
            byte[] bytes;
            try {
                bytes = Base64.decode(chunkBase64, Base64.DEFAULT);
            } catch (IllegalArgumentException err) {
                call.reject("Invalid base64 chunk");
                return;
            }
            synchronized (session) {
                if (session.aborted) {
                    call.reject("Export session was closed");
                    return;
                }
                if (session.totalBytes + bytes.length > MAX_STREAM_EXPORT_BYTES) {
                    activeExports.remove(exportId, session);
                    abortExportSession(session);
                    call.reject("File exceeds maximum allowed streaming export size (2 GB)");
                    return;
                }
                try {
                    session.stream.write(bytes);
                    session.totalBytes += bytes.length;
                    session.lastActivityAt = System.currentTimeMillis();
                    JSObject ret = new JSObject();
                    ret.put("ok", true);
                    ret.put("totalBytes", session.totalBytes);
                    call.resolve(ret);
                } catch (Exception err) {
                    activeExports.remove(exportId, session);
                    abortExportSession(session);
                    call.reject("Failed writing export chunk: " + err.getMessage());
                }
            }
        });
    }

    @PluginMethod
    public void finishExport(PluginCall call) {
        final String exportId = call.getString("exportId", "");
        final boolean cancel = Boolean.TRUE.equals(call.getBoolean("cancel", false));
        final Context ctx = getContext();

        submitIo(call, () -> {
            ExportSession session = exportId != null ? activeExports.remove(exportId) : null;
            if (session == null) {
                if (cancel) {
                    JSObject ret = new JSObject();
                    ret.put("ok", true);
                    call.resolve(ret);
                } else {
                    call.reject("Unknown export session");
                }
                return;
            }
            synchronized (session) {
                if (cancel) {
                    abortExportSession(session);
                    JSObject ret = new JSObject();
                    ret.put("ok", true);
                    call.resolve(ret);
                    return;
                }
                try {
                    session.stream.flush();
                    session.stream.close();
                    if (session.mediaStoreUri != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                        ContentValues doneVals = new ContentValues();
                        doneVals.put(MediaStore.MediaColumns.IS_PENDING, 0);
                        ctx.getContentResolver().update(session.mediaStoreUri, doneVals, null, null);
                        showToastSafe(ctx, "Saved to Downloads/AllinOne/" + session.filename);
                        JSObject ret = new JSObject();
                        ret.put("ok", true);
                        ret.put("uri", session.mediaStoreUri.toString());
                        call.resolve(ret);
                        return;
                    }
                    Uri contentUri = FileProvider.getUriForFile(ctx, ctx.getPackageName() + ".fileprovider", session.tempFile);
                    launchShareSheet(ctx, session.filename, session.mimeType, contentUri);
                    JSObject ret = new JSObject();
                    ret.put("ok", true);
                    ret.put("uri", contentUri.toString());
                    call.resolve(ret);
                } catch (Exception err) {
                    abortExportSession(session);
                    call.reject("Failed to finalize export: " + err.getMessage());
                }
            }
        });
    }

    @PluginMethod
    public void saveAndShare(PluginCall call) {
        final String dataBase64 = call.getString("dataBase64", "");
        if (dataBase64 == null || dataBase64.isEmpty()) {
            call.reject("Missing file data");
            return;
        }
        if (dataBase64.length() > MAX_BASE64_LENGTH) {
            call.reject("File exceeds maximum allowed size (50 MB)");
            return;
        }
        final String filename = sanitizeFilename(call.getString("filename", "document"));
        final String rawMime = call.getString("mimeType", "application/octet-stream");
        final String mimeType = resolveSafeMimeType(filename, rawMime);
        if (mimeType == null) {
            call.reject("Blocked or unsupported file type");
            return;
        }
        final String mode = call.getString("mode", "save");
        final Context ctx = getContext();

        submitIo(call, () -> {
            byte[] bytes;
            try {
                bytes = Base64.decode(dataBase64, Base64.DEFAULT);
            } catch (IllegalArgumentException err) {
                call.reject("Invalid base64 payload");
                return;
            }
            if (bytes.length > MAX_DECODED_BYTES) {
                call.reject("File exceeds maximum allowed size (50 MB)");
                return;
            }

            if ("save".equals(mode) && Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                Uri insertedUri = null;
                try {
                    ContentResolver resolver = ctx.getContentResolver();
                    ContentValues values = new ContentValues();
                    values.put(MediaStore.MediaColumns.DISPLAY_NAME, filename);
                    values.put(MediaStore.MediaColumns.MIME_TYPE, mimeType);
                    values.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/AllinOne");
                    values.put(MediaStore.MediaColumns.IS_PENDING, 1);
                    insertedUri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
                    if (insertedUri != null) {
                        try (OutputStream out = resolver.openOutputStream(insertedUri)) {
                            if (out == null) throw new IllegalStateException("Could not open MediaStore stream");
                            out.write(bytes);
                            out.flush();
                        }
                        ContentValues doneVals = new ContentValues();
                        doneVals.put(MediaStore.MediaColumns.IS_PENDING, 0);
                        resolver.update(insertedUri, doneVals, null, null);
                        showToastSafe(ctx, "Saved to Downloads/AllinOne/" + filename);
                        JSObject ret = new JSObject();
                        ret.put("ok", true);
                        ret.put("uri", insertedUri.toString());
                        call.resolve(ret);
                        return;
                    }
                } catch (Exception ignored) {
                    if (insertedUri != null) {
                        try {
                            ctx.getContentResolver().delete(insertedUri, null, null);
                        } catch (Exception ignoredDelete) {}
                    }
                    // Fall back to FileProvider share chooser below
                }
            }

            File isolatedDir = null;
            try {
                File shareDir = new File(ctx.getCacheDir(), "allinone_shared");
                if (!shareDir.exists()) {
                    //noinspection ResultOfMethodCallIgnored
                    shareDir.mkdirs();
                }
                pruneShareCache(shareDir);
                isolatedDir = new File(shareDir, UUID.randomUUID().toString());
                if (!isolatedDir.mkdirs()) {
                    throw new IllegalStateException("Could not create isolated share directory");
                }
                File outFile = new File(isolatedDir, filename);
                try (FileOutputStream fos = new FileOutputStream(outFile)) {
                    fos.write(bytes);
                    fos.flush();
                }
                Uri contentUri = FileProvider.getUriForFile(ctx, ctx.getPackageName() + ".fileprovider", outFile);
                launchShareSheet(ctx, filename, mimeType, contentUri);

                JSObject ret = new JSObject();
                ret.put("ok", true);
                ret.put("uri", contentUri.toString());
                call.resolve(ret);
            } catch (Exception err) {
                if (isolatedDir != null) {
                    deleteRecursively(isolatedDir);
                }
                call.reject("Failed to export file: " + err.getMessage());
            }
        });
    }
}
