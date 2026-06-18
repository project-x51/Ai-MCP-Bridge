// Ai MCP Bridge — Windows Hello confirmation helper.
// Raises a real Windows Hello prompt (face / fingerprint / PIN) with a caller-supplied message and reports
// the human's decision via EXIT CODE, so any process (the bridge's `hello` authorizer facet) can gate a
// sensitive action on the user's physical presence without itself owning a window.
//
//   HelloConfirm.exe "<message>"     -> prompt; exit 0 = approved (Verified), 3 = denied/cancelled,
//                                       2 = Hello unavailable, 1 = error/bad-args.
//   HelloConfirm.exe --check         -> no prompt; exit 0 if Hello is available on this machine, else 2.
//   HelloConfirm.exe --whoami        -> print the OS-authenticated user (SAM + display name); exit 0.
//
// stdout carries machine-readable lines (RESULT=..., USER=..., DISPLAY=...) the caller may parse; the
// decision of record is the exit code. Mechanism proven in experiments/hello-tpm-vault/FaceProbe.cs:
// UserConsentVerifier + the HWND interop (RequestVerificationForWindowAsync) on .NET Framework (csc).
// Built with the in-box .NET Framework compiler — see build-hello.cmd. C# 5 compatible.
using System;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.WindowsRuntime;
using System.Security.Principal;
using System.Text;
using System.Threading;
using Windows.Foundation;
using Windows.Security.Credentials.UI;

class HelloConfirm
{
    [DllImport("kernel32.dll")] static extern IntPtr GetConsoleWindow();
    [DllImport("kernel32.dll")] static extern bool AllocConsole();
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] static extern IntPtr GetDesktopWindow();
    [DllImport("secur32.dll", CharSet = CharSet.Unicode)] static extern int GetUserNameEx(int nameFormat, StringBuilder buf, ref uint size);
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
        op.Completed = delegate (IAsyncOperation<TResult> info, AsyncStatus status) {
            try { r = info.GetResults(); } catch { } finally { done.Set(); }
        };
        done.Wait(); return r;
    }

    static string DisplayName()   // human's full name from the OS account (NameDisplay = 3), else the login name
    {
        var sb = new StringBuilder(256); uint sz = 256;
        return GetUserNameEx(3, sb, ref sz) != 0 && sb.Length > 0 ? sb.ToString() : Environment.UserName;
    }

    // a valid owner HWND for the (system-modal) consent prompt. A windowless helper has no console window,
    // so allocate a hidden one; fall back to the desktop window.
    static IntPtr OwnerWindow()
    {
        IntPtr h = GetConsoleWindow();
        if (h == IntPtr.Zero) { try { if (AllocConsole()) h = GetConsoleWindow(); } catch { } }
        if (h != IntPtr.Zero) { try { ShowWindow(h, SW_HIDE); } catch { } return h; }
        return GetDesktopWindow();
    }

    static int Main(string[] args)
    {
        try
        {
            string mode = args.Length > 0 ? args[0] : "";
            if (mode == "--whoami")
            {
                Console.WriteLine("USER=" + WindowsIdentity.GetCurrent().Name);
                Console.WriteLine("DISPLAY=" + DisplayName());
                return 0;
            }
            var avail = Wait(UserConsentVerifier.CheckAvailabilityAsync());
            Console.WriteLine("AVAILABILITY=" + avail);
            if (mode == "--check") return avail == UserConsentVerifierAvailability.Available ? 0 : 2;
            if (avail != UserConsentVerifierAvailability.Available) return 2;

            string message = (args.Length > 0 && !mode.StartsWith("--")) ? args[0] : "Approve this Ai MCP Bridge action?";
            Console.WriteLine("USER=" + WindowsIdentity.GetCurrent().Name);
            Console.WriteLine("DISPLAY=" + DisplayName());

            var interop = (IUserConsentVerifierInterop)WindowsRuntimeMarshal.GetActivationFactory(typeof(UserConsentVerifier));
            Guid riid = typeof(IAsyncOperation<UserConsentVerificationResult>).GUID;
            var result = Wait(interop.RequestVerificationForWindowAsync(OwnerWindow(), message, ref riid));
            Console.WriteLine("RESULT=" + result);
            return result == UserConsentVerificationResult.Verified ? 0 : 3;
        }
        catch (Exception e)
        {
            Console.Error.WriteLine("ERROR=" + e.Message);
            return 1;
        }
    }
}
