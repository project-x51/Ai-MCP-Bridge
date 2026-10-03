// Ai MCP Bridge — Windows system-tray component.
// A standalone tray icon with "Open Dashboard", "Restart Bridges..." and "Quit". It supervises the bridge:
//   --ephemeral : launched BY the first bridge instance; exits when all bridges are gone.
//   (default)   : launched by the user / at startup; launches a bridge if none is running and
//                 keeps one alive (persistent gateway), staying resident across bridge restarts.
// Quit weighs what is connected and offers: Cancel / Close tray only / Shut down all bridges.
// Restart Bridges (confirmed) stops every bridge process on this machine and starts a fresh gateway.
// Both stops first POST /admin/prepare-shutdown to the gateway (bridge 1.59.0+, #70) so it persists before the kill.
// #88 (2.0): a gateway that REFUSES TO START (exit 78: its activity history is not converted, or a migration did not finish)
// is not relaunched every few seconds — the tray shows its message (balloon + menu) until Restart Bridges... is chosen.
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
using System.Net;
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
    ToolStripMenuItem _header;
    Process _launched;     // the gateway this tray started last (its exit code tells a refusal from a crash)
    string _refused;       // #88: the refusal message while the bridge refuses to start (no relaunch meanwhile), else null
    ToolStripMenuItem _refusedItem;

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
        _refusedItem = new ToolStripMenuItem("Bridge refused to start - details...", null, delegate { ShowRefusal(); });
        _refusedItem.Visible = false;
        menu.Items.Add(_refusedItem);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Open Dashboard", null, delegate { OpenDashboard(); });
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Restart Bridges...", null, delegate { OnRestart(); });
        menu.Items.Add("Quit", null, delegate { OnQuit(); });
        _header = header;

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
        CheckLaunched();
        int n = CountBridges();
        bool up = n > 0;
        _icon.Icon = up ? _onIcon : _offIcon;
        _icon.Text = _refused != null && !up ? "Ai MCP Bridge - refused to start (see menu)" : Tip(up, n);
        if (_ephemeral)
        {
            if (!up) { _emptyTicks++; if (_emptyTicks >= 2) ExitApp(); }
            else _emptyTicks = 0;
        }
        else if (!up && _refused == null)
        {
            LaunchBridge();            // persistent: keep a gateway alive (not while it refuses to start: #88)
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

    // Restart = stop EVERY bridge process on this machine (gateway + per-session followers), wait for them to
    // exit so the gateway ports are free, then launch a fresh headless gateway from the current code. Session
    // bridges belong to their client app (Claude Code / Desktop) and come back when that client reconnects its
    // MCP server. Typical use: after a `git pull` / Dropbox sync delivered a new bridge version.
    void OnRestart()
    {
        int n = CountBridges();
        string msg = (n > 0
            ? (n + " bridge process" + (n == 1 ? " is" : "es are") + " running on this machine.\n\n" +
               "Restart ALL of them? Every AI session and page on this machine drops off the mesh briefly. " +
               "A fresh gateway starts immediately; AI sessions whose app started their bridge may need to " +
               "reconnect the ai-mcp-bridge MCP server.")
            : "No bridge processes are running.\n\nStart a fresh gateway?");
        if (MessageBox.Show(msg, "Restart Ai MCP Bridges", MessageBoxButtons.YesNo, MessageBoxIcon.Warning,
                MessageBoxDefaultButton.Button2) != DialogResult.Yes) return;

        _monitor.Stop();                               // no keep-alive relaunch racing the shutdown
        try
        {
            ShutdownAllBridges();
            DateTime deadline = DateTime.UtcNow.AddSeconds(10);
            while (CountBridges() > 0 && DateTime.UtcNow < deadline) Thread.Sleep(250);
            if (CountBridges() > 0)
                MessageBox.Show("Some bridge processes did not exit; starting a gateway anyway.", "Ai MCP Bridge");
            LoadConfig();                              // pick up a new version / ports from the updated checkout
            ClearRefusal();                            // #88: a deliberate restart tries again (e.g. after the migration ran)
            if (_header != null) _header.Text = _version.Length > 0 ? ("Ai MCP Bridge  v" + _version) : "Ai MCP Bridge";
            LaunchBridge();
            _emptyTicks = 0;
        }
        finally { _monitor.Start(); Tick(); }
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
            if (_launched != null) { try { _launched.Dispose(); } catch { } }
            _launched = Process.Start(psi);
        }
        catch { }
    }

    // #88 (bridge 2.0, docs/spec-88.md §7.5): the gateway this tray launched exited 78 = it REFUSED TO START (its activity
    // history is format v5 and must be converted with src/tools/aimb-migrate-v2.mjs, or a migration did not finish). The
    // bridge wrote its message to %TEMP%\aimb-start-refused-<wsPort>.txt; show it once (balloon) and keep it in the menu,
    // and stop the keep-alive relaunch until Restart Bridges... (a gateway that starts deletes the file).
    void CheckLaunched()
    {
        if (_launched == null) return;
        try
        {
            if (!_launched.HasExited) return;
            int code = _launched.ExitCode;
            _launched.Dispose(); _launched = null;
            if (code != 78) return;
            string msg = null;
            try { msg = File.ReadAllText(RefusedFile()).Trim(); } catch { }
            if (string.IsNullOrEmpty(msg)) msg = "The bridge refused to start (exit 78). Start it from a terminal (node src/bridge.mjs) to see why.";
            _refused = msg;
            _refusedItem.Visible = true;
            _icon.ShowBalloonTip(30000, "Ai MCP Bridge did not start", msg.Length > 250 ? msg.Substring(0, 247) + "..." : msg, ToolTipIcon.Error);
        }
        catch { _launched = null; }
    }

    string RefusedFile() { return Path.Combine(Path.GetTempPath(), "aimb-start-refused-" + _wsPort + ".txt"); }

    void ShowRefusal()
    {
        if (_refused == null) return;
        MessageBox.Show(_refused + "\n\nAfter fixing it, choose Restart Bridges... to start the bridge again.", "Ai MCP Bridge did not start", MessageBoxButtons.OK, MessageBoxIcon.Error);
    }

    void ClearRefusal()
    {
        _refused = null;
        if (_refusedItem != null) _refusedItem.Visible = false;
    }

    void ShutdownAllBridges()
    {
        PrepareShutdown();                             // let the gateway persist first: Kill() runs no node exit handlers
        foreach (uint pid in BridgePids())
            try { Process.GetProcessById((int)pid).Kill(); } catch { }
    }

    // #70 step 3 (bridge v1.59.0): ask this machine's gateway to flush its pending activity checkpoints (the log:false
    // progress since the last interval) and finish its queued writes BEFORE we TerminateProcess it. POST
    // http://127.0.0.1:<wsPort>/admin/prepare-shutdown with "Authorization: Bearer <token>" (never in the URL); the
    // gateway answers loopback callers only. Short timeout; any failure (no gateway, a pre-1.59 gateway's 404, a slow
    // disk) is ignored and the kill goes ahead as before. Followers write no activity files, so only the gateway is asked.
    void PrepareShutdown()
    {
        try
        {
            var req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + _wsPort + "/admin/prepare-shutdown");
            req.Method = "POST";
            req.Proxy = null;                          // never route a loopback call (with the realm token) via a system proxy
            req.Timeout = 3000;
            req.ReadWriteTimeout = 3000;
            req.KeepAlive = false;
            req.ContentLength = 0;
            req.Headers.Add(HttpRequestHeader.Authorization, "Bearer " + _token);
            using (var resp = (HttpWebResponse)req.GetResponse()) { }
        }
        catch { }
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
