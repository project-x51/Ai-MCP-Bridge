// Ai MCP Bridge — Windows system-tray component.
// A standalone tray icon with "Open Dashboard" and "Quit". It supervises the bridge:
//   --ephemeral : launched BY the first bridge instance; exits when all bridges are gone.
//   (default)   : launched by the user / at startup; launches a bridge if none is running and
//                 keeps one alive (persistent gateway), staying resident across bridge restarts.
// Quit weighs what is connected and offers: Cancel / Close tray only / Shut down all bridges.
//
// Built with the in-box .NET Framework compiler (no SDK / runtime install) — see build.cmd.
// C# 5 compatible (no string interpolation / null-conditional) so legacy csc.exe accepts it.
//
// This is the Windows implementation; the cross-platform bridge is OS-agnostic. A macOS/Linux
// tray would live alongside this folder (tray/macos, tray/linux) implementing the same contract.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Management;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;

class TrayApp : ApplicationContext
{
    static Mutex _singleton;

    NotifyIcon _icon;
    System.Windows.Forms.Timer _monitor;
    bool _ephemeral;
    string _root;          // folder containing bridge.mjs / config.json / dashboard.html
    int _wsPort = 7001;
    string _token = "";
    string _version = "";  // bridge version (from the managed bridge's package.json) shown in the menu
    Icon _onIcon, _offIcon;
    int _emptyTicks;

    [STAThread]
    static void Main(string[] args)
    {
        bool created;
        _singleton = new Mutex(true, "AiMcpBridgeTray_singleton_v1", out created);
        if (!created) return;          // another tray is already running
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new TrayApp(args));
        GC.KeepAlive(_singleton);
    }

    TrayApp(string[] args)
    {
        _ephemeral = Array.IndexOf(args, "--ephemeral") >= 0;
        _root = ResolveRoot(GetArg(args, "--root"));
        LoadConfig();

        _onIcon = MakeDot(Color.FromArgb(0x16, 0xA3, 0x4A));
        _offIcon = MakeDot(Color.FromArgb(0x9C, 0xA3, 0xAF));

        var menu = new ContextMenuStrip();
        var header = new ToolStripMenuItem(_version.Length > 0 ? ("Ai MCP Bridge  v" + _version) : "Ai MCP Bridge");
        header.Enabled = false;        // non-clickable label: the running bridge version, at a glance
        menu.Items.Add(header);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Open Dashboard", null, delegate { OpenDashboard(); });
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Quit", null, delegate { OnQuit(); });

        _icon = new NotifyIcon();
        _icon.Icon = _offIcon;
        _icon.Text = Tip(false, 0);
        _icon.Visible = true;
        _icon.ContextMenuStrip = menu;
        _icon.DoubleClick += delegate { OpenDashboard(); };

        if (!_ephemeral && CountBridges() == 0) LaunchBridge();

        _monitor = new System.Windows.Forms.Timer();
        _monitor.Interval = 3000;
        _monitor.Tick += delegate { Tick(); };
        _monitor.Start();
        Tick();
    }

    // ---- lifecycle ----------------------------------------------------------
    void Tick()
    {
        int n = CountBridges();
        bool up = n > 0;
        _icon.Icon = up ? _onIcon : _offIcon;
        _icon.Text = Tip(up, n);
        if (_ephemeral)
        {
            if (!up) { _emptyTicks++; if (_emptyTicks >= 2) ExitApp(); }
            else _emptyTicks = 0;
        }
        else if (!up)
        {
            LaunchBridge();            // persistent: keep a gateway alive
        }
    }

    void OnQuit()
    {
        int n = CountBridges();
        string msg = n > 0
            ? (n + " bridge process" + (n == 1 ? " is" : "es are") + " running on this machine.\n\n" +
               "Shutting them down disconnects every AI session and page on the mesh.")
            : "No bridge processes are running.";
        int choice = QuitDialog.Show(msg, n > 0);
        if (choice == 0) return;                       // cancel
        if (choice == 2) ShutdownAllBridges();         // kill bridges too
        ExitApp();                                     // choice 1 or 2: close the tray
    }

    void ExitApp()
    {
        try { _monitor.Stop(); } catch { }
        try { _icon.Visible = false; _icon.Dispose(); } catch { }
        Application.Exit();
    }

    // tray tooltip: name + version + live status (version also heads the right-click menu)
    string Tip(bool up, int n)
    {
        string v = _version.Length > 0 ? " v" + _version : "";
        string status = up ? (n + " bridge" + (n == 1 ? "" : "s") + " online") : "offline";
        return "Ai MCP Bridge" + v + " — " + status;
    }

    // ---- bridge process control --------------------------------------------
    List<uint> BridgePids()
    {
        var pids = new List<uint>();
        try
        {
            using (var s = new ManagementObjectSearcher(
                "SELECT ProcessId, CommandLine FROM Win32_Process WHERE Name = 'node.exe'"))
            foreach (ManagementObject o in s.Get())
            {
                object cl = o["CommandLine"];
                if (cl != null && cl.ToString().IndexOf("bridge.mjs", StringComparison.OrdinalIgnoreCase) >= 0)
                    pids.Add((uint)o["ProcessId"]);
            }
        }
        catch { }
        return pids;
    }
    int CountBridges() { return BridgePids().Count; }

    void LaunchBridge()
    {
        try
        {
            var psi = new ProcessStartInfo("node", "bridge.mjs");
            psi.WorkingDirectory = _root;
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.EnvironmentVariables["AI_BRIDGE_CLIENT"] = "Task Tray";   // label this headless gateway
            Process.Start(psi);
        }
        catch { }
    }

    void ShutdownAllBridges()
    {
        foreach (uint pid in BridgePids())
            try { Process.GetProcessById((int)pid).Kill(); } catch { }
    }

    void OpenDashboard()
    {
        try
        {
            // the gateway serves the dashboard over http on the ws port (same origin as the WS) — this
            // avoids the file:// origin restrictions that block ws://127.0.0.1 in Chrome.
            string url = "http://127.0.0.1:" + _wsPort + "/?token=" + Uri.EscapeDataString(_token);
            var psi = new ProcessStartInfo(url);
            psi.UseShellExecute = true;
            Process.Start(psi);
        }
        catch (Exception e) { MessageBox.Show("Could not open dashboard:\n" + e.Message, "Ai MCP Bridge"); }
    }

    // ---- config / paths -----------------------------------------------------
    string ResolveRoot(string given)
    {
        if (!string.IsNullOrEmpty(given) && File.Exists(Path.Combine(given, "bridge.mjs"))) return given;
        // walk up from the exe looking for bridge.mjs; fall back to ..\..\src
        string dir = AppDomain.CurrentDomain.BaseDirectory;
        for (int i = 0; i < 6 && dir != null; i++)
        {
            if (File.Exists(Path.Combine(dir, "bridge.mjs"))) return dir;
            string src = Path.Combine(dir, "src");
            if (File.Exists(Path.Combine(src, "bridge.mjs"))) return src;
            dir = Path.GetDirectoryName(dir.TrimEnd('\\'));
        }
        return AppDomain.CurrentDomain.BaseDirectory;
    }

    void LoadConfig()
    {
        try
        {
            string text = File.ReadAllText(Path.Combine(_root, "config.json"));
            var mp = Regex.Match(text, "\"wsPort\"\\s*:\\s*(\\d+)");
            if (mp.Success) _wsPort = int.Parse(mp.Groups[1].Value);
            var mt = Regex.Match(text, "\"token\"\\s*:\\s*\"([^\"]*)\"");
            if (mt.Success) _token = mt.Groups[1].Value;
        }
        catch { }
        try
        {   // version of the bridge this tray manages (kept in sync with the bridge's BRIDGE_VERSION)
            var pj = File.ReadAllText(Path.Combine(_root, "package.json"));
            var mv = Regex.Match(pj, "\"version\"\\s*:\\s*\"([^\"]+)\"");
            if (mv.Success) _version = mv.Groups[1].Value;
        }
        catch { }
    }

    static string GetArg(string[] args, string name)
    {
        int i = Array.IndexOf(args, name);
        return (i >= 0 && i + 1 < args.Length) ? args[i + 1] : null;
    }

    static Icon MakeDot(Color c)
    {
        using (var bmp = new Bitmap(16, 16))
        {
            using (var g = Graphics.FromImage(bmp))
            {
                g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
                g.Clear(Color.Transparent);
                using (var b = new SolidBrush(c)) g.FillEllipse(b, 2, 2, 12, 12);
            }
            return Icon.FromHandle(bmp.GetHicon());
        }
    }
}

// 3-way Quit confirmation (Cancel / Close tray only / Shut down all bridges).
class QuitDialog : Form
{
    int _result = 0;
    QuitDialog(string message, bool bridgesUp)
    {
        Text = "Quit Ai MCP Bridge";
        FormBorderStyle = FormBorderStyle.FixedDialog;
        StartPosition = FormStartPosition.CenterScreen;
        MaximizeBox = false; MinimizeBox = false; ShowInTaskbar = false;
        ClientSize = new Size(420, 150);

        var lbl = new Label();
        lbl.Text = message;
        lbl.SetBounds(14, 14, 392, 70);
        Controls.Add(lbl);

        int x = 14, y = 100, w = 128, h = 30, gap = 8;
        var cancel = MakeBtn("Cancel", x, y, w, h, 0);
        var trayOnly = MakeBtn("Close tray only", x + w + gap, y, w, h, 1);
        Controls.Add(cancel); Controls.Add(trayOnly);
        if (bridgesUp)
        {
            var all = MakeBtn("Shut down all", x + 2 * (w + gap), y, w, h, 2);
            all.ForeColor = Color.FromArgb(0x99, 0x1B, 0x1B);
            Controls.Add(all);
        }
        AcceptButton = trayOnly; CancelButton = cancel;
    }

    Button MakeBtn(string text, int x, int y, int w, int h, int code)
    {
        var b = new Button();
        b.Text = text; b.SetBounds(x, y, w, h);
        b.Click += delegate { _result = code; DialogResult = DialogResult.OK; Close(); };
        return b;
    }

    public static int Show(string message, bool bridgesUp)
    {
        using (var d = new QuitDialog(message, bridgesUp)) { d.ShowDialog(); return d._result; }
    }
}
