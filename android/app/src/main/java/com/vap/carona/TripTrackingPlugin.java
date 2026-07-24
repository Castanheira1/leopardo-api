package com.vap.carona;

import android.content.Intent;
import android.os.Build;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Ponte JS ↔ Foreground Service de rastreamento de viagem.
 * Exposto como Capacitor.Plugins.TripTracking no WebView nativo.
 */
@CapacitorPlugin(name = "TripTracking")
public class TripTrackingPlugin extends Plugin {

    @PluginMethod
    public void start(PluginCall call) {
        String title = call.getString("title", "VAP");
        String body = call.getString("body", "Rastreando sua viagem");

        // Checa antes de disparar: o serviço é do tipo "location" e, sem permissão, o
        // Android 14+ derruba o processo no startForeground (dentro do serviço, fora
        // deste try/catch). Aqui o JS recebe um erro tratável.
        if (!TripTrackingService.temPermissaoLocalizacao(getContext())) {
            call.reject("Permissão de localização não concedida");
            return;
        }

        Intent intent = new Intent(getContext(), TripTrackingService.class);
        intent.putExtra(TripTrackingService.EXTRA_TITLE, title);
        intent.putExtra(TripTrackingService.EXTRA_BODY, body);

        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                getContext().startForegroundService(intent);
            } else {
                getContext().startService(intent);
            }
            call.resolve();
        } catch (Exception e) {
            call.reject("Falha ao iniciar rastreamento: " + e.getMessage());
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        try {
            Intent intent = new Intent(getContext(), TripTrackingService.class);
            getContext().stopService(intent);
            call.resolve();
        } catch (Exception e) {
            call.reject("Falha ao parar rastreamento: " + e.getMessage());
        }
    }
}
