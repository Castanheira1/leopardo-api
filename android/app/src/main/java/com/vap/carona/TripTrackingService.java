package com.vap.carona;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.util.Log;

import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;
import androidx.core.content.ContextCompat;

/**
 * Foreground Service exigido pelo Android para manter o processo (e o GPS do
 * WebView/JS) vivo com a tela apagada durante a carona.
 *
 * A partir do Android 14 (API 34) o startForeground() de um serviço do tipo
 * "location" lança SecurityException se a permissão de localização não estiver
 * concedida no momento da chamada. Como isso acontece dentro do serviço, o
 * try/catch do TripTrackingPlugin não protege — o app cairia. Daí a checagem de
 * permissão e o catch aqui: sem localização, o serviço desiste em silêncio em vez
 * de derrubar a viagem.
 */
public class TripTrackingService extends Service {
    private static final String TAG = "TripTracking";
    public static final String CHANNEL_ID = "vap_trip_tracking";
    public static final int NOTIF_ID = 7101;
    public static final String EXTRA_TITLE = "title";
    public static final String EXTRA_BODY = "body";

    @Override
    public void onCreate() {
        super.onCreate();
        criarCanal();
    }

    /** O tipo "location" do serviço exige localização concedida na hora do startForeground. */
    static boolean temPermissaoLocalizacao(Context ctx) {
        return ContextCompat.checkSelfPermission(ctx, Manifest.permission.ACCESS_FINE_LOCATION)
                == PackageManager.PERMISSION_GRANTED
                || ContextCompat.checkSelfPermission(ctx, Manifest.permission.ACCESS_COARSE_LOCATION)
                == PackageManager.PERMISSION_GRANTED;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        // intent nulo = reinício pelo sistema (START_STICKY) depois do processo morrer.
        String title = intent != null ? intent.getStringExtra(EXTRA_TITLE) : null;
        String body = intent != null ? intent.getStringExtra(EXTRA_BODY) : null;
        if (title == null || title.isEmpty()) title = "VAP";
        if (body == null || body.isEmpty()) body = "Rastreando sua viagem";

        if (!temPermissaoLocalizacao(this)) {
            Log.w(TAG, "Sem permissão de localização — serviço de rastreamento não iniciado.");
            stopSelf();
            return START_NOT_STICKY;
        }

        Intent open = getPackageManager().getLaunchIntentForPackage(getPackageName());
        PendingIntent pi = PendingIntent.getActivity(
                this,
                0,
                open != null ? open : new Intent(),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        Notification notif = new NotificationCompat.Builder(this, CHANNEL_ID)
                .setContentTitle(title)
                .setContentText(body)
                .setSmallIcon(R.mipmap.ic_launcher)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setCategory(NotificationCompat.CATEGORY_NAVIGATION)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setContentIntent(pi)
                .build();

        try {
            ServiceCompat.startForeground(
                    this,
                    NOTIF_ID,
                    notif,
                    Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
                            ? ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION
                            : 0
            );
        } catch (Exception e) {
            // Android 14+: SecurityException (permissão revogada entre o start e o
            // startForeground) ou ForegroundServiceStartNotAllowedException (início a
            // partir do background). Encerra limpo em vez de crashar.
            Log.w(TAG, "Falha ao entrar em foreground: " + e.getMessage());
            stopSelf();
            return START_NOT_STICKY;
        }
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE);
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private void criarCanal() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        NotificationChannel ch = new NotificationChannel(
                CHANNEL_ID,
                "Rastreamento de viagem",
                NotificationManager.IMPORTANCE_LOW
        );
        ch.setDescription("Mantém o GPS ativo durante a carona");
        ch.setShowBadge(false);
        nm.createNotificationChannel(ch);
    }
}
