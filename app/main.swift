// PokeClaude.app: the field in a window of its own, and the only process on this
// machine allowed to put a Pokeball on a notification.
//
// Two jobs, and the second one is the reason this exists at all:
//
//   1. A WKWebView pointed at http://localhost:5180. The client is static files with
//      no build step, so this is a window around the same page Brave shows.
//   2. A notification poster. macOS credits an alert to the process that asked for it.
//      osascript means every alert arrives as "Script Editor" with a script icon, and
//      an AppleScript applet of our own is DENIED outright on macOS 26 (see AGENTS.md).
//      UNUserNotificationCenter from a real signed bundle in /Applications is the only
//      way left, so the server hands its alerts here over SSE and this posts them.
//
// The app is not required. Close it and the server keeps notifying through osascript;
// nothing that matters lives in this process.

import AppKit
import WebKit
import UserNotifications

let SERVER = "http://localhost:5180"
// Written in by tools/build-app.sh. The app has to know where the repo is to start the
// server, and a localhost tool for one machine may as well be told at build time.
let REPO = Bundle.main.object(forInfoDictionaryKey: "PCRepoPath") as? String ?? ""
let CMUX = "/Applications/cmux.app/Contents/Resources/bin/cmux"

// MARK: - Talking to the server

// Is anything serving? A refused connection and a 200 are the only two answers that
// matter, so the body is never read.
func serverIsUp(timeout: TimeInterval = 1.5) -> Bool {
    guard let url = URL(string: SERVER + "/api/state") else { return false }
    var req = URLRequest(url: url)
    req.timeoutInterval = timeout
    req.httpMethod = "HEAD"
    var up = false
    let sem = DispatchSemaphore(value: 0)
    URLSession.shared.dataTask(with: req) { _, resp, _ in
        up = (resp as? HTTPURLResponse)?.statusCode ?? 0 > 0
        sem.signal()
    }.resume()
    _ = sem.wait(timeout: .now() + timeout + 0.5)
    return up
}

// Start the server the ONE way that works: inside a cmux workspace. cmux's control
// socket is cmuxOnly, so a server started from here as a plain child process would
// serve the page and then quietly lose titles, branches, models and every service pen.
// Outside cmux the CLI itself needs the password from .env, which is why this can fail
// and why failing has to be visible rather than silent.
@discardableResult
func startServer() -> String? {
    guard !REPO.isEmpty, FileManager.default.fileExists(atPath: CMUX) else {
        return "cmux is not installed where the app expects it: \(CMUX)"
    }
    var args = ["new-workspace", "--name", "pokeclaude server", "--cwd", REPO,
                "--command", "./run-server.sh"]
    if let pw = socketPassword() { args = ["--password", pw] + args }

    let p = Process()
    p.executableURL = URL(fileURLWithPath: CMUX)
    p.arguments = args
    let err = Pipe()
    p.standardError = err
    p.standardOutput = Pipe()
    do { try p.run() } catch { return "could not run cmux: \(error.localizedDescription)" }
    p.waitUntilExit()
    if p.terminationStatus == 0 { return nil }
    let msg = String(data: err.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
    return msg.isEmpty ? "cmux refused to open the workspace (exit \(p.terminationStatus))" : msg
}

// The same password src/server/cmux.js reads, from the same gitignored file.
func socketPassword() -> String? {
    guard let env = try? String(contentsOfFile: REPO + "/.env", encoding: .utf8) else { return nil }
    for line in env.split(separator: "\n") {
        let parts = line.split(separator: "=", maxSplits: 1)
        guard parts.count == 2, parts[0].trimmingCharacters(in: .whitespaces) == "CMUX_SOCKET_PASSWORD"
        else { continue }
        let v = parts[1].trimmingCharacters(in: CharacterSet(charactersIn: " \"'\t"))
        return v.isEmpty ? nil : v
    }
    return nil
}

// MARK: - Links

// The page itself, as opposed to a link out of it. Host and port are compared rather
// than a string prefix, which would count localhost:51800 as the field.
func isField(_ url: URL) -> Bool {
    guard let s = URL(string: SERVER) else { return false }
    return url.host == s.host && url.port == s.port
}

// Brave, because every other link on this machine opens there; the system default only
// if Brave is gone. Links come out of transcripts, which are untrusted, so only web and
// mail schemes leave the app: never file:// or a custom scheme that launches something.
func openOutside(_ url: URL) {
    guard let scheme = url.scheme?.lowercased(), ["http", "https", "mailto"].contains(scheme)
    else { return }
    let ws = NSWorkspace.shared
    if let brave = ws.urlForApplication(withBundleIdentifier: "com.brave.Browser") {
        ws.open([url], withApplicationAt: brave, configuration: NSWorkspace.OpenConfiguration())
    } else {
        ws.open(url)
    }
}

// MARK: - Notifications

// One SSE connection to /api/notify-stream, reconnected forever. The server decides
// WHAT is worth an interruption and when; this only draws it. Keeping the decision on
// the server is what lets notifications keep working with the app closed.
final class NotifyClient: NSObject, URLSessionDataDelegate {
    private var session: URLSession!
    private var task: URLSessionDataTask?
    private var buffer = ""
    private var retry: TimeInterval = 1
    private var wanted = false

    override init() {
        super.init()
        let cfg = URLSessionConfiguration.default
        // An event stream that goes quiet is normal: agents idle for hours. Only a
        // dropped connection should reconnect, never a timeout on a healthy stream.
        cfg.timeoutIntervalForRequest = 86400
        cfg.timeoutIntervalForResource = 86400
        session = URLSession(configuration: cfg, delegate: self, delegateQueue: nil)
    }

    // Off by default. The app subscribes only once macOS says it may show what it
    // posts; see syncNotifyPermission.
    func disconnect() {
        wanted = false
        task?.cancel()
        task = nil
    }

    func connect() {
        wanted = true
        if task != nil { return }
        task?.cancel()
        buffer = ""
        guard let url = URL(string: SERVER + "/api/notify-stream") else { return }
        var req = URLRequest(url: url)
        req.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        task = session.dataTask(with: req)
        task?.resume()
    }

    private func reconnect() {
        task = nil
        guard wanted else { return }
        let wait = retry
        retry = min(retry * 2, 30)   // a server restarting takes seconds; a server that
                                     // is gone should not be asked 30 times a minute
        DispatchQueue.main.asyncAfter(deadline: .now() + wait) { [weak self] in self?.connect() }
    }

    func urlSession(_ s: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        retry = 1
        buffer += String(data: data, encoding: .utf8) ?? ""
        // SSE frames end on a blank line. Anything after the last one is a partial
        // frame: keep it, or a notification arriving in two packets is lost.
        while let cut = buffer.range(of: "\n\n") {
            let frame = String(buffer[..<cut.lowerBound])
            buffer = String(buffer[cut.upperBound...])
            for line in frame.split(separator: "\n") where line.hasPrefix("data:") {
                let json = line.dropFirst(5).trimmingCharacters(in: .whitespaces)
                if let d = json.data(using: .utf8),
                   let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any] {
                    post(o)
                }
            }
        }
    }

    func urlSession(_ s: URLSession, task t: URLSessionTask, didCompleteWithError error: Error?) {
        reconnect()
    }

    private func post(_ note: [String: Any]) {
        let c = UNMutableNotificationContent()
        c.title = note["title"] as? String ?? "PokeClaude"
        c.subtitle = note["subtitle"] as? String ?? ""
        c.body = note["body"] as? String ?? ""
        if let s = note["sound"] as? String, !s.isEmpty {
            c.sound = UNNotificationSound(named: UNNotificationSoundName(s + ".aiff"))
        }
        let req = UNNotificationRequest(identifier: UUID().uuidString, content: c, trigger: nil)
        UNUserNotificationCenter.current().add(req)
    }
}

// MARK: - The window

final class Delegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate,
                      UNUserNotificationCenterDelegate {
    var window: NSWindow!
    var web: WKWebView!
    let notifier = NotifyClient()
    private var booting = false

    func applicationDidFinishLaunching(_ n: Notification) {
        UNUserNotificationCenter.current().delegate = self
        buildMenu()

        let cfg = WKWebViewConfiguration()
        web = WKWebView(frame: .zero, configuration: cfg)
        web.navigationDelegate = self
        // Without a UI delegate a WKWebView answers every JS dialog as if Cancel was
        // clicked: alert() shows nothing, confirm() returns false, prompt() returns nil,
        // and the page cannot tell. That is how KILL stopped working in the app while it
        // still worked in Brave. The page no longer asks this way, but anything that
        // does must be seen rather than swallowed.
        web.uiDelegate = self
        // The field is a canvas the page sizes to its window; a rubber band under it
        // just shows grey and makes the whole app feel like a web page.
        web.setValue(false, forKey: "drawsBackground")
        web.allowsMagnification = false

        // A plain titled window, NOT fullSizeContentView. The page puts its own header
        // in the top left corner of the panel, and content running under a transparent
        // titlebar buries it behind the traffic lights.
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1440, height: 900),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
        window.title = "PokeClaude"
        window.contentView = web
        window.setFrameAutosaveName("PokeClaudeMain")
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        load()
        // Asked after the window is up: macOS will not put an authorization prompt in
        // front of an app that has not finished appearing.
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in self?.syncNotifyPermission() }
    }

    // The menu bar. An app built without a nib has NO main menu, and on macOS the
    // standard editing shortcuts are menu key equivalents: with no Edit menu, Cmd+C,
    // Cmd+V, Cmd+X, Cmd+A and Cmd+Z do nothing anywhere in the app, including inside
    // the web view. That is why you could not paste into the reply box. Cmd+Q had no
    // owner either, so the only way to quit was the Dock.
    //
    // Every editing item targets nil, which sends it to whatever holds the keyboard.
    // The web view is a responder like any other, so the page gets them.
    func buildMenu() {
        let main = NSMenu()

        let appItem = NSMenuItem(); main.addItem(appItem)
        let app = NSMenu()
        app.addItem(withTitle: "About PokeClaude",
                    action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        app.addItem(.separator())
        app.addItem(withTitle: "Hide PokeClaude",
                    action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        let others = app.addItem(withTitle: "Hide Others",
                                 action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
        others.keyEquivalentModifierMask = [.command, .option]
        app.addItem(withTitle: "Show All",
                    action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
        app.addItem(.separator())
        app.addItem(withTitle: "Quit PokeClaude",
                    action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = app

        let editItem = NSMenuItem(); main.addItem(editItem)
        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        let redo = edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        edit.addItem(.separator())
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        // A transcript pasted from anywhere else arrives as styled text otherwise, and
        // the composer is a plain textarea.
        let plain = edit.addItem(withTitle: "Paste and Match Style",
                                 action: #selector(NSTextView.pasteAsPlainText(_:)), keyEquivalent: "v")
        plain.keyEquivalentModifierMask = [.command, .option, .shift]
        edit.addItem(withTitle: "Select All",
                     action: #selector(NSResponder.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit

        // The client is static files with no build step, so a reload IS the deploy.
        // Without this the only way to pick up a change was quitting the app.
        let viewItem = NSMenuItem(); main.addItem(viewItem)
        let view = NSMenu(title: "View")
        view.addItem(withTitle: "Reload", action: #selector(reloadPage), keyEquivalent: "r")
        viewItem.submenu = view

        let winItem = NSMenuItem(); main.addItem(winItem)
        let win = NSMenu(title: "Window")
        win.addItem(withTitle: "Minimize",
                    action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        win.addItem(withTitle: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        winItem.submenu = win
        NSApp.windowsMenu = win

        NSApp.mainMenu = main
    }

    @objc func reloadPage() { load() }

    // Closing the last window quits: this is one window, not a document app, and a
    // notifier with no window is what the server's osascript path is for.
    func applicationShouldTerminateAfterLastWindowClosed(_ s: NSApplication) -> Bool { true }

    // Permission can be turned on in System Settings while the app is running, so the
    // answer is asked again every time the app comes forward.
    func applicationDidBecomeActive(_ n: Notification) { syncNotifyPermission() }

    // The one rule this app must not break: it may only hold the notification stream
    // while macOS will actually SHOW what it posts. An unauthorized app still gets
    // `add` back with no error and still files a record, and the alert is never seen,
    // so an app that subscribed anyway would swallow every notification the moment it
    // opened, and the osascript fallback would never run. Whether macOS grants this at
    // all is a signing question, not a code one: an unnotarized bundle is refused with
    // "Notifications are not allowed for this application" and no prompt. See AGENTS.md.
    func syncNotifyPermission() {
        let c = UNUserNotificationCenter.current()
        c.requestAuthorization(options: [.alert, .sound]) { _, _ in
            c.getNotificationSettings { [weak self] st in
                let ok = st.authorizationStatus == .authorized || st.authorizationStatus == .provisional
                self?.log("notifications authorizationStatus=\(st.authorizationStatus.rawValue) taking stream=\(ok)")
                DispatchQueue.main.async {
                    guard let self else { return }
                    if ok { self.notifier.connect() } else { self.notifier.disconnect() }
                }
            }
        }
    }

    // One line per launch, because the failure this app is most likely to have is one
    // nobody can see: alerts that go nowhere and a fallback that never fires.
    private func log(_ s: String) {
        let line = "\(Date()) \(s)\n"
        let path = "/tmp/pokeclaude-app.log"
        if let fh = FileHandle(forWritingAtPath: path) {
            fh.seekToEndOfFile(); fh.write(line.data(using: .utf8)!); try? fh.close()
        } else {
            try? line.write(toFile: path, atomically: true, encoding: .utf8)
        }
    }

    // macOS hides a notification while the app that sent it is frontmost. Here the
    // whole point is being told about an agent while you are looking at something else,
    // but if you ARE looking at the field, the field already shows it.
    func userNotificationCenter(_ c: UNUserNotificationCenter,
                                willPresent n: UNNotification,
                                withCompletionHandler done: @escaping (UNNotificationPresentationOptions) -> Void) {
        done([.banner, .sound])
    }

    func load() {
        if serverIsUp() {
            web.load(URLRequest(url: URL(string: SERVER)!))
        } else if !booting {
            booting = true
            show(html: bootingPage())
            DispatchQueue.global().async { [weak self] in
                let err = startServer()
                self?.waitForServer(startError: err)
            }
        }
    }

    // The server takes a few seconds to come up inside a fresh cmux workspace, so a
    // single check after starting it would always say it failed.
    private func waitForServer(startError: String?) {
        for _ in 0..<40 {
            if serverIsUp(timeout: 0.8) {
                DispatchQueue.main.async { [weak self] in
                    guard let self else { return }
                    self.booting = false
                    self.web.load(URLRequest(url: URL(string: SERVER)!))
                    self.notifier.connect()
                }
                return
            }
            Thread.sleep(forTimeInterval: 0.5)
        }
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.booting = false
            self.show(html: self.downPage(startError))
        }
    }

    private func show(html: String) { web.loadHTMLString(html, baseURL: nil) }

    // A page in the window beats an alert sheet: it can hold the command you need to
    // run, and it does not have to be dismissed before you can read it.
    private func page(_ body: String) -> String {
        """
        <meta charset="utf-8"><style>
          :root { color-scheme: dark }
          body { margin:0; height:100vh; display:grid; place-content:center; gap:14px;
                 background:#101418; color:#e8e8e8; text-align:center;
                 font:15px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace }
          h1 { font-size:19px; margin:0; font-weight:600 }
          p { margin:0; color:#9aa4ad; max-width:60ch }
          code { display:block; padding:12px 16px; background:#0a0d10; border:1px solid #222a31;
                 border-radius:8px; color:#cfd6dc; white-space:pre-wrap; text-align:left }
          button { font:inherit; padding:8px 18px; border-radius:8px; border:1px solid #2a343d;
                   background:#18202a; color:#e8e8e8; cursor:pointer }
        </style>\(body)
        """
    }

    private func bootingPage() -> String {
        page("<h1>Starting the server</h1><p>Opening a cmux workspace on ./run-server.sh</p>")
    }

    private func downPage(_ err: String?) -> String {
        let why = err.map { "<p>\($0.replacingOccurrences(of: "<", with: "&lt;"))</p>" } ?? ""
        return page("""
        <h1>No server on port 5180</h1>\(why)
        <p>Start it in its own cmux workspace. It must run inside cmux: outside it the
        control socket is denied and titles, branches, models and service pens go missing.</p>
        <code>cd \(REPO)\n./run-server.sh</code>
        <p><button onclick="location.reload()">Try again</button></p>
        """)
    }

    func webView(_ w: WKWebView, didFail nav: WKNavigation!, withError e: Error) {
        show(html: downPage(e.localizedDescription))
    }

    func webView(_ w: WKWebView, didFailProvisionalNavigation nav: WKNavigation!, withError e: Error) {
        show(html: downPage(e.localizedDescription))
    }

    // MARK: - Links
    //
    // A WKWebView drops every target="_blank" link and every window.open() unless the
    // UI delegate makes a web view for it, and says nothing. That is why the links in a
    // chat reply did nothing in the app while they worked in Brave. This is one window,
    // so a link that wants a new one goes to the browser instead.
    func webView(_ w: WKWebView, createWebViewWith cfg: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures f: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url { openOutside(url) }
        return nil
    }

    // A plain link that leaves the page would replace the field in this window, and
    // there is no back button to get it back.
    func webView(_ w: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler done: @escaping (WKNavigationActionPolicy) -> Void) {
        if action.navigationType == .linkActivated, let url = action.request.url, !isField(url) {
            openOutside(url)
            done(.cancel)
            return
        }
        done(.allow)
    }

    // MARK: - JavaScript dialogs
    //
    // A WKWebView with no UI delegate cancels every one of these without telling the
    // page. Three panels, all sheets on the window, so a question from the page is
    // answered where the page is.

    func webView(_ w: WKWebView, runJavaScriptAlertPanelWithMessage msg: String,
                 initiatedByFrame f: WKFrameInfo, completionHandler done: @escaping () -> Void) {
        let a = NSAlert()
        a.messageText = msg
        a.addButton(withTitle: "OK")
        a.beginSheetModal(for: window) { _ in done() }
    }

    func webView(_ w: WKWebView, runJavaScriptConfirmPanelWithMessage msg: String,
                 initiatedByFrame f: WKFrameInfo, completionHandler done: @escaping (Bool) -> Void) {
        let a = NSAlert()
        a.messageText = msg
        a.addButton(withTitle: "OK")
        a.addButton(withTitle: "Cancel")
        a.beginSheetModal(for: window) { r in done(r == .alertFirstButtonReturn) }
    }

    func webView(_ w: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String,
                 defaultText: String?, initiatedByFrame f: WKFrameInfo,
                 completionHandler done: @escaping (String?) -> Void) {
        let a = NSAlert()
        a.messageText = prompt
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 260, height: 22))
        field.stringValue = defaultText ?? ""
        a.accessoryView = field
        a.addButton(withTitle: "OK")
        a.addButton(withTitle: "Cancel")
        a.beginSheetModal(for: window) { r in
            done(r == .alertFirstButtonReturn ? field.stringValue : nil)
        }
    }
}

let app = NSApplication.shared
let delegate = Delegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
