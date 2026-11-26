package com.allinone.dshmobile;

import android.app.Activity;
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

/**
 * Lightweight zero-dependency Capacitor bridge allowing decrypted E2EE deliverables & images
 * to be saved into Android Downloads (MediaStore) or shared via the system share sheet (FileProvider),
 * working around Android System WebView ignoring `<a download="blob:...">` and lacking `navigator.share`.
 */
@CapacitorPlugin(name = "AllinOneFiles")
public class AllinOneFilesPlugin extends Plugin {
    private static final long STALE_CACHE_MS = 2L * 60L * 60L * 1000L;
    private static final int MAX_BASE64_LENGTH = 68 * 1024 * 1024; // ~50 MB decoded
    private static final int MAX_DECODED_BYTES = 50 * 1024 * 1024;
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

        ExportSession(String filename, String mimeType, String mode, Uri mediaStoreUri, File tempDir, File tempFile, OutputStream stream) {
            this.filename = filename;
            this.mimeType = mimeType;
            this.mode = mode;
            this.mediaStoreUri = mediaStoreUri;
            this.tempDir = tempDir;
            this.tempFile = tempFile;
            this.stream = stream;
        }
    }

    private final ConcurrentHashMap<String, ExportSession> activeExports = new ConcurrentHashMap<>();

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
        blocked.add("text/html");
        blocked.add("application/xhtml+xml");
        blocked.add("image/svg+xml");
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
        return base.length() > 120 ? base.substring(0, 120) : base;
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

    @PluginMethod
    public void clearSharedCache(PluginCall call) {
        try {
            Context ctx = getContext();
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
    }

    private void showToastSafe(Context ctx, String text) {
        Activity act = getActivity();
        if (act != null && !act.isFinishing()) {
            act.runOnUiThread(() -> Toast.makeText(ctx, text, Toast.LENGTH_SHORT).show());
        }
    }

    private void abortExportSession(ExportSession session) {
        if (session == null) return;
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
        for (String id : activeExports.keySet()) {
            ExportSession s = activeExports.remove(id);
            abortExportSession(s);
        }
        super.handleOnDestroy();
    }

    @PluginMethod
    public void openExport(PluginCall call) {
        if (activeExports.size() >= MAX_CONCURRENT_EXPORTS) {
            call.reject("Too many concurrent exports in progress");
            return;
        }
        String filename = sanitizeFilename(call.getString("filename", "document"));
        String rawMime = call.getString("mimeType", "application/octet-stream");
        String mimeType = resolveSafeMimeType(filename, rawMime);
        if (mimeType == null) {
            call.reject("Blocked or unsupported file type");
            return;
        }
        String mode = "share".equals(call.getString("mode", "save")) ? "share" : "save";
        Context ctx = getContext();

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
    }

    @PluginMethod
    public void writeExportChunk(PluginCall call) {
        String exportId = call.getString("exportId", "");
        String chunkBase64 = call.getString("chunkBase64", "");
        if (exportId == null || exportId.isEmpty()) {
            call.reject("Missing exportId");
            return;
        }
        ExportSession session = activeExports.get(exportId);
        if (session == null) {
            call.reject("Unknown or closed export session");
            return;
        }
        if (chunkBase64 == null || chunkBase64.isEmpty()) {
            JSObject ret = new JSObject();
            ret.put("ok", true);
            call.resolve(ret);
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
            if (session.totalBytes + bytes.length > MAX_DECODED_BYTES) {
                activeExports.remove(exportId);
                abortExportSession(session);
                call.reject("File exceeds maximum allowed size (50 MB)");
                return;
            }
            try {
                session.stream.write(bytes);
                session.totalBytes += bytes.length;
                JSObject ret = new JSObject();
                ret.put("ok", true);
                ret.put("totalBytes", session.totalBytes);
                call.resolve(ret);
            } catch (Exception err) {
                activeExports.remove(exportId);
                abortExportSession(session);
                call.reject("Failed writing export chunk: " + err.getMessage());
            }
        }
    }

    @PluginMethod
    public void finishExport(PluginCall call) {
        String exportId = call.getString("exportId", "");
        boolean cancel = Boolean.TRUE.equals(call.getBoolean("cancel", false));
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
            Context ctx = getContext();
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
                Intent sendIntent = new Intent(Intent.ACTION_SEND);
                sendIntent.setType(session.mimeType);
                sendIntent.putExtra(Intent.EXTRA_STREAM, contentUri);
                sendIntent.putExtra(Intent.EXTRA_SUBJECT, session.filename);
                sendIntent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                Intent chooser = Intent.createChooser(sendIntent, session.filename);
                chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                ctx.startActivity(chooser);
                JSObject ret = new JSObject();
                ret.put("ok", true);
                ret.put("uri", contentUri.toString());
                call.resolve(ret);
            } catch (Exception err) {
                abortExportSession(session);
                call.reject("Failed to finalize export: " + err.getMessage());
            }
        }
    }

    @PluginMethod
    public void saveAndShare(PluginCall call) {
        String dataBase64 = call.getString("dataBase64", "");
        if (dataBase64 == null || dataBase64.isEmpty()) {
            call.reject("Missing file data");
            return;
        }
        if (dataBase64.length() > MAX_BASE64_LENGTH) {
            call.reject("File exceeds maximum allowed size (50 MB)");
            return;
        }
        String filename = sanitizeFilename(call.getString("filename", "document"));
        String rawMime = call.getString("mimeType", "application/octet-stream");
        String mimeType = resolveSafeMimeType(filename, rawMime);
        if (mimeType == null) {
            call.reject("Blocked or unsupported file type");
            return;
        }
        String mode = call.getString("mode", "save");

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

        Context ctx = getContext();
        if ("save".equals(mode) && Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            try {
                ContentResolver resolver = ctx.getContentResolver();
                ContentValues values = new ContentValues();
                values.put(MediaStore.MediaColumns.DISPLAY_NAME, filename);
                values.put(MediaStore.MediaColumns.MIME_TYPE, mimeType);
                values.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/AllinOne");
                Uri uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
                if (uri != null) {
                    try (OutputStream out = resolver.openOutputStream(uri)) {
                        if (out == null) throw new IllegalStateException("Could not open MediaStore stream");
                        out.write(bytes);
                        out.flush();
                    }
                    showToastSafe(ctx, "Saved to Downloads/AllinOne/" + filename);
                    JSObject ret = new JSObject();
                    ret.put("ok", true);
                    ret.put("uri", uri.toString());
                    call.resolve(ret);
                    return;
                }
            } catch (Exception ignored) {
                // Fall back to FileProvider share chooser below
            }
        }

        try {
            File shareDir = new File(ctx.getCacheDir(), "allinone_shared");
            if (!shareDir.exists()) {
                //noinspection ResultOfMethodCallIgnored
                shareDir.mkdirs();
            }
            pruneShareCache(shareDir);
            File isolatedDir = new File(shareDir, UUID.randomUUID().toString());
            if (!isolatedDir.mkdirs()) {
                throw new IllegalStateException("Could not create isolated share directory");
            }
            File outFile = new File(isolatedDir, filename);
            try (FileOutputStream fos = new FileOutputStream(outFile)) {
                fos.write(bytes);
                fos.flush();
            }
            Uri contentUri = FileProvider.getUriForFile(ctx, ctx.getPackageName() + ".fileprovider", outFile);
            Intent sendIntent = new Intent(Intent.ACTION_SEND);
            sendIntent.setType(mimeType);
            sendIntent.putExtra(Intent.EXTRA_STREAM, contentUri);
            sendIntent.putExtra(Intent.EXTRA_SUBJECT, filename);
            sendIntent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            Intent chooser = Intent.createChooser(sendIntent, filename);
            chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            ctx.startActivity(chooser);

            JSObject ret = new JSObject();
            ret.put("ok", true);
            ret.put("uri", contentUri.toString());
            call.resolve(ret);
        } catch (Exception err) {
            call.reject("Failed to export file: " + err.getMessage());
        }
    }
}
