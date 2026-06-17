// Windows Hello FACE prompt (UserConsentVerifier + HWND interop), with a custom message and the
// OS-authenticated user pulled from the login session (not self-declared), then a TPM decrypt.
using System;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.WindowsRuntime;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Threading;
using Windows.Foundation;
using Windows.Security.Credentials.UI;

class FaceProbe {
    [DllImport("kernel32.dll")] static extern IntPtr GetConsoleWindow();
    [DllImport("secur32.dll", CharSet = CharSet.Unicode)] static extern int GetUserNameEx(int nameFormat, StringBuilder buf, ref uint size);

    static string DisplayName() {   // the human's full name from the OS account (NameDisplay = 3)
        var sb = new StringBuilder(256); uint sz = 256;
        return GetUserNameEx(3, sb, ref sz) != 0 && sb.Length > 0 ? sb.ToString() : Environment.UserName;
    }

    [ComImport, Guid("39E050C3-4E74-441A-8DC0-B81104DF949C"), InterfaceType(ComInterfaceType.InterfaceIsIInspectable)]
    interface IUserConsentVerifierInterop {
        IAsyncOperation<UserConsentVerificationResult> RequestVerificationForWindowAsync(
            IntPtr appWindow, [MarshalAs(UnmanagedType.HString)] string message, [In] ref Guid riid);
    }

    static TResult Wait<TResult>(IAsyncOperation<TResult> op) {
        var done = new ManualResetEventSlim(false); TResult r = default(TResult);
        op.Completed = (info, status) => { try { r = info.GetResults(); } catch { } finally { done.Set(); } };
        done.Wait(); return r;
    }

    static int Main() {
        string sessionName = "Bridget";
        string code = "HJ7G3";
        string message = "Unlock the Ai MCP Bridge for the session '" + sessionName + "'. Code is " + code + ".";

        // identity the bridge should TRUST: the OS-authenticated login, not a self-declared string
        string samUser = WindowsIdentity.GetCurrent().Name;   // DOMAIN\user or MACHINE\user
        string display = DisplayName();                        // "Robin Alden"
        Console.WriteLine("OS-authenticated user: " + samUser + "  (" + display + ")");
        Console.WriteLine("  -> this is what the bridge would record as `user`, OS-vouched, not session-declared.\n");

        var avail = Wait(UserConsentVerifier.CheckAvailabilityAsync());
        if (avail != UserConsentVerifierAvailability.Available) { Console.WriteLine("Hello not available: " + avail); return 2; }

        var interop = (IUserConsentVerifierInterop)WindowsRuntimeMarshal.GetActivationFactory(typeof(UserConsentVerifier));
        Guid riid = typeof(IAsyncOperation<UserConsentVerificationResult>).GUID;
        Console.WriteLine("Prompt message: \"" + message + "\"");
        Console.WriteLine(">>> Approve the Windows Hello prompt <<<");
        var result = Wait(interop.RequestVerificationForWindowAsync(GetConsoleWindow(), message, ref riid));
        Console.WriteLine("Verification result: " + result);
        if (result != UserConsentVerificationResult.Verified) return 3;

        var prov = new CngProvider("Microsoft Platform Crypto Provider");
        string name = "aimb-hello-demo";
        try { if (CngKey.Exists(name, prov)) CngKey.Open(name, prov).Delete(); } catch { }
        var cp = new CngKeyCreationParameters(); cp.Provider = prov; cp.ExportPolicy = CngExportPolicies.None;
        cp.Parameters.Add(new CngProperty("Length", BitConverter.GetBytes(2048), CngPropertyOptions.None));
        using (var key = CngKey.Create(CngAlgorithm.Rsa, name, cp))
        using (var rsa = new RSACng(key)) {
            var secret = Encoding.UTF8.GetBytes("unlocked-after-hello-face");
            var back = rsa.Decrypt(rsa.Encrypt(secret, RSAEncryptionPadding.OaepSHA1), RSAEncryptionPadding.OaepSHA1);
            Console.WriteLine("TPM decrypt after face-verify -> \"" + Encoding.UTF8.GetString(back) + "\"");
            key.Delete();
        }
        Console.WriteLine("PASS: custom message + OS-authenticated user + Hello-gated TPM unlock.");
        return 0;
    }
}
