import UIKit
import Capacitor

/// UIKit UIScene lifecycle delegate required by apps built with the iOS 27 SDK.
/// Programmatically attaches `AllinOneViewController` to the primary application `UIWindowScene`
/// with the dark `#0B0E14` surface background to prevent cold-start flashes and duplicate WebViews
/// on external displays.
class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    private static let darkSurfaceColor = UIColor(
        red: 11.0 / 255.0,
        green: 14.0 / 255.0,
        blue: 20.0 / 255.0,
        alpha: 1.0
    )

    var window: UIWindow?

    func scene(
        _ scene: UIScene,
        willConnectTo session: UISceneSession,
        options connectionOptions: UIScene.ConnectionOptions
    ) {
        guard session.role == .windowApplication,
              let windowScene = scene as? UIWindowScene else {
            return
        }

        let window = UIWindow(windowScene: windowScene)
        window.backgroundColor = Self.darkSurfaceColor
        window.rootViewController = AllinOneViewController()
        self.window = window
        window.makeKeyAndVisible()

        for context in connectionOptions.urlContexts {
            _ = ApplicationDelegateProxy.shared.application(
                UIApplication.shared,
                open: context.url,
                options: [:]
            )
        }

        for userActivity in connectionOptions.userActivities {
            _ = ApplicationDelegateProxy.shared.application(
                UIApplication.shared,
                continue: userActivity,
                restorationHandler: { _ in }
            )
        }
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        for context in URLContexts {
            _ = ApplicationDelegateProxy.shared.application(
                UIApplication.shared,
                open: context.url,
                options: [:]
            )
        }
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        _ = ApplicationDelegateProxy.shared.application(
            UIApplication.shared,
            continue: userActivity,
            restorationHandler: { _ in }
        )
    }

    func sceneDidDisconnect(_ scene: UIScene) {
    }

    func sceneDidBecomeActive(_ scene: UIScene) {
    }

    func sceneWillResignActive(_ scene: UIScene) {
    }

    func sceneWillEnterForeground(_ scene: UIScene) {
    }

    func sceneDidEnterBackground(_ scene: UIScene) {
    }
}
