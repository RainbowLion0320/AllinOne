package com.allinone.dshmobile;

import android.app.Activity;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.content.pm.SigningInfo;
import android.os.Build;
import android.util.Base64;
import android.webkit.WebView;

import androidx.core.content.pm.PackageInfoCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.URI;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.PublicKey;
import java.security.cert.CertificateFactory;
import java.security.cert.X509Certificate;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import java.util.regex.Pattern;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/**
 * Cryptographically verified, zero-dependency OTA hot-update plugin for All in One Android.
 *
 * Security model (preserves zero-knowledge E2EE):
 *  - Every OTA bundle MUST pass APK-cert asymmetric signature verification BEFORE downloading
 *    (with mandatory positive expectedSize) and again against actual downloaded SHA-256 + byte size.
 *  - Native `fetchManifest` bypasses Android WebView CORS restrictions for GitHub Releases while
 *    strictly enforcing HTTPS-only, non-private/non-loopback IP checks, host allowlisting,
 *    manual redirect validation (max 5 hops), and a 256 KB body size cap.
 *  - All state transitions and bundle directory swaps are synchronized via `stateLock`.
 *  - Atomic extraction with Zip-Slip & Zip-Bomb limits + automatic boot-failure rollback guard.
 */
@CapacitorPlugin(name = "AllinOneUpdater")
public class AllinOneUpdaterPlugin extends Plugin {
    private static final String OTA_PREFS = "AllinOneOtaPrefs";
    private static final String KEY_APK_VERSION_CODE = "apkVersionCode";
    private static final String KEY_ACTIVE_VERSION = "activeVersion";
    private static final String KEY_ACTIVE_PATH = "activePath";
    private static final String KEY_PREVIOUS_VERSION = "previousVersion";
    private static final String KEY_PREVIOUS_PATH = "previousPath";
    private static final String KEY_STAGED_VERSION = "stagedVersion";
    private static final String KEY_STAGED_PATH = "stagedPath";
    private static final String KEY_PENDING_VERSION = "pendingVersion";
    private static final String KEY_PENDING_PATH = "pendingPath";
    private static final String KEY_PENDING_ATTEMPTS = "pendingBootAttempts";

    private static final String GITHUB_RELEASE_PATH_PREFIX = "/rainbowlion0320/allinone/releases/download/";

    private static final String BUNDLES_DIR_NAME = "ota_bundles";
    private static final String TMP_DIR_NAME = "ota_tmp";

    private static final long MAX_ZIP_BYTES = 50L * 1024L * 1024L;
    private static final long MAX_UNZIPPED_BYTES = 120L * 1024L * 1024L;
    private static final int MAX_MANIFEST_BYTES = 256 * 1024;
    private static final int MAX_ZIP_ENTRIES = 2500;
    private static final int MAX_REDIRECTS = 5;
    private static final int CONNECT_TIMEOUT_MS = 15_000;
    private static final int READ_TIMEOUT_MS = 30_000;
    private static final int DEFAULT_MANIFEST_TIMEOUT_MS = 15_000;
    private static final int MAX_PENDING_BOOT_ATTEMPTS = 2;

    private static final Pattern SAFE_SEMVER_RE =
        Pattern.compile("^[0-9]+\\.[0-9]+\\.[0-9]+(?:-[0-9A-Za-z.-]+)?$");
    private static final Pattern SHA256_HEX_RE =
        Pattern.compile("^[0-9a-fA-F]{64}$");

    private static final Set<String> ALLOWED_SIG_ALGS = Collections.unmodifiableSet(
        new HashSet<>(Arrays.asList(
            "SHA256withRSA",
            "SHA512withRSA",
            "SHA256withECDSA",
            "SHA384withECDSA"
        ))
    );

    private static final Set<String> TRUSTED_GITHUB_HOSTS = Collections.unmodifiableSet(
        new HashSet<>(Arrays.asList(
            "github.com",
            "api.github.com",
            "objects.githubusercontent.com",
            "release-assets.githubusercontent.com",
            "github-releases.githubusercontent.com",
            "raw.githubusercontent.com"
        ))
    );

    private static final Set<String> ALLOWED_MANIFEST_REQ_HEADERS = Collections.unmodifiableSet(
        new HashSet<>(Arrays.asList(
            "accept",
            "if-none-match",
            "cache-control"
        ))
    );

    private final Object stateLock = new Object();
    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private final ExecutorService manifestExecutor = Executors.newFixedThreadPool(2);
    private final AtomicBoolean isDestroyed = new AtomicBoolean(false);
    private final AtomicInteger downloadSeq = new AtomicInteger(0);
    private final AtomicReference<HttpURLConnection> activeConnection = new AtomicReference<>(null);
    private int activeDownloadSeq = 0; // Guarded by stateLock

    /**
     * Called from MainActivity.onCreate() BEFORE super.onCreate() so any boot-looping OTA
     * bundle is rolled back before Capacitor's Bridge loads WebView assets.
     */
    public static void prepareBootGuard(Context ctx) {
        if (ctx == null) return;
        try {
            SharedPreferences otaPrefs = ctx.getSharedPreferences(OTA_PREFS, Activity.MODE_PRIVATE);
            SharedPreferences capPrefs = ctx.getSharedPreferences(
                com.getcapacitor.plugin.WebView.WEBVIEW_PREFS_NAME,
                Activity.MODE_PRIVATE
            );

            long currentCode = readApkVersionCode(ctx);
            long savedCode = otaPrefs.getLong(KEY_APK_VERSION_CODE, -1L);
            if (savedCode > 0L && currentCode > 0L && savedCode != currentCode) {
                // Native APK was upgraded — discard older OTA bundles & stale WebView SW/CacheStorage.
                otaPrefs.edit().clear().putLong(KEY_APK_VERSION_CODE, currentCode).commit();
                capPrefs.edit().remove(com.getcapacitor.plugin.WebView.CAP_SERVER_PATH).commit();
                deleteRecursively(new File(ctx.getFilesDir(), BUNDLES_DIR_NAME));
                deleteRecursively(new File(ctx.getFilesDir(), TMP_DIR_NAME));
                purgeWebViewServiceWorkerStorage(ctx);
                return;
            }
            if (savedCode <= 0L && currentCode > 0L) {
                otaPrefs.edit().putLong(KEY_APK_VERSION_CODE, currentCode).apply();
            }

            String pendingVersion = otaPrefs.getString(KEY_PENDING_VERSION, "");
            if (pendingVersion != null && !pendingVersion.isEmpty()) {
                int attempts = otaPrefs.getInt(KEY_PENDING_ATTEMPTS, 0) + 1;
                if (attempts > MAX_PENDING_BOOT_ATTEMPTS) {
                    // Roll back to previous working bundle (or built-in APK assets if none).
                    String prevPath = otaPrefs.getString(KEY_PREVIOUS_PATH, "");
                    String prevVer = otaPrefs.getString(KEY_PREVIOUS_VERSION, "");
                    String badPath = otaPrefs.getString(KEY_PENDING_PATH, "");
                    boolean hasValidPrev = prevPath != null && !prevPath.isEmpty() && isValidBundleDir(new File(prevPath));
                    SharedPreferences.Editor capEd = capPrefs.edit();
                    if (hasValidPrev) {
                        capEd.putString(com.getcapacitor.plugin.WebView.CAP_SERVER_PATH, prevPath);
                    } else {
                        capEd.remove(com.getcapacitor.plugin.WebView.CAP_SERVER_PATH);
                    }
                    capEd.commit();

                    SharedPreferences.Editor otaEd = otaPrefs.edit();
                    otaEd.remove(KEY_PENDING_VERSION);
                    otaEd.remove(KEY_PENDING_PATH);
                    otaEd.remove(KEY_PENDING_ATTEMPTS);
                    if (hasValidPrev) {
                        otaEd.putString(KEY_ACTIVE_PATH, prevPath);
                        if (prevVer != null && !prevVer.isEmpty()) {
                            otaEd.putString(KEY_ACTIVE_VERSION, prevVer);
                        } else {
                            otaEd.remove(KEY_ACTIVE_VERSION);
                        }
                    } else {
                        otaEd.remove(KEY_ACTIVE_PATH);
                        otaEd.remove(KEY_ACTIVE_VERSION);
                    }
                    otaEd.commit();
                    purgeWebViewServiceWorkerStorage(ctx);

                    if (badPath != null && !badPath.isEmpty()) {
                        File badDir = new File(badPath);
                        File bundlesRoot = new File(ctx.getFilesDir(), BUNDLES_DIR_NAME);
                        if (isDirectChildOf(badDir, bundlesRoot)) {
                            deleteRecursively(badDir);
                        }
                    }
                } else {
                    otaPrefs.edit().putInt(KEY_PENDING_ATTEMPTS, attempts).commit();
                }
            }
        } catch (Exception ignored) {
            // Never prevent app launch on preferences error
        }
    }

    @Override
    protected void handleOnDestroy() {
        isDestroyed.set(true);
        synchronized (stateLock) {
            cancelActiveDownloadLocked();
        }
        executor.shutdownNow();
        manifestExecutor.shutdownNow();
        super.handleOnDestroy();
    }

    private static long readApkVersionCode(Context ctx) {
        try {
            PackageInfo pi = ctx.getPackageManager().getPackageInfo(ctx.getPackageName(), 0);
            return PackageInfoCompat.getLongVersionCode(pi);
        } catch (Exception ignored) {
            return 0L;
        }
    }

    private static String readApkVersionName(Context ctx) {
        try {
            PackageInfo pi = ctx.getPackageManager().getPackageInfo(ctx.getPackageName(), 0);
            return pi.versionName != null ? pi.versionName.trim() : "";
        } catch (Exception ignored) {
            return "";
        }
    }

    private static boolean isValidBundleDir(File dir) {
        if (dir == null || !dir.isDirectory()) return false;
        File indexHtml = new File(dir, "index.html");
        return indexHtml.isFile() && indexHtml.length() > 0L;
    }

    private static boolean isDirectChildOf(File child, File parent) {
        try {
            File canonicalParent = parent.getCanonicalFile();
            File canonicalChild = child.getCanonicalFile();
            File childParent = canonicalChild.getParentFile();
            return childParent != null && childParent.equals(canonicalParent);
        } catch (IOException ignored) {
            return false;
        }
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

    private static void purgeWebViewServiceWorkerStorage(Context ctx) {
        try {
            File appData = ctx.getFilesDir().getParentFile();
            if (appData == null) return;
            File webViewDefault = new File(new File(appData, "app_webview"), "Default");
            deleteRecursively(new File(webViewDefault, "Service Worker"));
            deleteRecursively(new File(webViewDefault, "CacheStorage"));
        } catch (Exception ignored) {}
    }

    private static int compareSemver(String rawA, String rawB) {
        String a = rawA == null ? "" : rawA.trim().replaceFirst("^[vV]", "");
        String b = rawB == null ? "" : rawB.trim().replaceFirst("^[vV]", "");
        String[] aSplit = a.split("-", 2);
        String[] bSplit = b.split("-", 2);
        String[] aNums = aSplit[0].split("\\.");
        String[] bNums = bSplit[0].split("\\.");
        if (aNums.length < 3 || bNums.length < 3) return 0;
        try {
            for (int i = 0; i < 3; i++) {
                int na = Integer.parseInt(aNums[i]);
                int nb = Integer.parseInt(bNums[i]);
                if (na != nb) return Integer.compare(na, nb);
            }
        } catch (NumberFormatException ignored) {
            return 0;
        }
        String aPre = aSplit.length > 1 ? aSplit[1] : "";
        String bPre = bSplit.length > 1 ? bSplit[1] : "";
        if (aPre.equals(bPre)) return 0;
        if (aPre.isEmpty()) return 1;
        if (bPre.isEmpty()) return -1;
        return aPre.compareTo(bPre);
    }

    private static boolean isTrustedGithubHost(String rawHost) {
        if (rawHost == null) return false;
        String host = rawHost.trim().toLowerCase(Locale.ROOT);
        if (host.isEmpty()) return false;
        if (TRUSTED_GITHUB_HOSTS.contains(host)) return true;
        return host.endsWith(".githubusercontent.com") || host.endsWith(".github.com");
    }

    private static boolean isAllowedGithubUrl(String rawUrl) {
        if (rawUrl == null || rawUrl.trim().isEmpty()) return false;
        try {
            URI uri = URI.create(rawUrl.trim());
            if (!"https".equalsIgnoreCase(uri.getScheme())) return false;
            if (uri.getUserInfo() != null) return false;
            String host = uri.getHost();
            if (!isTrustedGithubHost(host)) return false;
            if ("github.com".equalsIgnoreCase(host)) {
                String path = uri.getRawPath() != null ? uri.getRawPath().toLowerCase(Locale.ROOT) : "";
                return path.startsWith(GITHUB_RELEASE_PATH_PREFIX);
            }
            return true;
        } catch (Exception ignored) {
            return false;
        }
    }

    private static String extractHttpsHost(String rawUrl) {
        if (rawUrl == null || rawUrl.trim().isEmpty()) return null;
        try {
            URI uri = URI.create(rawUrl.trim());
            if (!"https".equalsIgnoreCase(uri.getScheme())) return null;
            if (uri.getUserInfo() != null) return null;
            String host = uri.getHost();
            return (host != null && !host.isEmpty()) ? host.toLowerCase(Locale.ROOT) : null;
        } catch (Exception ignored) {
            return null;
        }
    }

    private static String normalizeAllowedHost(String rawAllowedHost) {
        if (rawAllowedHost == null) return null;
        String trimmed = rawAllowedHost.trim();
        if (trimmed.isEmpty()) return null;
        try {
            URI uri;
            if (trimmed.contains("://")) {
                uri = URI.create(trimmed);
                if (!"https".equalsIgnoreCase(uri.getScheme())) return null;
            } else {
                uri = URI.create("https://" + trimmed);
            }
            if (uri.getUserInfo() != null) return null;
            String host = uri.getHost();
            return (host != null && !host.isEmpty()) ? host.toLowerCase(Locale.ROOT) : null;
        } catch (Exception ignored) {
            return null;
        }
    }

    private static boolean isPrivateIpv4Bytes(byte[] b, int offset) {
        int b0 = b[offset] & 0xFF;
        int b1 = b[offset + 1] & 0xFF;
        int b2 = b[offset + 2] & 0xFF;
        if (b0 == 0 || b0 == 10 || b0 == 127) return true;
        if (b0 == 100 && (b1 & 0xC0) == 64) return true; // 100.64.0.0/10 CGNAT
        if (b0 == 169 && b1 == 254) return true; // 169.254.0.0/16 link-local
        if (b0 == 172 && (b1 & 0xF0) == 16) return true; // 172.16.0.0/12
        if (b0 == 192 && b1 == 0 && b2 == 0) return true; // 192.0.0.0/24
        if (b0 == 192 && b1 == 168) return true; // 192.168.0.0/16
        if (b0 == 198 && (b1 == 18 || b1 == 19)) return true; // 198.18.0.0/15
        if (b0 >= 224) return true; // multicast & reserved
        return false;
    }

    private static boolean isPrivateOrLoopbackAddress(InetAddress addr) {
        if (addr == null) return true;
        if (addr.isAnyLocalAddress()
            || addr.isLoopbackAddress()
            || addr.isLinkLocalAddress()
            || addr.isSiteLocalAddress()
            || addr.isMulticastAddress()) {
            return true;
        }
        byte[] b = addr.getAddress();
        if (b == null) return true;
        if (b.length == 4) {
            return isPrivateIpv4Bytes(b, 0);
        }
        if (b.length == 16) {
            int b0 = b[0] & 0xFF;
            int b1 = b[1] & 0xFF;
            // fc00::/7 Unique Local Addresses
            if ((b0 & 0xFE) == 0xFC) return true;
            // fe80::/10 link-local & fec0::/10 deprecated site-local
            if (b0 == 0xFE && ((b1 & 0xC0) == 0x80 || (b1 & 0xC0) == 0xC0)) return true;
            // ::ffff:0:0/96 IPv4-mapped IPv6
            boolean ipv4Mapped = true;
            for (int i = 0; i < 10; i++) {
                if (b[i] != 0) {
                    ipv4Mapped = false;
                    break;
                }
            }
            if (ipv4Mapped && (b[10] & 0xFF) == 0xFF && (b[11] & 0xFF) == 0xFF) {
                return isPrivateIpv4Bytes(b, 12);
            }
            // 64:ff9b::/96 NAT64 well-known prefix
            boolean nat64 = b[0] == 0 && (b[1] & 0xFF) == 0x64 && (b[2] & 0xFF) == 0xFF && (b[3] & 0xFF) == 0x9B;
            for (int i = 4; nat64 && i < 12; i++) {
                if (b[i] != 0) nat64 = false;
            }
            if (nat64) {
                return isPrivateIpv4Bytes(b, 12);
            }
        }
        return false;
    }

    private static void validateNonPrivateHost(String host) throws SecurityException {
        if (host == null || host.isEmpty()) {
            throw new SecurityException("Empty host");
        }
        String norm = host.toLowerCase(Locale.ROOT);
        if (norm.startsWith("[") && norm.endsWith("]")) {
            norm = norm.substring(1, norm.length() - 1);
        }
        if ("localhost".equals(norm)
            || norm.endsWith(".localhost")
            || norm.endsWith(".local")
            || norm.endsWith(".internal")
            || norm.endsWith(".home.arpa")) {
            throw new SecurityException("Blocked local/private host: " + host);
        }
        InetAddress[] addrs;
        try {
            addrs = InetAddress.getAllByName(norm);
        } catch (Exception err) {
            throw new SecurityException("Failed to resolve host: " + host);
        }
        if (addrs == null || addrs.length == 0) {
            throw new SecurityException("Failed to resolve host: " + host);
        }
        for (InetAddress addr : addrs) {
            if (isPrivateOrLoopbackAddress(addr)) {
                throw new SecurityException("Blocked loopback or private network host: " + host);
            }
        }
    }

    private static String bytesToHex(byte[] bytes) {
        StringBuilder sb = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) {
            sb.append(Character.forDigit((b >> 4) & 0xF, 16));
            sb.append(Character.forDigit(b & 0xF, 16));
        }
        return sb.toString();
    }

    @SuppressWarnings("deprecation")
    private List<PublicKey> getApkSigningPublicKeys() {
        List<PublicKey> keys = new ArrayList<>();
        try {
            Context ctx = getContext();
            PackageManager pm = ctx.getPackageManager();
            Signature[] sigs = null;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                PackageInfo pi = pm.getPackageInfo(ctx.getPackageName(), PackageManager.GET_SIGNING_CERTIFICATES);
                SigningInfo si = pi.signingInfo;
                if (si != null) {
                    sigs = si.hasMultipleSigners() ? si.getApkContentsSigners() : si.getSigningCertificateHistory();
                }
            } else {
                PackageInfo pi = pm.getPackageInfo(ctx.getPackageName(), PackageManager.GET_SIGNATURES);
                sigs = pi.signatures;
            }
            if (sigs != null) {
                CertificateFactory cf = CertificateFactory.getInstance("X.509");
                for (Signature sig : sigs) {
                    if (sig == null) continue;
                    try (ByteArrayInputStream bais = new ByteArrayInputStream(sig.toByteArray())) {
                        X509Certificate cert = (X509Certificate) cf.generateCertificate(bais);
                        if (cert != null && cert.getPublicKey() != null) {
                            keys.add(cert.getPublicKey());
                        }
                    } catch (Exception ignored) {
                        // Skip malformed certificate entry
                    }
                }
            }
        } catch (Exception ignored) {
            // Return empty list so signature check fails closed
        }
        return keys;
    }

    private boolean verifyBundleSignature(
        String version,
        String minNativeVersion,
        String sha256Lower,
        long sizeBytes,
        String signatureBase64,
        String rawSigAlg
    ) {
        if (signatureBase64 == null || signatureBase64.trim().isEmpty()) return false;
        if (sizeBytes <= 0L) return false;
        String sigAlg = rawSigAlg == null ? "" : rawSigAlg.trim();
        if (!ALLOWED_SIG_ALGS.contains(sigAlg)) return false;

        byte[] sigBytes;
        try {
            sigBytes = Base64.decode(signatureBase64.trim(), Base64.DEFAULT);
        } catch (IllegalArgumentException ignored) {
            return false;
        }
        if (sigBytes == null || sigBytes.length < 32) return false;

        String payload = "allinone-ota-v1\n"
            + version + "\n"
            + (minNativeVersion == null ? "" : minNativeVersion.trim()) + "\n"
            + sha256Lower + "\n"
            + sizeBytes;
        byte[] payloadBytes = payload.getBytes(StandardCharsets.UTF_8);

        List<PublicKey> keys = getApkSigningPublicKeys();
        for (PublicKey key : keys) {
            try {
                java.security.Signature verifier = java.security.Signature.getInstance(sigAlg);
                verifier.initVerify(key);
                verifier.update(payloadBytes);
                if (verifier.verify(sigBytes)) {
                    return true;
                }
            } catch (Exception ignored) {
                // Algorithm mismatch for this cert key; try next key
            }
        }
        return false;
    }

    private void emitProgress(String status, String version, long downloadedBytes, long totalBytes, int percent) {
        if (isDestroyed.get()) return;
        JSObject data = new JSObject();
        data.put("status", status);
        data.put("version", version);
        data.put("downloadedBytes", downloadedBytes);
        data.put("totalBytes", totalBytes);
        data.put("percent", percent);
        notifyListeners("otaProgress", data);
    }

    private void cancelActiveDownloadLocked() {
        downloadSeq.incrementAndGet();
        activeDownloadSeq = 0;
        HttpURLConnection conn = activeConnection.getAndSet(null);
        if (conn != null) {
            try {
                conn.disconnect();
            } catch (Exception ignored) {}
        }
    }

    private static class DownloadResult {
        final long bytes;
        final String sha256;

        DownloadResult(long bytes, String sha256) {
            this.bytes = bytes;
            this.sha256 = sha256;
        }
    }

    private DownloadResult streamDownloadToFile(
        String rawUrl,
        boolean requireGithubHostOnRedirects,
        File partFile,
        String version,
        long expectedSize,
        int mySeq
    ) throws Exception {
        String currentUrl = rawUrl;
        HttpURLConnection conn = null;

        for (int hops = 0; hops <= MAX_REDIRECTS; hops++) {
            if (isDestroyed.get() || downloadSeq.get() != mySeq) {
                throw new InterruptedException("Download cancelled");
            }
            String host = extractHttpsHost(currentUrl);
            if (host == null) {
                throw new SecurityException("Only HTTPS update URLs are allowed");
            }
            if (requireGithubHostOnRedirects && !isTrustedGithubHost(host)) {
                throw new SecurityException("Blocked redirect to untrusted host: " + host);
            }

            URL urlObj = new URL(currentUrl);
            HttpURLConnection c = (HttpURLConnection) urlObj.openConnection();
            c.setInstanceFollowRedirects(false);
            c.setConnectTimeout(CONNECT_TIMEOUT_MS);
            c.setReadTimeout(READ_TIMEOUT_MS);
            c.setRequestProperty("Accept", "application/octet-stream, application/zip, */*");
            c.setRequestProperty("User-Agent", "AllInOne-Android/" + readApkVersionName(getContext()));
            activeConnection.set(c);

            int code = c.getResponseCode();
            if (code == HttpURLConnection.HTTP_MOVED_PERM
                || code == HttpURLConnection.HTTP_MOVED_TEMP
                || code == HttpURLConnection.HTTP_SEE_OTHER
                || code == 307
                || code == 308) {
                String location = c.getHeaderField("Location");
                c.disconnect();
                activeConnection.compareAndSet(c, null);
                if (hops >= MAX_REDIRECTS) {
                    throw new IOException("Too many HTTP redirects");
                }
                if (location == null || location.trim().isEmpty()) {
                    throw new IOException("Redirect without Location header");
                }
                URI resolved = URI.create(currentUrl).resolve(location.trim());
                currentUrl = resolved.toString();
                continue;
            }
            if (code != HttpURLConnection.HTTP_OK) {
                c.disconnect();
                activeConnection.compareAndSet(c, null);
                throw new IOException("HTTP " + code);
            }
            conn = c;
            break;
        }

        if (conn == null) {
            throw new IOException("Too many HTTP redirects");
        }

        try {
            long contentLength = conn.getContentLengthLong();
            if (contentLength > MAX_ZIP_BYTES) {
                throw new IOException("Bundle exceeds maximum allowed size");
            }
            long totalBytes = contentLength > 0L ? contentLength : Math.max(0L, expectedSize);
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            long downloaded = 0L;
            long lastEmitAt = 0L;

            try (
                InputStream in = new BufferedInputStream(conn.getInputStream(), 16384);
                FileOutputStream out = new FileOutputStream(partFile)
            ) {
                byte[] buf = new byte[16384];
                int n;
                while ((n = in.read(buf)) != -1) {
                    if (isDestroyed.get() || downloadSeq.get() != mySeq) {
                        throw new InterruptedException("Download cancelled");
                    }
                    downloaded += n;
                    if (downloaded > MAX_ZIP_BYTES) {
                        throw new IOException("Bundle exceeds maximum allowed size");
                    }
                    md.update(buf, 0, n);
                    out.write(buf, 0, n);

                    long now = System.currentTimeMillis();
                    if (now - lastEmitAt >= 150L || (totalBytes > 0L && downloaded >= totalBytes)) {
                        lastEmitAt = now;
                        int pct = totalBytes > 0L
                            ? (int) Math.min(99L, (downloaded * 100L) / totalBytes)
                            : 0;
                        emitProgress("downloading", version, downloaded, totalBytes, pct);
                    }
                }
                out.flush();
            }

            if (contentLength > 0L && downloaded != contentLength) {
                throw new IOException("Incomplete download (" + downloaded + "/" + contentLength + " bytes)");
            }
            if (expectedSize > 0L && downloaded != expectedSize) {
                throw new IOException("Bundle size mismatch (" + downloaded + "/" + expectedSize + " bytes)");
            }

            return new DownloadResult(downloaded, bytesToHex(md.digest()));
        } finally {
            conn.disconnect();
            activeConnection.compareAndSet(conn, null);
        }
    }

    private void extractZipSafely(File zipFile, File destDir) throws IOException {
        if (!destDir.exists() && !destDir.mkdirs()) {
            throw new IOException("Failed to create staging directory");
        }
        String canonicalDest = destDir.getCanonicalPath();
        String canonicalPrefix = canonicalDest.endsWith(File.separator)
            ? canonicalDest
            : canonicalDest + File.separator;

        int entryCount = 0;
        long totalBytes = 0L;
        byte[] buf = new byte[16384];

        try (ZipInputStream zis = new ZipInputStream(new BufferedInputStream(new FileInputStream(zipFile), 16384))) {
            ZipEntry entry;
            while ((entry = zis.getNextEntry()) != null) {
                entryCount++;
                if (entryCount > MAX_ZIP_ENTRIES) {
                    throw new IOException("Too many entries in update archive");
                }
                String name = entry.getName();
                if (name == null || name.isEmpty() || name.contains("\0")) {
                    throw new IOException("Invalid zip entry name");
                }
                // Normalize Windows separators if any and reject leading slashes or traversal
                String cleanName = name.replace('\\', '/');
                if (cleanName.startsWith("/") || cleanName.startsWith("../") || cleanName.contains("/../")) {
                    throw new SecurityException("Blocked path traversal entry: " + name);
                }
                File outFile = new File(destDir, cleanName);
                String canonicalOut = outFile.getCanonicalPath();
                if (!canonicalOut.equals(canonicalDest) && !canonicalOut.startsWith(canonicalPrefix)) {
                    throw new SecurityException("Blocked Zip-Slip entry: " + name);
                }

                if (entry.isDirectory()) {
                    if (!outFile.exists() && !outFile.mkdirs()) {
                        throw new IOException("Failed to create directory: " + cleanName);
                    }
                } else {
                    File parent = outFile.getParentFile();
                    if (parent != null && !parent.exists() && !parent.mkdirs()) {
                        throw new IOException("Failed to create parent directory: " + cleanName);
                    }
                    try (FileOutputStream fos = new FileOutputStream(outFile)) {
                        int n;
                        while ((n = zis.read(buf)) != -1) {
                            totalBytes += n;
                            if (totalBytes > MAX_UNZIPPED_BYTES) {
                                throw new IOException("Uncompressed archive exceeds safety limit");
                            }
                            fos.write(buf, 0, n);
                        }
                        fos.flush();
                    }
                }
                zis.closeEntry();
            }
        }

        if (!isValidBundleDir(destDir)) {
            throw new IOException("Extracted update bundle is missing index.html");
        }
    }

    @PluginMethod
    public void fetchManifest(PluginCall call) {
        final String rawUrl = optTrimString(call, "url");
        final String rawAllowedHost = optTrimString(call, "allowedHost");
        final int rawTimeout = call.getInt("timeoutMs", DEFAULT_MANIFEST_TIMEOUT_MS);
        final int timeoutMs = Math.max(3_000, Math.min(30_000, rawTimeout));
        final JSObject rawHeaders = call.getObject("headers");

        final String initialHost = extractHttpsHost(rawUrl);
        if (initialHost == null) {
            call.reject("Only valid HTTPS manifest URLs are allowed");
            return;
        }
        final String normalizedAllowedHost = normalizeAllowedHost(rawAllowedHost);
        final boolean initialIsGithub = isTrustedGithubHost(initialHost);
        final boolean initialMatchesAllowed = normalizedAllowedHost != null && initialHost.equals(normalizedAllowedHost);
        if (!initialIsGithub && !initialMatchesAllowed) {
            call.reject("Blocked manifest host: " + initialHost);
            return;
        }

        if (isDestroyed.get() || manifestExecutor.isShutdown()) {
            call.reject("Updater plugin is shutting down");
            return;
        }

        final Context ctx = getContext();
        final String userAgent = "AllInOne-Android/" + readApkVersionName(ctx);

        try {
            manifestExecutor.execute(() -> {
                if (isDestroyed.get()) {
                    call.reject("Updater plugin is shutting down");
                    return;
                }
                String currentUrl = rawUrl;
                HttpURLConnection conn = null;
                try {
                    for (int hops = 0; hops <= MAX_REDIRECTS; hops++) {
                        if (isDestroyed.get()) {
                            throw new InterruptedException("Manifest fetch cancelled");
                        }
                        String host = extractHttpsHost(currentUrl);
                        if (host == null) {
                            throw new SecurityException("Blocked non-HTTPS manifest redirect");
                        }
                        boolean hopIsGithub = isTrustedGithubHost(host);
                        boolean hopMatchesAllowed = normalizedAllowedHost != null && host.equals(normalizedAllowedHost);
                        if (initialIsGithub) {
                            if (!hopIsGithub) {
                                throw new SecurityException("Blocked manifest redirect to untrusted host: " + host);
                            }
                        } else if (!hopMatchesAllowed && !hopIsGithub) {
                            throw new SecurityException("Blocked manifest redirect to untrusted host: " + host);
                        }
                        validateNonPrivateHost(host);

                        URL urlObj = new URL(currentUrl);
                        HttpURLConnection c = (HttpURLConnection) urlObj.openConnection();
                        c.setInstanceFollowRedirects(false);
                        c.setConnectTimeout(timeoutMs);
                        c.setReadTimeout(timeoutMs);
                        c.setRequestMethod("GET");
                        c.setRequestProperty("User-Agent", userAgent);
                        c.setRequestProperty("Accept", "application/json, application/vnd.github+json, */*");
                        if (hops == 0 && rawHeaders != null) {
                            Iterator<String> keys = rawHeaders.keys();
                            while (keys.hasNext()) {
                                String k = keys.next();
                                if (k == null) continue;
                                String lower = k.trim().toLowerCase(Locale.ROOT);
                                if (!ALLOWED_MANIFEST_REQ_HEADERS.contains(lower)) continue;
                                String v = rawHeaders.optString(k, "");
                                if (v != null && !v.contains("\r") && !v.contains("\n")) {
                                    c.setRequestProperty(k.trim(), v.trim());
                                }
                            }
                        }

                        int code = c.getResponseCode();
                        if (code == HttpURLConnection.HTTP_MOVED_PERM
                            || code == HttpURLConnection.HTTP_MOVED_TEMP
                            || code == HttpURLConnection.HTTP_SEE_OTHER
                            || code == 307
                            || code == 308) {
                            String location = c.getHeaderField("Location");
                            c.disconnect();
                            if (hops >= MAX_REDIRECTS) {
                                throw new IOException("Too many HTTP redirects");
                            }
                            if (location == null || location.trim().isEmpty()) {
                                throw new IOException("Redirect without Location header");
                            }
                            currentUrl = URI.create(currentUrl).resolve(location.trim()).toString();
                            continue;
                        }
                        conn = c;
                        break;
                    }

                    if (conn == null) {
                        throw new IOException("Too many HTTP redirects");
                    }

                    int status = conn.getResponseCode();
                    String etag = conn.getHeaderField("ETag");
                    long contentLength = conn.getContentLengthLong();
                    if (contentLength > MAX_MANIFEST_BYTES) {
                        throw new IOException("Manifest response exceeds 256 KB limit");
                    }

                    String body = "";
                    if (status != HttpURLConnection.HTTP_NOT_MODIFIED) {
                        InputStream rawStream = (status >= 200 && status < 400)
                            ? conn.getInputStream()
                            : conn.getErrorStream();
                        if (rawStream != null) {
                            try (InputStream in = new BufferedInputStream(rawStream, 8192)) {
                                ByteArrayOutputStream baos = new ByteArrayOutputStream();
                                byte[] buf = new byte[8192];
                                int n;
                                int total = 0;
                                while ((n = in.read(buf)) != -1) {
                                    if (isDestroyed.get()) {
                                        throw new InterruptedException("Manifest fetch cancelled");
                                    }
                                    total += n;
                                    if (total > MAX_MANIFEST_BYTES) {
                                        throw new IOException("Manifest response exceeds 256 KB limit");
                                    }
                                    baos.write(buf, 0, n);
                                }
                                body = new String(baos.toByteArray(), StandardCharsets.UTF_8);
                            }
                        }
                    }

                    JSObject ret = new JSObject();
                    ret.put("status", status);
                    ret.put("body", body);
                    if (etag != null && !etag.isEmpty()) {
                        ret.put("etag", etag);
                    }
                    String trimmedBody = body.trim();
                    if (trimmedBody.startsWith("{")) {
                        try {
                            ret.put("json", new JSObject(trimmedBody));
                        } catch (Exception ignored) {
                            ret.put("json", JSONObject.NULL);
                        }
                    } else {
                        ret.put("json", JSONObject.NULL);
                    }
                    call.resolve(ret);
                } catch (Exception err) {
                    call.reject(err.getMessage() != null ? err.getMessage() : "Manifest fetch failed");
                } finally {
                    if (conn != null) {
                        try {
                            conn.disconnect();
                        } catch (Exception ignored) {}
                    }
                }
            });
        } catch (RejectedExecutionException err) {
            call.reject("Updater plugin is shutting down");
        }
    }

    @PluginMethod
    public void getAppInfo(PluginCall call) {
        Context ctx = getContext();
        String stagedVer;
        String activeBundleVersion;
        synchronized (stateLock) {
            SharedPreferences otaPrefs = ctx.getSharedPreferences(OTA_PREFS, Activity.MODE_PRIVATE);
            stagedVer = otaPrefs.getString(KEY_STAGED_VERSION, "");
            String stagedPath = otaPrefs.getString(KEY_STAGED_PATH, "");
            if (stagedPath == null || stagedPath.isEmpty() || !isValidBundleDir(new File(stagedPath))) {
                stagedVer = "";
            }
            activeBundleVersion = otaPrefs.getString(KEY_ACTIVE_VERSION, "");
        }

        String activeServerPath = bridge != null ? bridge.getServerBasePath() : "";
        boolean isOtaActive = false;
        if (activeServerPath != null && !activeServerPath.isEmpty()) {
            File bundlesRoot = new File(ctx.getFilesDir(), BUNDLES_DIR_NAME);
            isOtaActive = isDirectChildOf(new File(activeServerPath), bundlesRoot);
        }

        JSObject ret = new JSObject();
        ret.put("supportsOta", true);
        ret.put("nativeVersion", readApkVersionName(ctx));
        ret.put("nativeVersionCode", readApkVersionCode(ctx));
        ret.put("activeBundleVersion", activeBundleVersion);
        ret.put("activeServerPath", activeServerPath);
        ret.put("isOtaActive", isOtaActive);
        ret.put("stagedVersion", stagedVer);
        call.resolve(ret);
    }

    private static String optTrimString(PluginCall call, String key) {
        String raw = call.getString(key, "");
        return raw != null ? raw.trim() : "";
    }

    @PluginMethod
    public void downloadBundle(PluginCall call) {
        final String version = optTrimString(call, "version").replaceFirst("^[vV]", "");
        final String minNativeVersion = optTrimString(call, "minNativeVersion").replaceFirst("^[vV]", "");
        final String primaryUrl = optTrimString(call, "url");
        final String fallbackUrl = optTrimString(call, "fallbackUrl");
        final String expectedSha256 = optTrimString(call, "expectedSha256").toLowerCase(Locale.ROOT);
        final long expectedSize = call.getData() != null ? call.getData().optLong("expectedSize", 0L) : 0L;
        final String signature = optTrimString(call, "signature");
        final String sigAlg = optTrimString(call, "sigAlg");

        if (!SAFE_SEMVER_RE.matcher(version).matches()) {
            call.reject("Invalid target version");
            return;
        }
        if (!SHA256_HEX_RE.matcher(expectedSha256).matches()) {
            call.reject("Missing or invalid SHA-256 digest");
            return;
        }

        // Enforce native minimum shell version & strict anti-downgrade in native Java
        final Context checkCtx = getContext();
        final String apkVersionName = readApkVersionName(checkCtx).replaceFirst("^[vV]", "");
        if (!minNativeVersion.isEmpty() && SAFE_SEMVER_RE.matcher(minNativeVersion).matches()
            && SAFE_SEMVER_RE.matcher(apkVersionName).matches()
            && compareSemver(minNativeVersion, apkVersionName) > 0) {
            call.reject("Update requires native APK >= " + minNativeVersion + " (installed: " + apkVersionName + ")");
            return;
        }

        final String primaryHost = extractHttpsHost(primaryUrl);
        if (primaryHost == null) {
            call.reject("Invalid HTTPS download URL");
            return;
        }
        final boolean primaryIsGithub = isTrustedGithubHost(primaryHost);
        if (primaryIsGithub && !isAllowedGithubUrl(primaryUrl)) {
            call.reject("Blocked untrusted GitHub release path");
            return;
        }
        final boolean hasSignature = !signature.isEmpty() && !sigAlg.isEmpty();

        // Unconditionally require positive expectedSize & APK-cert asymmetric signature verification BEFORE downloading
        if (!hasSignature) {
            call.reject("OTA update bundle requires a cryptographic APK-cert signature");
            return;
        }
        if (expectedSize <= 0L || expectedSize > MAX_ZIP_BYTES) {
            call.reject("Missing or invalid expectedSize for signed OTA bundle");
            return;
        }
        if (!verifyBundleSignature(version, minNativeVersion, expectedSha256, expectedSize, signature, sigAlg)) {
            call.reject("Release signature verification failed against APK signing certificate");
            return;
        }

        final int mySeq;
        synchronized (stateLock) {
            if (isDestroyed.get() || executor.isShutdown()) {
                call.reject("Updater plugin is shutting down");
                return;
            }
            SharedPreferences curPrefs = checkCtx.getSharedPreferences(OTA_PREFS, Activity.MODE_PRIVATE);
            String activeVer = curPrefs.getString(KEY_ACTIVE_VERSION, "");
            String baselineVer = apkVersionName;
            if (activeVer != null && SAFE_SEMVER_RE.matcher(activeVer).matches()
                && (!SAFE_SEMVER_RE.matcher(baselineVer).matches() || compareSemver(activeVer, baselineVer) > 0)) {
                baselineVer = activeVer;
            }
            if (SAFE_SEMVER_RE.matcher(baselineVer).matches() && compareSemver(version, baselineVer) <= 0) {
                call.reject("Blocked OTA downgrade or replay (" + version + " <= " + baselineVer + ")");
                return;
            }
            if (activeDownloadSeq != 0) {
                call.reject("Another update download is already in progress");
                return;
            }
            mySeq = downloadSeq.incrementAndGet();
            activeDownloadSeq = mySeq;
        }

        final Context ctx = getContext();

        try {
            executor.execute(() -> {
                File tmpDir = new File(ctx.getFilesDir(), TMP_DIR_NAME);
                File bundlesDir = new File(ctx.getFilesDir(), BUNDLES_DIR_NAME);
                File partFile = new File(tmpDir, "bundle-" + mySeq + "-" + UUID.randomUUID() + ".part");
                File stageDir = new File(bundlesDir, ".stage-" + version + "-" + UUID.randomUUID());

                try {
                    if (isDestroyed.get() || downloadSeq.get() != mySeq) {
                        throw new InterruptedException("Download cancelled");
                    }
                    if (!tmpDir.exists() && !tmpDir.mkdirs()) {
                        throw new IOException("Failed to create temp directory");
                    }
                    if (!bundlesDir.exists() && !bundlesDir.mkdirs()) {
                        throw new IOException("Failed to create bundles directory");
                    }

                    // Reuse already-staged bundle for the exact same version if intact
                    File finalDir = new File(bundlesDir, version);
                    synchronized (stateLock) {
                        if (isDestroyed.get() || downloadSeq.get() != mySeq || activeDownloadSeq != mySeq) {
                            throw new InterruptedException("Download cancelled");
                        }
                        SharedPreferences otaPrefs = ctx.getSharedPreferences(OTA_PREFS, Activity.MODE_PRIVATE);
                        String existingStagedVer = otaPrefs.getString(KEY_STAGED_VERSION, "");
                        String existingStagedPath = otaPrefs.getString(KEY_STAGED_PATH, "");
                        if (version.equals(existingStagedVer)
                            && finalDir.getAbsolutePath().equals(existingStagedPath)
                            && isValidBundleDir(finalDir)) {
                            JSObject cached = new JSObject();
                            cached.put("status", "downloaded");
                            cached.put("version", version);
                            cached.put("path", finalDir.getAbsolutePath());
                            call.resolve(cached);
                            return;
                        }
                    }

                    emitProgress("downloading", version, 0L, expectedSize, 0);

                    DownloadResult res;
                    try {
                        res = streamDownloadToFile(
                            primaryUrl,
                            primaryIsGithub,
                            partFile,
                            version,
                            expectedSize,
                            mySeq
                        );
                    } catch (InterruptedException cancelErr) {
                        throw cancelErr;
                    } catch (Exception primaryErr) {
                        String fbHost = extractHttpsHost(fallbackUrl);
                        if (fbHost == null || isDestroyed.get() || downloadSeq.get() != mySeq) {
                            throw primaryErr;
                        }
                        boolean fbIsGithub = isTrustedGithubHost(fbHost);
                        if (fbIsGithub && !isAllowedGithubUrl(fallbackUrl)) {
                            throw primaryErr;
                        }
                        // Clean partial file before fallback attempt
                        deleteRecursively(partFile);
                        res = streamDownloadToFile(
                            fallbackUrl,
                            fbIsGithub,
                            partFile,
                            version,
                            expectedSize,
                            mySeq
                        );
                    }

                    if (isDestroyed.get() || downloadSeq.get() != mySeq) {
                        throw new InterruptedException("Download cancelled");
                    }

                    if (!res.sha256.equalsIgnoreCase(expectedSha256)) {
                        throw new SecurityException("SHA-256 verification failed");
                    }

                    // Re-verify signature against actual downloaded digest and byte count
                    if (!verifyBundleSignature(version, minNativeVersion, res.sha256, res.bytes, signature, sigAlg)) {
                        throw new SecurityException("Release signature verification failed");
                    }

                    extractZipSafely(partFile, stageDir);

                    final File targetDir;
                    synchronized (stateLock) {
                        if (isDestroyed.get() || downloadSeq.get() != mySeq || activeDownloadSeq != mySeq) {
                            throw new InterruptedException("Download cancelled");
                        }
                        // Never overwrite the currently mounted directory in-place; if same version, stage under unique suffix
                        String currentServerPath = bridge != null ? bridge.getServerBasePath() : "";
                        File chosenDir = finalDir;
                        if (finalDir.getAbsolutePath().equals(currentServerPath)) {
                            chosenDir = new File(bundlesDir, version + "-" + System.currentTimeMillis());
                        } else if (finalDir.exists()) {
                            deleteRecursively(finalDir);
                        }
                        if (!bundlesDir.exists() && !bundlesDir.mkdirs()) {
                            throw new IOException("Failed to create bundles directory");
                        }
                        if (!stageDir.renameTo(chosenDir)) {
                            throw new IOException("Failed to finalize update bundle directory");
                        }
                        targetDir = chosenDir;

                        SharedPreferences otaPrefs = ctx.getSharedPreferences(OTA_PREFS, Activity.MODE_PRIVATE);
                        otaPrefs.edit()
                            .putString(KEY_STAGED_VERSION, version)
                            .putString(KEY_STAGED_PATH, targetDir.getAbsolutePath())
                            .commit();
                    }

                    emitProgress("downloaded", version, res.bytes, res.bytes, 100);

                    JSObject ret = new JSObject();
                    ret.put("status", "downloaded");
                    ret.put("version", version);
                    ret.put("path", targetDir.getAbsolutePath());
                    ret.put("size", res.bytes);
                    call.resolve(ret);
                } catch (InterruptedException cancelled) {
                    JSObject ret = new JSObject();
                    ret.put("status", "cancelled");
                    ret.put("version", version);
                    call.resolve(ret);
                } catch (Exception err) {
                    call.reject(err.getMessage() != null ? err.getMessage() : "Update download failed");
                } finally {
                    deleteRecursively(partFile);
                    if (stageDir.exists()) {
                        deleteRecursively(stageDir);
                    }
                    synchronized (stateLock) {
                        if (activeDownloadSeq == mySeq) {
                            activeDownloadSeq = 0;
                        }
                    }
                }
            });
        } catch (RejectedExecutionException err) {
            synchronized (stateLock) {
                if (activeDownloadSeq == mySeq) {
                    activeDownloadSeq = 0;
                }
            }
            call.reject("Updater plugin is shutting down");
        }
    }

    @PluginMethod
    public void cancelDownload(PluginCall call) {
        synchronized (stateLock) {
            cancelActiveDownloadLocked();
        }
        JSObject ret = new JSObject();
        ret.put("ok", true);
        call.resolve(ret);
    }

    @PluginMethod
    public void applyUpdate(PluginCall call) {
        Context ctx = getContext();
        String requestedVersion = optTrimString(call, "version").replaceFirst("^[vV]", "");
        final String stagedVersion;
        final String nextBasePath;

        synchronized (stateLock) {
            SharedPreferences otaPrefs = ctx.getSharedPreferences(OTA_PREFS, Activity.MODE_PRIVATE);
            SharedPreferences capPrefs = ctx.getSharedPreferences(
                com.getcapacitor.plugin.WebView.WEBVIEW_PREFS_NAME,
                Activity.MODE_PRIVATE
            );

            stagedVersion = otaPrefs.getString(KEY_STAGED_VERSION, "");
            String stagedPath = otaPrefs.getString(KEY_STAGED_PATH, "");

            if (stagedPath == null || stagedPath.isEmpty()) {
                call.reject("No downloaded update bundle is ready");
                return;
            }
            if (!requestedVersion.isEmpty() && !requestedVersion.equals(stagedVersion)) {
                call.reject("Requested update version is not staged");
                return;
            }

            File targetDir = new File(stagedPath);
            File bundlesRoot = new File(ctx.getFilesDir(), BUNDLES_DIR_NAME);
            if (!isDirectChildOf(targetDir, bundlesRoot) || !isValidBundleDir(targetDir)) {
                call.reject("Staged update bundle is missing or corrupted");
                return;
            }

            String prevPath = capPrefs.getString(com.getcapacitor.plugin.WebView.CAP_SERVER_PATH, "");
            String prevVersion = otaPrefs.getString(KEY_ACTIVE_VERSION, "");
            if (prevPath == null) prevPath = "";
            if (prevPath.equals(targetDir.getAbsolutePath())) {
                prevPath = otaPrefs.getString(KEY_PREVIOUS_PATH, "");
                prevVersion = otaPrefs.getString(KEY_PREVIOUS_VERSION, "");
            }

            otaPrefs.edit()
                .putLong(KEY_APK_VERSION_CODE, readApkVersionCode(ctx))
                .putString(KEY_PREVIOUS_PATH, prevPath != null ? prevPath : "")
                .putString(KEY_PREVIOUS_VERSION, prevVersion != null ? prevVersion : "")
                .putString(KEY_ACTIVE_VERSION, stagedVersion)
                .putString(KEY_ACTIVE_PATH, targetDir.getAbsolutePath())
                .putString(KEY_PENDING_VERSION, stagedVersion)
                .putString(KEY_PENDING_PATH, targetDir.getAbsolutePath())
                .putInt(KEY_PENDING_ATTEMPTS, 1)
                .commit();

            capPrefs.edit()
                .putString(com.getcapacitor.plugin.WebView.CAP_SERVER_PATH, targetDir.getAbsolutePath())
                .commit();

            nextBasePath = targetDir.getAbsolutePath();
        }

        JSObject ret = new JSObject();
        ret.put("ok", true);
        ret.put("version", stagedVersion);
        ret.put("path", nextBasePath);
        call.resolve(ret);

        Activity activity = getActivity();
        if (activity != null && bridge != null) {
            activity.runOnUiThread(() -> {
                try {
                    WebView wv = bridge.getWebView();
                    if (wv != null) {
                        wv.clearCache(true);
                    }
                } catch (Exception ignored) {}
                bridge.setServerBasePath(nextBasePath);
            });
        }
    }

    @PluginMethod
    public void confirmBoot(PluginCall call) {
        Context ctx = getContext();
        String requestedVersion = optTrimString(call, "version").replaceFirst("^[vV]", "");

        synchronized (stateLock) {
            SharedPreferences otaPrefs = ctx.getSharedPreferences(OTA_PREFS, Activity.MODE_PRIVATE);
            SharedPreferences capPrefs = ctx.getSharedPreferences(
                com.getcapacitor.plugin.WebView.WEBVIEW_PREFS_NAME,
                Activity.MODE_PRIVATE
            );

            String activePath = capPrefs.getString(com.getcapacitor.plugin.WebView.CAP_SERVER_PATH, "");
            String prevPath = otaPrefs.getString(KEY_PREVIOUS_PATH, "");
            String stagedPath = otaPrefs.getString(KEY_STAGED_PATH, "");
            String pendingVersion = otaPrefs.getString(KEY_PENDING_VERSION, "");
            String activeOtaVersion = otaPrefs.getString(KEY_ACTIVE_VERSION, "");
            String nativeVersion = readApkVersionName(ctx).replaceFirst("^[vV]", "");

            String activeServerPath = bridge != null ? bridge.getServerBasePath() : activePath;
            File bundlesRoot = new File(ctx.getFilesDir(), BUNDLES_DIR_NAME);
            boolean isOtaActive = activeServerPath != null && !activeServerPath.isEmpty()
                && isDirectChildOf(new File(activeServerPath), bundlesRoot);

            String bootedVersion;
            if (pendingVersion != null && !pendingVersion.isEmpty()) {
                bootedVersion = pendingVersion;
            } else if (isOtaActive && activeOtaVersion != null && !activeOtaVersion.isEmpty()) {
                bootedVersion = activeOtaVersion;
            } else {
                bootedVersion = nativeVersion;
            }

            if (!requestedVersion.isEmpty() && !bootedVersion.isEmpty() && !requestedVersion.equals(bootedVersion)) {
                JSObject mismatch = new JSObject();
                mismatch.put("ok", true);
                mismatch.put("confirmed", false);
                mismatch.put("reason", "version_mismatch");
                mismatch.put("activeVersion", bootedVersion);
                call.resolve(mismatch);
                return;
            }

            SharedPreferences.Editor ed = otaPrefs.edit();
            ed.remove(KEY_PENDING_VERSION);
            ed.remove(KEY_PENDING_PATH);
            ed.remove(KEY_PENDING_ATTEMPTS);
            if (activePath != null && !activePath.isEmpty() && activePath.equals(stagedPath)) {
                ed.remove(KEY_STAGED_VERSION);
                ed.remove(KEY_STAGED_PATH);
            }
            ed.commit();

            // Prune stale bundle directories while keeping active + immediate previous + currently staged
            File[] children = bundlesRoot.listFiles();
            if (children != null) {
                for (File child : children) {
                    String p = child.getAbsolutePath();
                    if (p.equals(activePath) || p.equals(prevPath) || p.equals(stagedPath)) {
                        continue;
                    }
                    if (child.getName().startsWith(".stage-")) {
                        continue;
                    }
                    deleteRecursively(child);
                }
            }

            JSObject ret = new JSObject();
            ret.put("ok", true);
            ret.put("confirmed", true);
            ret.put("activeVersion", bootedVersion);
            call.resolve(ret);
        }
    }

    @PluginMethod
    public void resetToBundled(PluginCall call) {
        Context ctx = getContext();
        synchronized (stateLock) {
            cancelActiveDownloadLocked();
            SharedPreferences otaPrefs = ctx.getSharedPreferences(OTA_PREFS, Activity.MODE_PRIVATE);
            SharedPreferences capPrefs = ctx.getSharedPreferences(
                com.getcapacitor.plugin.WebView.WEBVIEW_PREFS_NAME,
                Activity.MODE_PRIVATE
            );
            otaPrefs.edit().clear().putLong(KEY_APK_VERSION_CODE, readApkVersionCode(ctx)).commit();
            capPrefs.edit().remove(com.getcapacitor.plugin.WebView.CAP_SERVER_PATH).commit();
            deleteRecursively(new File(ctx.getFilesDir(), BUNDLES_DIR_NAME));
            deleteRecursively(new File(ctx.getFilesDir(), TMP_DIR_NAME));
        }

        JSObject ret = new JSObject();
        ret.put("ok", true);
        call.resolve(ret);

        Activity activity = getActivity();
        if (activity != null && bridge != null) {
            activity.runOnUiThread(() -> {
                try {
                    WebView wv = bridge.getWebView();
                    if (wv != null) {
                        wv.clearCache(true);
                    }
                } catch (Exception ignored) {}
                bridge.setServerAssetPath("public");
            });
        }
    }
}
