package com.vap.carona;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Plugin local de foreground service para viagem.
        registerPlugin(TripTrackingPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
