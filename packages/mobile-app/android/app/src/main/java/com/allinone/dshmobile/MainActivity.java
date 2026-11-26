package com.allinone.dshmobile;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        AllinOneUpdaterPlugin.prepareBootGuard(this);
        registerPlugin(AllinOneFilesPlugin.class);
        registerPlugin(AllinOneUpdaterPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
