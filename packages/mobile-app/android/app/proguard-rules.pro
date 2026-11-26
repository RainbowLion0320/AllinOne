# ProGuard / R8 rules for All in One Android (Capacitor + custom native plugins)

-keep class com.allinone.dshmobile.** { *; }
-keepclassmembers class com.allinone.dshmobile.** {
    @com.getcapacitor.PluginMethod <methods>;
}
-keep @com.getcapacitor.annotation.CapacitorPlugin class * { *; }
-keep class com.getcapacitor.** { *; }
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
-dontwarn com.getcapacitor.**
