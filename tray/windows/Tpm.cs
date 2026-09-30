// Ai MCP Bridge — TPM vault helper (Windows). Backs the `tpm` vault facet (secret recovery, §21).
// A per-user RSA key lives in the TPM (CNG "Microsoft Platform Crypto Provider"); its private half never
// leaves the chip. The bridge SEALS a secret by RSA-OAEP-encrypting it to the exported PUBLIC key (in Node,
// silently); recovery UNSEALS by TPM-decrypting — gated by a real Windows Hello presence check.
//
//   Tpm.exe --pubkey              -> ensures the key exists AND is TPM-backed; prints
//                                      PROVIDER=Microsoft Platform Crypto Provider
//                                      PLATFORM_TYPE=TPM-Version:2.0 -Level:0-...   (the PCP KSP's own answer)
//                                      PUBKEY=<modulus_b64>.<exponent_b64>
//   Tpm.exe --decrypt <ct_b64> [--message "<msg>"]
//                                 -> Windows Hello prompt; on approval TPM-decrypts; prints PLAINTEXT=<b64>
//                                    exit 0 verified / 3 denied / 2 Hello-or-TPM unavailable / 1 error
//   Tpm.exe --check               -> exit 0 if Hello + the platform crypto provider are available
//   Tpm.exe --selftest            -> internal TPM encrypt+decrypt round-trip (no Hello, no secret); 0 = ok
//   any mode also takes [--key <name>] to use a key other than "aimb-vault" (scratch testing only).
//
// #42 — HARDWARE OR NOTHING. Every mode first requires (a) a TPM the OS's TPM Base Services can see
// (Tbsi_GetDeviceInfo — no admin needed, unlike Win32_Tpm) and (b) a key that is really in the Platform
// Crypto Provider, proven POSITIVELY by the provider answering PCP_PLATFORM_TYPE — a software KSP has no such
// property. Either failing is exit 2 with ERROR=<why> on stderr, before any Hello prompt; there is no
// software-provider fallback. The checks run at RUNTIME, so a copy of this exe that Dropbox synced onto a
// TPM-less machine fails honestly there instead of inheriting the build machine's answer.
//
// Mechanism proven in experiments/hello-tpm-vault (Probe.cs TPM envelope + FaceProbe.cs Hello). Built with
// the in-box .NET Framework compiler — see build-tpm.cmd. C# 5 compatible.
using System;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.WindowsRuntime;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using Windows.Foundation;
using Windows.Security.Credentials.UI;

class TpmVault
{
    const string PLATFORM = "Microsoft Platform Crypto Provider";   // MS_PLATFORM_CRYPTO_PROVIDER — the TPM KSP, the ONLY one used
    static string KeyName = "aimb-vault";   // per-user CNG key in the platform (TPM) provider; --key overrides (tests)

    // "this host cannot give us a TPM-backed key" — distinct from a plain error so it maps to exit 2 (unavailable)
    class NotHardwareException : Exception { public NotHardwareException(string m) : base(m) { } }

    [StructLayout(LayoutKind.Sequential)]
    struct TPM_DEVICE_INFO { public uint structVersion, tpmVersion, tpmInterfaceType, tpmImpRevision; }
    [DllImport("tbs.dll")] static extern uint Tbsi_GetDeviceInfo(uint size, out TPM_DEVICE_INFO info);

    [DllImport("kernel32.dll")] static extern IntPtr GetConsoleWindow();
    [DllImport("kernel32.dll")] static extern bool AllocConsole();
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] static extern IntPtr GetDesktopWindow();
    const int SW_HIDE = 0;

    [ComImport, Guid("39E050C3-4E74-441A-8DC0-B81104DF949C"), InterfaceType(ComInterfaceType.InterfaceIsIInspectable)]
    interface IUserConsentVerifierInterop
    {
        IAsyncOperation<UserConsentVerificationResult> RequestVerificationForWindowAsync(
            IntPtr appWindow, [MarshalAs(UnmanagedType.HString)] string message, [In] ref Guid riid);
    }
    static TResult Wait<TResult>(IAsyncOperation<TResult> op)
    {
        var done = new ManualResetEventSlim(false); TResult r = default(TResult);
        op.Completed = delegate (IAsyncOperation<TResult> info, AsyncStatus status) { try { r = info.GetResults(); } catch { } finally { done.Set(); } };
        done.Wait(); return r;
    }
    static IntPtr OwnerWindow()
    {
        IntPtr h = GetConsoleWindow();
        if (h == IntPtr.Zero) { try { if (AllocConsole()) h = GetConsoleWindow(); } catch { } }
        if (h != IntPtr.Zero) { try { ShowWindow(h, SW_HIDE); } catch { } return h; }
        return GetDesktopWindow();
    }

    // #42 (a): is there a TPM at all? TBS is the OS TPM broker; it answers TBS_E_TPM_NOT_FOUND when the firmware
    // TPM is disabled or absent — the field case, where the old helper still printed a PUBKEY.
    static void RequireTpmDevice()
    {
        TPM_DEVICE_INFO info; uint rc;
        try { rc = Tbsi_GetDeviceInfo((uint)Marshal.SizeOf(typeof(TPM_DEVICE_INFO)), out info); }
        catch (Exception e) { throw new NotHardwareException("no-tpm (TPM Base Services unavailable: " + e.Message + ")"); }
        if (rc != 0) throw new NotHardwareException("no-tpm (TPM Base Services 0x" + rc.ToString("X8") + ")");
    }

    // #42 (b): positive proof the key is hardware-backed — the handle's provider IS the platform provider and it
    // answers PCP_PLATFORM_TYPE ("TPM-Version:2.0 -Level:0-Revision:...-VendorID:..."). Returns that string.
    static string PlatformType(CngKey key)
    {
        if (key.Provider.Provider != PLATFORM) throw new NotHardwareException("not-platform-provider (" + key.Provider.Provider + ")");
        string t = null;
        try { t = Encoding.Unicode.GetString(key.GetProperty("PCP_PLATFORM_TYPE", CngPropertyOptions.None).GetValue()).TrimEnd('\0', ' '); } catch { }
        if (t == null || !t.StartsWith("TPM-Version:")) throw new NotHardwareException("not-hardware-backed (the provider did not report a TPM platform type)");
        return t;
    }

    // Opens (or, when `create`, makes) the vault key in the Platform Crypto Provider ONLY, and refuses anything it
    // cannot prove is in the TPM. `platformType` receives the PCP's own description of the chip.
    static CngKey OpenKey(bool create, out string platformType)
    {
        RequireTpmDevice();
        var prov = new CngProvider(PLATFORM);
        CngKey key;
        try
        {
            if (CngKey.Exists(KeyName, prov)) key = CngKey.Open(KeyName, prov);
            else if (!create) throw new NotHardwareException("key-missing (\"" + KeyName + "\" is not in the " + PLATFORM + ")");
            else
            {
                var cp = new CngKeyCreationParameters(); cp.Provider = prov; cp.ExportPolicy = CngExportPolicies.None;  // private key stays in the TPM
                cp.Parameters.Add(new CngProperty("Length", BitConverter.GetBytes(2048), CngPropertyOptions.None));
                key = CngKey.Create(CngAlgorithm.Rsa, KeyName, cp);
            }
        }
        catch (CryptographicException e) { throw new NotHardwareException("platform-provider-unavailable (" + e.Message + ")"); }
        try { platformType = PlatformType(key); } catch { key.Dispose(); throw; }
        return key;
    }

    static int Main(string[] args)
    {
        try
        {
            string mode = args.Length > 0 ? args[0] : "";
            for (int i = 1; i < args.Length - 1; i++) if (args[i] == "--key" && args[i + 1].Length > 0) KeyName = args[i + 1];
            string platformType;

            if (mode == "--check")
            {
                var a = Wait(UserConsentVerifier.CheckAvailabilityAsync());
                bool tpm; try { using (var k = OpenKey(true, out platformType)) tpm = true; } catch { tpm = false; }
                Console.WriteLine("AVAILABILITY=" + a + " TPM=" + tpm);
                return (a == UserConsentVerifierAvailability.Available && tpm) ? 0 : 2;
            }

            if (mode == "--pubkey")
            {
                using (var key = OpenKey(true, out platformType))
                using (var rsa = new RSACng(key))
                {
                    var p = rsa.ExportParameters(false);   // public only (allowed even with ExportPolicy.None)
                    Console.WriteLine("PROVIDER=" + key.Provider.Provider);   // #42: the positive hardware signal the probe requires
                    Console.WriteLine("PLATFORM_TYPE=" + platformType);
                    Console.WriteLine("PUBKEY=" + Convert.ToBase64String(p.Modulus) + "." + Convert.ToBase64String(p.Exponent));
                }
                return 0;
            }

            if (mode == "--selftest")
            {
                using (var key = OpenKey(true, out platformType))
                using (var rsa = new RSACng(key))
                {
                    var probe = Encoding.UTF8.GetBytes("aimb-vault-selftest");
                    var ct = rsa.Encrypt(probe, RSAEncryptionPadding.OaepSHA1);
                    var back = rsa.Decrypt(ct, RSAEncryptionPadding.OaepSHA1);
                    bool ok = Encoding.UTF8.GetString(back) == "aimb-vault-selftest";
                    Console.WriteLine("SELFTEST=" + (ok ? "ok" : "FAIL") + " PLATFORM_TYPE=" + platformType);
                    return ok ? 0 : 1;
                }
            }

            if (mode == "--decrypt")
            {
                if (args.Length < 2) { Console.Error.WriteLine("ERROR=missing-ciphertext"); return 1; }
                byte[] ct;
                try { ct = Convert.FromBase64String(args[1]); } catch { Console.Error.WriteLine("ERROR=bad-base64"); return 1; }
                string message = "Recover the Ai MCP Bridge secret?";
                for (int i = 2; i < args.Length - 1; i++) if (args[i] == "--message") message = args[i + 1];

                // #42: prove the TPM key is there BEFORE asking the human — never raise a Hello prompt that cannot
                // lead to a decrypt, and never create a fresh key here (it could not decrypt anything sealed before)
                using (var key = OpenKey(false, out platformType))
                using (var rsa = new RSACng(key))
                {
                    var avail = Wait(UserConsentVerifier.CheckAvailabilityAsync());
                    if (avail != UserConsentVerifierAvailability.Available) { Console.WriteLine("AVAILABILITY=" + avail); return 2; }
                    var interop = (IUserConsentVerifierInterop)WindowsRuntimeMarshal.GetActivationFactory(typeof(UserConsentVerifier));
                    Guid riid = typeof(IAsyncOperation<UserConsentVerificationResult>).GUID;
                    var result = Wait(interop.RequestVerificationForWindowAsync(OwnerWindow(), message, ref riid));
                    if (result != UserConsentVerificationResult.Verified) { Console.WriteLine("RESULT=" + result); return 3; }

                    byte[] pt = rsa.Decrypt(ct, RSAEncryptionPadding.OaepSHA1);
                    Console.WriteLine("PLAINTEXT=" + Convert.ToBase64String(pt));
                }
                return 0;
            }

            Console.Error.WriteLine("ERROR=unknown-mode (use --pubkey | --decrypt | --check | --selftest)");
            return 1;
        }
        catch (NotHardwareException e) { Console.Error.WriteLine("ERROR=" + e.Message); return 2; }
        catch (Exception e) { Console.Error.WriteLine("ERROR=" + e.Message); return 1; }
    }
}
