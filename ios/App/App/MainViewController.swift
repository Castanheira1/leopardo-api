import UIKit
import Capacitor

/**
 Equivalente iOS do `MainActivity.registerPlugin()` do Android.

 O Capacitor só auto-registra plugins que vêm de pacotes npm: ele lê a lista
 `packageClassList` do capacitor.config.json gerado pelo `cap sync`. Plugins locais
 do app, como o TripTrackingPlugin, não entram nessa lista e precisam ser
 registrados à mão — sem isto, `Capacitor.Plugins.TripTracking` fica indefinido no
 JS e o rastreamento em segundo plano silenciosamente não acontece.

 O Main.storyboard aponta para esta classe em vez de CAPBridgeViewController.
 */
class MainViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(TripTrackingPlugin())
    }
}
