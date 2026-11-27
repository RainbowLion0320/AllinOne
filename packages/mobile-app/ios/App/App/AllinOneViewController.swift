import UIKit
import Capacitor

/// Custom Capacitor root view controller for All in One on iOS:
///  1. Registers the local Swift `AllinOneFilesPlugin` directly on the SPM bridge (zero CocoaPods).
///  2. Applies the dark `#0B0E14` surface color before WebView paint to eliminate white cold-start flashes.
///  3. Dispatches `allinone:appstate` events on foreground/background transitions so `wsClient.js`
///     immediately recovers WebSocket & WebRTC P2P channels when returning from iOS background.
@objc(AllinOneViewController)
class AllinOneViewController: CAPBridgeViewController {
    private static let darkSurfaceColor = UIColor(
        red: 11.0 / 255.0,
        green: 14.0 / 255.0,
        blue: 20.0 / 255.0,
        alpha: 1.0
    )

    private var lastDispatchedActive: Bool?

    override open func capacitorDidLoad() {
        super.capacitorDidLoad()
        bridge?.registerPluginInstance(AllinOneFilesPlugin())
    }

    override open func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = Self.darkSurfaceColor
        webView?.isOpaque = false
        webView?.backgroundColor = Self.darkSurfaceColor
        webView?.scrollView.backgroundColor = Self.darkSurfaceColor

        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleAppDidBecomeActive),
            name: UIApplication.didBecomeActiveNotification,
            object: nil
        )
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleAppDidBecomeActive),
            name: UIScene.didActivateNotification,
            object: nil
        )
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleAppDidEnterBackground),
            name: UIApplication.didEnterBackgroundNotification,
            object: nil
        )
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleAppDidEnterBackground),
            name: UIScene.didEnterBackgroundNotification,
            object: nil
        )
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
    }

    @objc private func handleAppDidBecomeActive() {
        dispatchAppStateEvent(isActive: true)
    }

    @objc private func handleAppDidEnterBackground() {
        dispatchAppStateEvent(isActive: false)
    }

    private func dispatchAppStateEvent(isActive: Bool) {
        if lastDispatchedActive == isActive { return }
        lastDispatchedActive = isActive
        let js = "window.dispatchEvent(new CustomEvent('allinone:appstate',{detail:{isActive:\(isActive ? "true" : "false")}}))"
        DispatchQueue.main.async { [weak self] in
            self?.webView?.evaluateJavaScript(js, completionHandler: nil)
        }
    }
}
