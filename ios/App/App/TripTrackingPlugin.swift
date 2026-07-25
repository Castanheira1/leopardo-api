import Foundation
import Capacitor
import CoreLocation

/**
 Rastreamento da viagem no iOS, incluindo segundo plano.

 Por que existe: o WKWebView é suspenso quando o app sai de primeiro plano, então o
 `navigator.geolocation.watchPosition()` do JS para de receber posições com a tela
 apagada. No Android o Foreground Service mantém a WebView viva e o JS continua
 funcionando; no iOS não há equivalente — a coleta precisa ser nativa.

 Autorização: "When In Use" é suficiente. Com o modo de fundo `location` no
 Info.plist mais `allowsBackgroundLocationUpdates`, o iOS continua entregando
 posições em segundo plano e mostra o indicador azul na barra de status. Não
 pedimos "Always": seria mais atrito para o usuário e mais escrutínio na revisão da
 Apple, sem ganho — "Always" só serve para rastrear sem o app ter sido aberto, que
 não é o caso da carona.

 As posições são entregues de duas formas, porque o JS nem sempre está rodando:
 - evento `position` (mesmo formato do GeolocationPosition da web), consumido ao vivo;
 - buffer nativo drenado por `drain()` quando o app volta ao primeiro plano, para
   recuperar o trecho percorrido enquanto a WebView estava suspensa.
 */
@objc(TripTrackingPlugin)
public class TripTrackingPlugin: CAPPlugin, CAPBridgedPlugin, CLLocationManagerDelegate {
    public let identifier = "TripTrackingPlugin"
    public let jsName = "TripTracking"
    public let pluginMethods: [CAPPluginMethod] = [
        .init(name: "start", returnType: CAPPluginReturnPromise),
        .init(name: "stop", returnType: CAPPluginReturnPromise),
        .init(name: "drain", returnType: CAPPluginReturnPromise)
    ]

    private let manager = CLLocationManager()

    /// Buffer do trecho percorrido com a WebView suspensa. Protegido por lock: o
    /// delegate do CoreLocation roda na main thread e os métodos do plugin chegam
    /// pela fila do Capacitor.
    private var pendentes: [[String: Any]] = []
    private let lock = NSLock()

    /// Teto do buffer (~5h a um ponto por 20 m em trânsito urbano). Ao estourar,
    /// descarta os mais antigos: o fim do trajeto importa mais que o começo, que já
    /// foi enviado ao servidor.
    private let limiteBuffer = 3000

    /// Guarda o pedido de início feito antes de o usuário responder ao prompt de
    /// permissão, para começar assim que ele autorizar.
    private var aguardandoAutorizacao = false

    override public func load() {
        manager.delegate = self
        // BestForNavigation: precisão de rota em veículo, que é o uso do app.
        manager.desiredAccuracy = kCLLocationAccuracyBestForNavigation
        // 20 m ≈ o mesmo passo que o JS usa para gravar ponto de rota (0.025 km).
        manager.distanceFilter = 20
        manager.activityType = .automotiveNavigation
        // O iOS pausa updates quando acha que o usuário parou; numa carona isso
        // engoliria o trecho parado no trânsito e a retomada.
        manager.pausesLocationUpdatesAutomatically = false
    }

    // MARK: - Métodos expostos ao JS

    @objc func start(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }

            switch self.manager.authorizationStatus {
            case .notDetermined:
                // Começa assim que o usuário responder (locationManagerDidChangeAuthorization).
                self.aguardandoAutorizacao = true
                self.manager.requestWhenInUseAuthorization()
                call.resolve(["nativePositions": true])

            case .restricted, .denied:
                call.reject("Permissão de localização negada")

            case .authorizedWhenInUse, .authorizedAlways:
                self.iniciarUpdates()
                call.resolve(["nativePositions": true])

            @unknown default:
                call.reject("Autorização de localização desconhecida")
            }
        }
    }

    @objc func stop(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            self.aguardandoAutorizacao = false
            self.manager.stopUpdatingLocation()
            // Precisa voltar a false: manter true fora da viagem mantém o app
            // elegível a acordar por localização sem necessidade.
            self.manager.allowsBackgroundLocationUpdates = false
            call.resolve()
        }
    }

    /// Devolve e limpa o buffer acumulado enquanto o JS estava suspenso.
    @objc func drain(_ call: CAPPluginCall) {
        lock.lock()
        let pontos = pendentes
        pendentes.removeAll()
        lock.unlock()
        call.resolve(["positions": pontos])
    }

    // MARK: - CoreLocation

    private func iniciarUpdates() {
        // allowsBackgroundLocationUpdates lança exceção se o target não declarar o
        // modo de fundo `location` no Info.plist — ele está declarado.
        manager.allowsBackgroundLocationUpdates = true
        // Indicador azul na barra de status: o usuário vê que a carona está sendo
        // rastreada e pode cortar a qualquer momento. Transparência que a Apple espera.
        manager.showsBackgroundLocationIndicator = true
        manager.startUpdatingLocation()
    }

    public func locationManagerDidChangeAuthorization(_ mgr: CLLocationManager) {
        switch mgr.authorizationStatus {
        case .authorizedWhenInUse, .authorizedAlways:
            if aguardandoAutorizacao {
                aguardandoAutorizacao = false
                iniciarUpdates()
            }
        case .denied, .restricted:
            aguardandoAutorizacao = false
            mgr.stopUpdatingLocation()
            notifyListeners("trackingError", data: ["message": "Permissão de localização negada"])
        default:
            break
        }
    }

    public func locationManager(_ mgr: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        for loc in locations {
            // horizontalAccuracy negativa = posição inválida.
            guard loc.horizontalAccuracy >= 0 else { continue }

            // Mesmo formato do GeolocationPosition da web, para o JS tratar posição
            // nativa e do navegador pelo mesmo caminho.
            let payload: [String: Any] = [
                "coords": [
                    "latitude": loc.coordinate.latitude,
                    "longitude": loc.coordinate.longitude,
                    "accuracy": loc.horizontalAccuracy,
                    // speed em m/s, negativo quando indisponível — igual à web.
                    "speed": loc.speed
                ],
                "timestamp": loc.timestamp.timeIntervalSince1970 * 1000
            ]

            lock.lock()
            pendentes.append(payload)
            if pendentes.count > limiteBuffer {
                pendentes.removeFirst(pendentes.count - limiteBuffer)
            }
            lock.unlock()

            notifyListeners("position", data: payload)
        }
    }

    public func locationManager(_ mgr: CLLocationManager, didFailWithError error: Error) {
        // kCLErrorLocationUnknown é transitório (o iOS continua tentando) — ignorar
        // evita alarme falso a cada túnel ou garagem.
        if let clErro = error as? CLError, clErro.code == .locationUnknown { return }
        notifyListeners("trackingError", data: ["message": error.localizedDescription])
    }
}
