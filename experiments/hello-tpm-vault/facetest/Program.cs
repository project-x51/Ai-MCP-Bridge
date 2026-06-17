// Windows Hello FACE prompt via the HWND-aware interop (RequestVerificationForWindowAsync), then a TPM
// decrypt. Parents the prompt to the console window so it can actually display (the parameterless API
// throws from a windowless context). In the real product the tray supplies its own window handle.
using System;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading.Tasks;
using WinRT;
using Windows.Foundation;
using Windows.Security.Credentials.UI;

internal static class Program
{
    [DllImport("kernel32.dll")] private static extern IntPtr GetConsoleWindow();

    [ComImport, Guid("39E050C3-4E74-441A-8DC0-B81104DF949C"), InterfaceType(ComInterfaceType.InterfaceIsIInspectable)]
    private interface IUserConsentVerifierInterop
    {
        IAsyncOperation<UserConsentVerificationResult> RequestVerificationForWindowAsync(
            IntPtr appWindow,
            [MarshalAs(UnmanagedType.HString)] string message,
            [In] ref Guid riid);
    }

    private static async Task<int> Main()
    {
        Console.WriteLine("=== AIMB vault: Windows Hello FACE gate (HWND interop) -> TPM decrypt ===");
        var avail = await UserConsentVerifier.CheckAvailabilityAsync();
        Console.WriteLine("Hello availability: " + avail);
        if (avail != UserConsentVerifierAvailability.Available) return 2;

        IntPtr hwnd = GetConsoleWindow();
        var factory = ActivationFactory.Get("Windows.Security.Credentials.UI.UserConsentVerifier");
        var interop = factory.AsInterface<IUserConsentVerifierInterop>();
        Guid riid = GuidGenerator.CreateIID(typeof(IAsyncOperation<UserConsentVerificationResult>));

        Console.WriteLine(">>> Approve the Windows Hello prompt (face / fingerprint) <<<");
        var op = interop.RequestVerificationForWindowAsync(hwnd, "Unlock the AIMB session vault", ref riid);
        var result = await op;
        Console.WriteLine("Verification result: " + result);
        if (result != UserConsentVerificationResult.Verified) { Console.WriteLine("Not verified -> vault stays locked."); return 3; }

        // Face verified -> decrypt with the TPM (multi-machine envelope) key. No per-key password.
        var prov = new CngProvider("Microsoft Platform Crypto Provider");
        const string name = "aimb-hello-demo";
        try { if (CngKey.Exists(name, prov)) CngKey.Open(name, prov).Delete(); } catch { }
        var cp = new CngKeyCreationParameters { Provider = prov, ExportPolicy = CngExportPolicies.None };
        cp.Parameters.Add(new CngProperty("Length", BitConverter.GetBytes(2048), CngPropertyOptions.None));
        using (var key = CngKey.Create(CngAlgorithm.Rsa, name, cp))
        using (var rsa = new RSACng(key))
        {
            var secret = Encoding.UTF8.GetBytes("unlocked-after-hello-face");
            var back = rsa.Decrypt(rsa.Encrypt(secret, RSAEncryptionPadding.OaepSHA1), RSAEncryptionPadding.OaepSHA1);
            Console.WriteLine("TPM decrypt after face-verify -> \"" + Encoding.UTF8.GetString(back) + "\"");
            key.Delete();
        }
        Console.WriteLine("PASS: Windows Hello FACE gated the TPM unlock.");
        return 0;
    }
}
