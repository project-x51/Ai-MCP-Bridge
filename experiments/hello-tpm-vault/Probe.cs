// Feasibility probe for the "encrypt-to-user" persistence vault idea (Ai MCP Bridge §12 follow-on).
// Proves whether a TPM-backed CNG key (Microsoft Platform Crypto Provider) can do the things the
// multi-machine envelope scheme needs:
//   Test 1  TPM RSA key can ENCRYPT + DECRYPT (RSA-OAEP), not just sign        [no prompt]
//   Test 2  multi-machine envelope: one data key wrapped to TWO TPM keys,       [no prompt]
//           either unwraps its own copy; neither can open the other's
//   Test 3  the private-key use is gated by a Windows security prompt (Hello/PIN) [PROMPTS - run when a human is present]
// C# 5 / .NET Framework (compile with the in-box csc, like the tray). Keys are deleted after each run.
using System;
using System.Security.Cryptography;
using System.Text;

class Probe {
    const string TPM = "Microsoft Platform Crypto Provider";
    static int pass = 0, fail = 0;

    static CngProvider Prov() { return new CngProvider(TPM); }

    static void DeleteIfExists(string name) {
        try { if (CngKey.Exists(name, Prov())) { using (var k = CngKey.Open(name, Prov())) k.Delete(); } } catch { }
    }

    static CngKey CreateTpmRsa(string name, bool uiProtect) {
        DeleteIfExists(name);
        var p = new CngKeyCreationParameters();
        p.Provider = Prov();
        p.KeyCreationOptions = CngKeyCreationOptions.OverwriteExistingKey;
        p.ExportPolicy = CngExportPolicies.None; // private key stays in the TPM, non-exportable
        p.Parameters.Add(new CngProperty("Length", BitConverter.GetBytes(2048), CngPropertyOptions.None));
        if (uiProtect)
            p.UIPolicy = new CngUIPolicy(CngUIProtectionLevels.ProtectKey, "AIMB Vault (experiment)", "Approve unlocking the AIMB session vault");
        return CngKey.Create(CngAlgorithm.Rsa, name, p);
    }

    static byte[] WrapToPublic(byte[] publicBlob, byte[] data) {
        using (var pub = CngKey.Import(publicBlob, CngKeyBlobFormat.GenericPublicBlob))
        using (var rsa = new RSACng(pub)) return rsa.Encrypt(data, RSAEncryptionPadding.OaepSHA1);
    }
    static byte[] UnwrapWithKey(CngKey key, byte[] wrapped) {
        using (var rsa = new RSACng(key)) return rsa.Decrypt(wrapped, RSAEncryptionPadding.OaepSHA1);
    }

    static bool Eq(byte[] a, byte[] b) {
        if (a == null || b == null || a.Length != b.Length) return false;
        for (int i = 0; i < a.Length; i++) if (a[i] != b[i]) return false;
        return true;
    }
    static void Check(string n, bool c, string extra) {
        if (c) { pass++; Console.WriteLine("PASS " + n); }
        else { fail++; Console.WriteLine("FAIL " + n + (extra != null ? "  (" + extra + ")" : "")); }
    }

    static void Main(string[] args) {
        string mode = args.Length > 0 ? args[0] : "noninteractive";
        Console.WriteLine("=== AIMB encrypt-to-user / TPM vault feasibility probe (" + mode + ") ===");
        Console.WriteLine("Machine: " + Environment.MachineName + "   Provider: " + TPM + "\n");

        // Test 0: is a TPM-backed key usable here at all?
        try {
            using (var k = CreateTpmRsa("aimb-exp-0", false))
                Check("Test 0: TPM-backed RSA key created (provider=" + k.Provider.Provider + ")", k.Provider.Provider == TPM, "provider=" + k.Provider.Provider);
        } catch (Exception e) {
            Check("Test 0: TPM-backed RSA key created", false, e.GetType().Name + ": " + e.Message);
            Console.WriteLine("\nNo usable TPM key here -> can't test the rest. Done.");
            DeleteIfExists("aimb-exp-0");
            Console.WriteLine("\n" + pass + " passed, " + fail + " failed");
            Environment.Exit(1);
        }
        DeleteIfExists("aimb-exp-0");

        if (mode == "interactive") Interactive(); else NonInteractive();

        Console.WriteLine("\n" + pass + " passed, " + fail + " failed");
        Environment.Exit(fail > 0 ? 1 : 0);
    }

    static void NonInteractive() {
        // Test 1: a TPM key can DECRYPT (RSA-OAEP), not just sign
        try {
            using (var k = CreateTpmRsa("aimb-exp-1", false)) {
                byte[] pub = k.Export(CngKeyBlobFormat.GenericPublicBlob);
                byte[] secret = Encoding.UTF8.GetBytes("the-session-secret-or-data-key");
                byte[] back = UnwrapWithKey(k, WrapToPublic(pub, secret));
                Check("Test 1: TPM key ENCRYPTS + DECRYPTS (RSA-OAEP), not just signs", Eq(secret, back), null);
                Check("Test 1: public key exportable (shareable to other machines)", pub != null && pub.Length > 0, null);
            }
        } catch (Exception e) { Check("Test 1: TPM encrypt/decrypt", false, e.GetType().Name + ": " + e.Message); }
        DeleteIfExists("aimb-exp-1");

        // Test 2: multi-machine envelope — one data key wrapped to TWO TPM keys (machines A & B), either unwraps its copy
        try {
            using (var a = CreateTpmRsa("aimb-exp-A", false))
            using (var b = CreateTpmRsa("aimb-exp-B", false)) {
                byte[] pubA = a.Export(CngKeyBlobFormat.GenericPublicBlob);
                byte[] pubB = b.Export(CngKeyBlobFormat.GenericPublicBlob);
                byte[] dataKey = new byte[32];
                using (var rng = new RNGCryptoServiceProvider()) rng.GetBytes(dataKey);
                byte[] wrapA = WrapToPublic(pubA, dataKey);    // a sender wraps the data key to A's PUBLIC blob
                byte[] wrapB = WrapToPublic(pubB, dataKey);    // ...and to B's
                byte[] fromA = UnwrapWithKey(a, wrapA);        // machine A opens its own copy
                byte[] fromB = UnwrapWithKey(b, wrapB);        // machine B opens its own copy
                Check("Test 2: data key wrapped to 2 TPM keys; A unwraps its copy", Eq(dataKey, fromA), null);
                Check("Test 2: ...and B unwraps its copy (same data key)", Eq(dataKey, fromB) && Eq(fromA, fromB), null);
                bool isolated = false; try { UnwrapWithKey(a, wrapB); } catch { isolated = true; }
                Check("Test 2: A canNOT open B's envelope copy (per-machine isolation)", isolated, null);
            }
        } catch (Exception e) { Check("Test 2: multi-machine envelope", false, e.GetType().Name + ": " + e.Message); }
        DeleteIfExists("aimb-exp-A"); DeleteIfExists("aimb-exp-B");

        Console.WriteLine("\n--> The encrypt-to-user envelope works for the logged-in user with NO prompt.");
        Console.WriteLine("    Run run-interactive.cmd while you're at the keyboard to test the Hello/PIN gate (Test 3).");
    }

    static void Interactive() {
        // Test 3: a UI-protected TPM key — decrypting with it SHOULD pop a Windows security prompt
        Console.WriteLine("Test 3: creating a UI-protected TPM key, then decrypting with it.");
        Console.WriteLine(">>> A Windows security prompt (Hello / PIN / consent) SHOULD appear. Approve it. <<<\n");
        try {
            using (var k = CreateTpmRsa("aimb-exp-ui", true)) {
                byte[] pub = k.Export(CngKeyBlobFormat.GenericPublicBlob);
                byte[] secret = Encoding.UTF8.GetBytes("unlocked-by-the-human");
                byte[] back = UnwrapWithKey(k, WrapToPublic(pub, secret)); // private-key use -> should prompt
                Check("Test 3: UI-gated TPM key decrypts AFTER the human approves the prompt", Eq(secret, back), null);
                Console.WriteLine("\n--> If a prompt appeared and decrypt succeeded: human-gated decrypt works.");
                Console.WriteLine("    Please note WHAT the prompt was (face/fingerprint = biometric Hello, or a PIN/consent box).");
            }
        } catch (Exception e) { Check("Test 3: UI-gated decrypt", false, e.GetType().Name + ": " + e.Message); }
        DeleteIfExists("aimb-exp-ui");
    }
}
