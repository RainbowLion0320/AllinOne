package com.allinone.dshmobile;

import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.webkit.WebView;

import androidx.activity.OnBackPressedCallback;

import com.getcapacitor.BridgeActivity;

import java.util.concurrent.atomic.AtomicBoolean;

public class MainActivity extends BridgeActivity {
    private static final long BACK_BUTTON_FALLBACK_TIMEOUT_MS = 600L;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());

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
                final AtomicBoolean handled = new AtomicBoolean(false);
                final Runnable fallback = () -> {
                    if (handled.compareAndSet(false, true)) {
                        moveTaskToBack(true);
                    }
                };
                mainHandler.postDelayed(fallback, BACK_BUTTON_FALLBACK_TIMEOUT_MS);
                webView.evaluateJavascript(
                    "(function(){var e=new CustomEvent('allinone:backbutton',{cancelable:true});window.dispatchEvent(e);return e.defaultPrevented;})()",
                    result -> {
                        mainHandler.removeCallbacks(fallback);
                        if (handled.compareAndSet(false, true) && !"true".equals(result)) {
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

    @Override
    public void onDestroy() {
        mainHandler.removeCallbacksAndMessages(null);
        super.onDestroy();
    }
}
