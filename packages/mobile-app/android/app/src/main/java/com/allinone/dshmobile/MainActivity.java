package com.allinone.dshmobile;

import android.os.Bundle;
import android.webkit.WebView;

import androidx.activity.OnBackPressedCallback;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        AllinOneUpdaterPlugin.prepareBootGuard(this);
        registerPlugin(AllinOneFilesPlugin.class);
        registerPlugin(AllinOneUpdaterPlugin.class);
        super.onCreate(savedInstanceState);

        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                WebView webView = getBridge() != null ? getBridge().getWebView() : null;
                if (webView == null) {
                    moveTaskToBack(true);
                    return;
                }
                webView.evaluateJavascript(
                    "(function(){var e=new CustomEvent('allinone:backbutton',{cancelable:true});window.dispatchEvent(e);return e.defaultPrevented;})()",
                    result -> {
                        if (!"true".equals(result)) {
                            moveTaskToBack(true);
                        }
                    }
                );
            }
        });
    }

    private void dispatchAppStateEvent(boolean isActive) {
        WebView webView = getBridge() != null ? getBridge().getWebView() : null;
        if (webView == null) return;
        webView.post(() -> webView.evaluateJavascript(
            "window.dispatchEvent(new CustomEvent('allinone:appstate',{detail:{isActive:" + isActive + "}}))",
            null
        ));
    }

    @Override
    public void onResume() {
        super.onResume();
        dispatchAppStateEvent(true);
    }

    @Override
    public void onPause() {
        dispatchAppStateEvent(false);
        super.onPause();
    }
}
