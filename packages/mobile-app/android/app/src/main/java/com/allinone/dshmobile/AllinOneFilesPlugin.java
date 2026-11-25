package com.allinone.dshmobile;

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

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;

/**
 * Lightweight zero-dependency Capacitor bridge allowing decrypted E2EE deliverables & images
 * to be saved into Android Downloads (MediaStore) or shared via the system share sheet (FileProvider),
 * working around Android System WebView ignoring `<a download="blob:...">` and lacking `navigator.share`.
 */
@CapacitorPlugin(name = "AllinOneFiles")
public class AllinOneFilesPlugin extends Plugin {
    private static final long STALE_CACHE_MS = 2L * 60L * 60L * 1000L;

    private static String sanitizeFilename(String raw) {
        String base = raw == null ? "" : raw.trim();
        int slash = Math.max(base.lastIndexOf('/'), base.lastIndexOf('\\'));
        if (slash >= 0) base = base.substring(slash + 1);
        base = base.replaceAll("[^a-zA-Z0-9._\\u4e00-\\u9fa5-]", "_").replaceAll("^\\.+", "");
        if (base.isEmpty()) return "allinone-file.bin";
        return base.length() > 120 ? base.substring(0, 120) : base;
    }

    private void pruneShareCache(File dir) {
        File[] files = dir.listFiles();
        if (files == null) return;
        long cutoff = System.currentTimeMillis() - STALE_CACHE_MS;
        for (File f : files) {
            if (f.isFile() && f.lastModified() < cutoff) {
                //noinspection ResultOfMethodCallIgnored
                f.delete();
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
        String filename = sanitizeFilename(call.getString("filename", "document"));
        String mimeType = call.getString("mimeType", "application/octet-stream");
        if (mimeType == null || mimeType.trim().isEmpty()) {
            mimeType = "application/octet-stream";
        }
        String mode = call.getString("mode", "save");

        byte[] bytes;
        try {
            bytes = Base64.decode(dataBase64, Base64.DEFAULT);
        } catch (IllegalArgumentException err) {
            call.reject("Invalid base64 payload");
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
                    final String savedName = filename;
                    getActivity().runOnUiThread(() ->
                        Toast.makeText(ctx, "Saved to Downloads/AllinOne/" + savedName, Toast.LENGTH_SHORT).show()
                    );
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
            File outFile = new File(shareDir, filename);
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
