// The Windows app's own window: the planner's page in WebView2 (the web engine that comes with Windows), with none of
// a browser around it. Built by scripts/window-host.mjs with the C# compiler that is part of Windows (C# 5), and started
// by the app (server/window-host.ts) as: "Trip Planner Window.exe" <url> <profile folder>
// Exit code 2: the window couldn't be made (no WebView2), so the app opens a browser window instead.
using System;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;
using Microsoft.Win32;

static class Program
{
    [STAThread]
    static int Main(string[] args)
    {
        Uri url;
        if (args.Length < 2 || !Uri.TryCreate(args[0], UriKind.Absolute, out url) || (url.Scheme != "http" && url.Scheme != "https")) return 1;
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        try { Application.Run(new TripWindow(url, args[1])); }
        catch (Exception e) { Console.Error.WriteLine(e); return 2; }
        return Environment.ExitCode;
    }
}

class TripWindow : Form
{
    [DllImport("dwmapi.dll")]
    static extern int DwmSetWindowAttribute(IntPtr window, int attribute, ref int value, int size);

    readonly Uri home;
    readonly string profile, boundsFile;
    readonly WebView2 web = new WebView2();
    readonly bool dark = SystemIsDark();
    bool leaving, left;

    public TripWindow(Uri url, string profileFolder)
    {
        home = url;
        profile = profileFolder;
        boundsFile = Path.Combine(profile, "window.txt");
        Text = "Trip Planner";
        try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch (Exception) { }
        BackColor = dark ? Color.FromArgb(20, 20, 20) : Color.FromArgb(245, 245, 243);
        web.DefaultBackgroundColor = BackColor; // no white flash before the page is there
        web.Dock = DockStyle.Fill;
        Controls.Add(web);
        PlaceWindow();
        Load += delegate { Start(); };
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        int on = dark ? 1 : 0;
        try { DwmSetWindowAttribute(Handle, 20, ref on, sizeof(int)); } catch (Exception) { } // a dark title bar
    }

    static bool SystemIsDark()
    {
        object light = Registry.GetValue(@"HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize", "AppsUseLightTheme", 1);
        return light is int && (int)light == 0;
    }

    /// Where it was last time (if that's still on a screen), else 1500 x 950 in the middle.
    void PlaceWindow()
    {
        try
        {
            string[] p = File.ReadAllText(boundsFile).Split(',');
            Rectangle r = new Rectangle(Int(p[0]), Int(p[1]), Int(p[2]), Int(p[3]));
            Rectangle seen = Rectangle.Intersect(r, Screen.FromRectangle(r).WorkingArea);
            if (r.Width >= 400 && r.Height >= 300 && seen.Width >= 200 && seen.Height >= 100)
            {
                StartPosition = FormStartPosition.Manual;
                Bounds = r;
                if (p[4] == "1") WindowState = FormWindowState.Maximized;
                return;
            }
        }
        catch (Exception) { } // the first start, or a file cut short
        float scale;
        using (Graphics g = CreateGraphics()) scale = g.DpiX / 96f;
        Rectangle area = Screen.PrimaryScreen.WorkingArea;
        Size = new Size(Math.Min((int)(1500 * scale), area.Width), Math.Min((int)(950 * scale), area.Height));
        StartPosition = FormStartPosition.CenterScreen;
    }

    static int Int(string s) { return int.Parse(s, CultureInfo.InvariantCulture); }

    void KeepPlace()
    {
        Rectangle r = WindowState == FormWindowState.Normal ? Bounds : RestoreBounds;
        try { File.WriteAllText(boundsFile, string.Format(CultureInfo.InvariantCulture, "{0},{1},{2},{3},{4}", r.X, r.Y, r.Width, r.Height, WindowState == FormWindowState.Maximized ? 1 : 0)); }
        catch (Exception) { }
    }

    async void Start()
    {
        try
        {
            Directory.CreateDirectory(profile);
            CoreWebView2Environment env = await CoreWebView2Environment.CreateAsync(null, profile, null);
            await web.EnsureCoreWebView2Async(env);
        }
        catch (Exception e)
        {
            Console.Error.WriteLine(e);
            Environment.ExitCode = 2;
            left = true;
            Close();
            return;
        }
        CoreWebView2 core = web.CoreWebView2;
        core.Settings.IsStatusBarEnabled = false;
        core.Settings.IsPasswordAutosaveEnabled = false;
        core.Settings.IsGeneralAutofillEnabled = false;
        core.Settings.IsSwipeNavigationEnabled = false;
        core.DocumentTitleChanged += delegate { Text = string.IsNullOrEmpty(core.DocumentTitle) || core.DocumentTitle == "about:blank" ? "Trip Planner" : core.DocumentTitle; };
        core.WindowCloseRequested += delegate { Close(); };
        // Other sites open in the default browser, never in this window or another one like it.
        core.NewWindowRequested += delegate(object s, CoreWebView2NewWindowRequestedEventArgs e) { if (OpenOutside(e.Uri)) e.Handled = true; };
        core.NavigationStarting += delegate(object s, CoreWebView2NavigationStartingEventArgs e) { if (OpenOutside(e.Uri)) e.Cancel = true; };
        core.ProcessFailed += delegate(object s, CoreWebView2ProcessFailedEventArgs e)
        {
            if (e.ProcessFailedKind == CoreWebView2ProcessFailedKind.RenderProcessExited) core.Reload();
            else if (e.ProcessFailedKind == CoreWebView2ProcessFailedKind.BrowserProcessExited) { left = true; Close(); }
        };
        core.Navigate(home.AbsoluteUri);
    }

    /// Opens a web address that isn't the planner's in the default browser; false for the planner's own pages.
    bool OpenOutside(string address)
    {
        Uri u;
        if (!Uri.TryCreate(address, UriKind.Absolute, out u) || (u.Scheme != "http" && u.Scheme != "https")) return false;
        if (u.Authority == home.Authority) return false;
        try { Process.Start(new ProcessStartInfo(u.AbsoluteUri) { UseShellExecute = true }); } catch (Exception) { }
        return true;
    }

    /// Before closing, the page is left properly: it tells the app it's gone, and the app quits after its last window.
    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        base.OnFormClosing(e);
        if (!left) KeepPlace();
        if (left || web.CoreWebView2 == null || e.CloseReason == CloseReason.WindowsShutDown) return;
        e.Cancel = true;
        if (leaving) return;
        leaving = true;
        Hide();
        Timer timer = new Timer { Interval = 1500 }; // at the latest
        timer.Tick += delegate { timer.Stop(); left = true; Close(); };
        web.CoreWebView2.NavigationCompleted += delegate { timer.Stop(); timer.Interval = 300; timer.Start(); };
        timer.Start();
        web.CoreWebView2.Navigate("about:blank");
    }
}
