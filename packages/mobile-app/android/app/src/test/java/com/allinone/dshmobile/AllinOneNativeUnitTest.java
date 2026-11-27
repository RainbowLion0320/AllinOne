package com.allinone.dshmobile;

import org.junit.Test;

import java.io.File;
import java.io.FileOutputStream;
import java.lang.reflect.Field;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.net.InetAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.Signature;
import java.util.Set;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

public class AllinOneNativeUnitTest {

    private static Object invokeStatic(Class<?> cls, String name, Class<?>[] paramTypes, Object... args) throws Exception {
        Method m = cls.getDeclaredMethod(name, paramTypes);
        m.setAccessible(true);
        try {
            return m.invoke(null, args);
        } catch (InvocationTargetException e) {
            Throwable cause = e.getCause();
            if (cause instanceof Exception) throw (Exception) cause;
            if (cause instanceof Error) throw (Error) cause;
            throw e;
        }
    }

    private static String sanitizeFilename(String raw) throws Exception {
        return (String) invokeStatic(AllinOneFilesPlugin.class, "sanitizeFilename", new Class<?>[]{String.class}, raw);
    }

    private static String extractExtension(String filename) throws Exception {
        return (String) invokeStatic(AllinOneFilesPlugin.class, "extractExtension", new Class<?>[]{String.class}, filename);
    }

    private static String resolveSafeMimeType(String filename, String rawMime) throws Exception {
        return (String) invokeStatic(
            AllinOneFilesPlugin.class,
            "resolveSafeMimeType",
            new Class<?>[]{String.class, String.class},
            filename,
            rawMime
        );
    }

    private static int compareSemver(String a, String b) throws Exception {
        return (Integer) invokeStatic(
            AllinOneUpdaterPlugin.class,
            "compareSemver",
            new Class<?>[]{String.class, String.class},
            a,
            b
        );
    }

    private static boolean isTrustedGithubHost(String host) throws Exception {
        return (Boolean) invokeStatic(
            AllinOneUpdaterPlugin.class,
            "isTrustedGithubHost",
            new Class<?>[]{String.class},
            host
        );
    }

    private static boolean isAllowedGithubUrl(String url) throws Exception {
        return (Boolean) invokeStatic(
            AllinOneUpdaterPlugin.class,
            "isAllowedGithubUrl",
            new Class<?>[]{String.class},
            url
        );
    }

    private static String extractHttpsHost(String url) throws Exception {
        return (String) invokeStatic(
            AllinOneUpdaterPlugin.class,
            "extractHttpsHost",
            new Class<?>[]{String.class},
            url
        );
    }

    private static String normalizeAllowedHost(String raw) throws Exception {
        return (String) invokeStatic(
            AllinOneUpdaterPlugin.class,
            "normalizeAllowedHost",
            new Class<?>[]{String.class},
            raw
        );
    }

    private static boolean isPrivateOrLoopbackAddress(InetAddress addr) throws Exception {
        return (Boolean) invokeStatic(
            AllinOneUpdaterPlugin.class,
            "isPrivateOrLoopbackAddress",
            new Class<?>[]{InetAddress.class},
            addr
        );
    }

    private static void validateNonPrivateHost(String host) throws Exception {
        invokeStatic(
            AllinOneUpdaterPlugin.class,
            "validateNonPrivateHost",
            new Class<?>[]{String.class},
            host
        );
    }

    @Test
    public void testSanitizeFilenameStripsTraversalAndPreservesExtension() throws Exception {
        assertEquals("passwd.txt", sanitizeFilename("../../etc/passwd.txt"));
        assertEquals("report.pdf", sanitizeFilename("C:\\Users\\demo\\report.pdf"));
        assertEquals("hidden.md", sanitizeFilename("...hidden.md"));
        assertEquals("报告_2026_.pdf", sanitizeFilename("报告 2026!.pdf"));
        assertEquals("allinone-file.bin", sanitizeFilename(""));
        assertEquals("allinone-file.bin", sanitizeFilename(null));
        assertEquals("allinone-file.bin", sanitizeFilename("..."));

        // Filenames longer than 120 chars MUST be truncated while preserving their extension
        StringBuilder longStem = new StringBuilder();
        for (int i = 0; i < 140; i++) longStem.append('a');
        String sanitizedLong = sanitizeFilename(longStem + ".docx");
        assertTrue("Length must be <= 120, got " + sanitizedLong.length(), sanitizedLong.length() <= 120);
        assertTrue("Extension .docx must be preserved: " + sanitizedLong, sanitizedLong.endsWith(".docx"));
        assertEquals("docx", extractExtension(sanitizedLong));
    }

    @Test
    public void testAllowedExtensionsAndMimeValidation() throws Exception {
        assertEquals("pdf", extractExtension("Report.PDF"));
        assertEquals("", extractExtension(".hidden"));
        assertEquals("", extractExtension("noext"));

        // Allowed extensions resolve canonical or compatible MIME types
        assertEquals("application/pdf", resolveSafeMimeType("report.pdf", ""));
        assertEquals("application/pdf", resolveSafeMimeType("report.pdf", "application/octet-stream"));
        assertEquals("image/png", resolveSafeMimeType("shot.png", "image/png; charset=binary"));
        assertEquals("text/markdown", resolveSafeMimeType("notes.md", null));
        assertEquals("text/plain", resolveSafeMimeType("data.json", "text/plain"));
        assertEquals("text/rtf", resolveSafeMimeType("doc.rtf", "text/rtf"));
        assertEquals("text/html", resolveSafeMimeType("preview.html", "text/html"));
        assertEquals("image/svg+xml", resolveSafeMimeType("icon.svg", "image/svg+xml"));

        // Disallowed/executable extensions MUST be rejected
        assertNull(resolveSafeMimeType("payload.apk", "application/vnd.android.package-archive"));
        assertNull(resolveSafeMimeType("install.sh", "text/plain"));
        assertNull(resolveSafeMimeType("app.js", "application/javascript"));
        assertNull(resolveSafeMimeType("noext", "text/plain"));

        // Blocked MIME types and MIME spoofing MUST be rejected
        assertNull(resolveSafeMimeType("notes.txt", "text/html"));
        assertNull(resolveSafeMimeType("photo.png", "image/svg+xml"));
        assertNull(resolveSafeMimeType("report.pdf", "application/javascript"));
        assertNull(resolveSafeMimeType("report.pdf", "text/xml"));
        assertNull(resolveSafeMimeType("report.pdf", "image/png"));
    }

    @Test
    public void testUpdaterSemverAndHostAllowlistValidation() throws Exception {
        assertTrue(compareSemver("1.0.30", "1.0.29") > 0);
        assertEquals(0, compareSemver("v1.0.30", "1.0.30"));
        assertTrue(compareSemver("1.0.30-alpha.1", "1.0.30") < 0);
        assertTrue(compareSemver("2.0.0", "1.99.99") > 0);

        // Trusted GitHub hosts
        assertTrue(isTrustedGithubHost("github.com"));
        assertTrue(isTrustedGithubHost("api.github.com"));
        assertTrue(isTrustedGithubHost("objects.githubusercontent.com"));
        assertTrue(isTrustedGithubHost("release-assets.githubusercontent.com"));
        assertFalse(isTrustedGithubHost("evilgithub.com"));
        assertFalse(isTrustedGithubHost("github.com.evil.org"));
        assertFalse(isTrustedGithubHost("localhost"));
        assertFalse(isTrustedGithubHost(""));
        assertFalse(isTrustedGithubHost(null));

        // GitHub release URL path pinning & HTTPS-only enforcement
        assertTrue(isAllowedGithubUrl("https://github.com/RainbowLion0320/AllinOne/releases/download/v1.0.30/All-in-One-WebBundle.zip"));
        assertTrue(isAllowedGithubUrl("https://objects.githubusercontent.com/github-production-release-asset/123"));
        assertFalse(isAllowedGithubUrl("http://github.com/RainbowLion0320/AllinOne/releases/download/v1.0.30/All-in-One-WebBundle.zip"));
        assertFalse(isAllowedGithubUrl("https://user:pass@github.com/RainbowLion0320/AllinOne/releases/download/v1.0.30/All-in-One-WebBundle.zip"));
        assertFalse(isAllowedGithubUrl("https://github.com/other/repo/releases/download/v1.0.30/All-in-One-WebBundle.zip"));
        assertFalse(isAllowedGithubUrl("https://evil.example.com/All-in-One-WebBundle.zip"));

        // HTTPS host extraction & allowedHost normalization
        assertEquals("relay.example.com", extractHttpsHost("https://Relay.Example.COM:8443/downloads/ota/All-in-One-WebBundle.json"));
        assertNull(extractHttpsHost("http://relay.example.com/manifest.json"));
        assertNull(extractHttpsHost("https://user@relay.example.com/manifest.json"));
        assertEquals("relay.example.com", normalizeAllowedHost("https://Relay.Example.COM:8443/api"));
        assertEquals("relay.example.com", normalizeAllowedHost("Relay.Example.COM"));
        assertNull(normalizeAllowedHost("http://relay.example.com"));
        assertNull(normalizeAllowedHost("https://user@relay.example.com"));
    }

    @Test
    public void testUpdaterBlocksPrivateAndLoopbackHosts() throws Exception {
        String[] privateIps = new String[]{
            "127.0.0.1",
            "10.0.0.1",
            "172.16.0.1",
            "192.168.1.1",
            "169.254.169.254",
            "100.64.0.1",
            "0.0.0.0",
            "224.0.0.1",
            "::1",
            "fc00::1",
            "fe80::1",
            "::ffff:127.0.0.1",
            "::ffff:10.0.0.5",
            "64:ff9b::10.0.0.1"
        };
        for (String ip : privateIps) {
            assertTrue("Expected private/loopback block for " + ip, isPrivateOrLoopbackAddress(InetAddress.getByName(ip)));
        }

        assertFalse(isPrivateOrLoopbackAddress(InetAddress.getByName("1.1.1.1")));
        assertFalse(isPrivateOrLoopbackAddress(InetAddress.getByName("8.8.8.8")));

        String[] blockedHosts = new String[]{
            "localhost",
            "sub.localhost",
            "device.local",
            "metadata.internal",
            "router.home.arpa",
            "127.0.0.1",
            "192.168.1.10",
            "[::1]"
        };
        for (String host : blockedHosts) {
            try {
                validateNonPrivateHost(host);
                fail("Expected SecurityException for blocked host: " + host);
            } catch (SecurityException expected) {
                assertNotNull(expected.getMessage());
            }
        }

        // Literal public IP passes without DNS dependency
        validateNonPrivateHost("1.1.1.1");
    }

    @Test
    @SuppressWarnings("unchecked")
    public void testUpdaterCanonicalPayloadFailClosedAndZipSlipGuard() throws Exception {
        // Verify canonical OTA payload format and allowed signature algorithms
        Field algField = AllinOneUpdaterPlugin.class.getDeclaredField("ALLOWED_SIG_ALGS");
        algField.setAccessible(true);
        Set<String> allowedAlgs = (Set<String>) algField.get(null);
        assertTrue(allowedAlgs.contains("SHA256withRSA"));
        assertTrue(allowedAlgs.contains("SHA256withECDSA"));
        assertFalse(allowedAlgs.contains("MD5withRSA"));

        String canonicalPayload = "allinone-ota-v1\n1.0.30\n1.0.26\n"
            + "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n12345";
        KeyPairGenerator kpg = KeyPairGenerator.getInstance("RSA");
        kpg.initialize(2048);
        KeyPair kp = kpg.generateKeyPair();
        Signature signer = Signature.getInstance("SHA256withRSA");
        signer.initSign(kp.getPrivate());
        signer.update(canonicalPayload.getBytes(StandardCharsets.UTF_8));
        byte[] sig = signer.sign();

        Signature verifier = Signature.getInstance("SHA256withRSA");
        verifier.initVerify(kp.getPublic());
        verifier.update(canonicalPayload.getBytes(StandardCharsets.UTF_8));
        assertTrue(verifier.verify(sig));

        AllinOneUpdaterPlugin plugin = new AllinOneUpdaterPlugin();
        File tmpRoot = Files.createTempDirectory("aio-ota-junit-").toFile();
        try {
            // Fail-closed signature pre-checks (empty sig, size <= 0, disallowed alg) reject cleanly
            Method verifyMethod = AllinOneUpdaterPlugin.class.getDeclaredMethod(
                "verifyBundleSignature",
                String.class, String.class, String.class, long.class, String.class, String.class
            );
            verifyMethod.setAccessible(true);
            String sha = "a".repeat(64);
            assertFalse((Boolean) verifyMethod.invoke(plugin, "1.0.30", "1.0.26", sha, 100L, "", "SHA256withRSA"));
            assertFalse((Boolean) verifyMethod.invoke(plugin, "1.0.30", "1.0.26", sha, 0L, "AAAA", "SHA256withRSA"));
            assertFalse((Boolean) verifyMethod.invoke(plugin, "1.0.30", "1.0.26", sha, -1L, "AAAA", "SHA256withRSA"));
            assertFalse((Boolean) verifyMethod.invoke(plugin, "1.0.30", "1.0.26", sha, 100L, "AAAA", "MD5withRSA"));

            // Zip-Slip guard in extractZipSafely blocks ../ traversal
            Method extractMethod = AllinOneUpdaterPlugin.class.getDeclaredMethod(
                "extractZipSafely",
                File.class,
                File.class
            );
            extractMethod.setAccessible(true);

            File evilZip = new File(tmpRoot, "evil.zip");
            try (ZipOutputStream zos = new ZipOutputStream(new FileOutputStream(evilZip))) {
                zos.putNextEntry(new ZipEntry("../escaped.txt"));
                zos.write("pwned".getBytes(StandardCharsets.UTF_8));
                zos.closeEntry();
            }
            File destBad = new File(tmpRoot, "dest-bad");
            try {
                extractMethod.invoke(plugin, evilZip, destBad);
                fail("Expected SecurityException for Zip-Slip entry");
            } catch (InvocationTargetException ex) {
                assertTrue(
                    "Expected SecurityException, got: " + ex.getCause(),
                    ex.getCause() instanceof SecurityException
                );
            }
            assertFalse(new File(tmpRoot, "escaped.txt").exists());

            // Valid bundle ZIP with index.html extracts cleanly
            File goodZip = new File(tmpRoot, "good.zip");
            try (ZipOutputStream zos = new ZipOutputStream(new FileOutputStream(goodZip))) {
                zos.putNextEntry(new ZipEntry("index.html"));
                zos.write("<!doctype html><html></html>".getBytes(StandardCharsets.UTF_8));
                zos.closeEntry();
            }
            File destGood = new File(tmpRoot, "dest-good");
            extractMethod.invoke(plugin, goodZip, destGood);
            assertTrue(new File(destGood, "index.html").isFile());
        } finally {
            plugin.handleOnDestroy();
            invokeStatic(AllinOneUpdaterPlugin.class, "deleteRecursively", new Class<?>[]{File.class}, tmpRoot);
        }
    }
}
