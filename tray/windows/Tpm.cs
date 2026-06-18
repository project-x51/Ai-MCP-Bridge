// Ai MCP Bridge — TPM vault helper (Windows). Backs the `tpm` vault facet (secret recovery, §21).
// A per-user RSA key lives in the TPM (CNG "Microsoft Platform Crypto Provider"); its private half never
// leaves the chip. The bridge SEALS a secret by RSA-OAEP-encrypting it to the exported PUBLIC key (in Node,
// silently); recovery UNSEALS by TPM-decrypting — gated by a real Windows Hello presence check.
//
//   Tpm.exe --pubkey              -> ensures the key exists; prints  PUBKEY=<modulus_b64>.<exponent_b64>
//   Tpm.exe --decrypt <ct_b64> [--message "<msg>"]
//                                 -> Windows Hello prompt; on approval TPM-decrypts; prints PLAINTEXT=<b64>
//                                    exit 0 verified / 3 denied / 2 Hello-or-TPM unavailable / 1 error
//   Tpm.exe --check               -> exit 0 if Hello + the platform crypto provider are available
//   Tpm.exe --selftest            -> internal TPM encrypt+decrypt round-trip (no Hello, no secret); 0 = ok
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
    const string KEY_NAME = "aimb-vault";   // per-user CNG key in the platform (TPM) provider

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

    static CngKey OpenOrCreate()
    {
        var prov = new CngProvider("Microsoft Platform Crypto Provider");
        if (CngKey.Exists(KEY_NAME, prov)) return CngKey.Open(KEY_NAME, prov);
        var cp = new CngKeyCreationParameters(); cp.Provider = prov; cp.ExportPolicy = CngExportPolicies.None;  // private key stays in the TPM
        cp.Parameters.Add(new CngProperty("Length", BitConverter.GetBytes(2048), CngPropertyOptions.None));
        return CngKey.Create(CngAlgorithm.Rsa, KEY_NAME, cp);
    }

    static int Main(string[] args)
    {
        try
        {
            string mode = args.Length > 0 ? args[0] : "";

            if (mode == "--check")
            {
                var a = Wait(UserConsentVerifier.CheckAvailabilityAsync());
                bool tpm; try { using (var k = OpenOrCreate()) tpm = true; } catch { tpm = false; }
                Console.WriteLine("AVAILABILITY=" + a + " TPM=" + tpm);
                return (a == UserConsentVerifierAvailability.Available && tpm) ? 0 : 2;
            }

            if (mode == "--pubkey")
            {
                using (var key = OpenOrCreate())
                using (var rsa = new RSACng(key))
                {
                    var p = rsa.ExportParameters(false);   // public only (allowed even with ExportPolicy.None)
                    Console.WriteLine("PUBKEY=" + Convert.ToBase64String(p.Modulus) + "." + Convert.ToBase64String(p.Exponent));
                }
                return 0;
            }

            if (mode == "--selftest")
            {
                using (var key = OpenOrCreate())
                using (var rsa = new RSACng(key))
                {
                    var probe = Encoding.UTF8.GetBytes("aimb-vault-selftest");
                    var ct = rsa.Encrypt(probe, RSAEncryptionPadding.OaepSHA1);
                    var back = rsa.Decrypt(ct, RSAEncryptionPadding.OaepSHA1);
                    bool ok = Encoding.UTF8.GetString(back) == "aimb-vault-selftest";
                    Console.WriteLine("SELFTEST=" + (ok ? "ok" : "FAIL"));
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

                var avail = Wait(UserConsentVerifier.CheckAvailabilityAsync());
                if (avail != UserConsentVerifierAvailability.Available) { Console.WriteLine("AVAILABILITY=" + avail); return 2; }
                var interop = (IUserConsentVerifierInterop)WindowsRuntimeMarshal.GetActivationFactory(typeof(UserConsentVerifier));
                Guid riid = typeof(IAsyncOperation<UserConsentVerificationResult>).GUID;
                var result = Wait(interop.RequestVerificationForWindowAsync(OwnerWindow(), message, ref riid));
                if (result != UserConsentVerificationResult.Verified) { Console.WriteLine("RESULT=" + result); return 3; }

                using (var key = OpenOrCreate())
                using (var rsa = new RSACng(key))
                {
                    byte[] pt = rsa.Decrypt(ct, RSAEncryptionPadding.OaepSHA1);
                    Console.WriteLine("PLAINTEXT=" + Convert.ToBase64String(pt));
                }
                return 0;
            }

            Console.Error.WriteLine("ERROR=unknown-mode (use --pubkey | --decrypt | --check | --selftest)");
            return 1;
        }
        catch (Exception e) { Console.Error.WriteLine("ERROR=" + e.Message); return 1; }
    }
}
