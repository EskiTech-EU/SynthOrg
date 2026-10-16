package org.synthorg.phone

import android.Manifest
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.graphics.Insets
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  // "Chiudi SynthOrg" in the notification of LinkService closes the app too.
  private val closer = object : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) { finishAndRemoveTask() }
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    val filter = IntentFilter(LinkService.ACTION_CLOSE)
    if (Build.VERSION.SDK_INT >= 33) registerReceiver(closer, filter, Context.RECEIVER_NOT_EXPORTED) else registerReceiver(closer, filter)
    if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
      requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
    }
    LinkService.start(this)
  }

  override fun onDestroy() {
    unregisterReceiver(closer)
    if (isFinishing) LinkService.stop(this)
    super.onDestroy()
  }

  override fun onWebViewCreate(webView: WebView) {
    // The back button from the assistant, the first section, sends the app to the
    // background as Android does, instead of closing it: the link with the
    // computer stays open (remote.js).
    webView.addJavascriptInterface(object {
      @JavascriptInterface
      fun toBackground() {
        runOnUiThread { moveTaskToBack(true) }
      }

      // A link that leads outside the app opens in the phone's browser (or mail app): the app's
      // own page stays where it is (remote.js).
      @JavascriptInterface
      fun openExternal(url: String) {
        if (!(url.startsWith("https://") || url.startsWith("http://") || url.startsWith("mailto:"))) return
        runOnUiThread {
          try { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) } catch (e: Exception) {}
        }
      }
    }, "SynthorgAndroid")

    // An app, not a web page: no zoom with two fingers or a double tap.
    webView.settings.setSupportZoom(false)
    webView.settings.builtInZoomControls = false
    webView.settings.displayZoomControls = false

    // A message read aloud starts when its audio is ready, a moment after the button was pressed:
    // the page may start it then, without a second press.
    webView.settings.mediaPlaybackRequiresUserGesture = false

    // The keyboard: the page ends where the keyboard starts, instead of the
    // whole page sliding up under the status bar. The web page is told, so it
    // can leave under the keyboard what is not needed while typing.
    var open: Boolean? = null
    ViewCompat.setOnApplyWindowInsetsListener(webView) { view, insets ->
      val ime = insets.getInsets(WindowInsetsCompat.Type.ime()).bottom
      val nav = insets.getInsets(WindowInsetsCompat.Type.navigationBars()).bottom
      val lift = if (ime > nav) ime else 0
      (view.parent as? ViewGroup)?.let { parent ->
        if (parent.paddingBottom != lift) parent.setPadding(0, 0, 0, lift)
      }
      val shown = lift > 0
      if (open != shown) {
        open = shown
        view.post { (view as WebView).evaluateJavascript("document.documentElement.classList.toggle('kb-open', $shown)", null) }
      }
      // The page keeps the bars' insets for its safe areas; the keyboard is already out of its way.
      val rest = WindowInsetsCompat.Builder(insets)
        .setInsets(WindowInsetsCompat.Type.ime(), Insets.NONE)
        .build()
      ViewCompat.onApplyWindowInsets(view, rest)
      WindowInsetsCompat.CONSUMED
    }
  }
}
