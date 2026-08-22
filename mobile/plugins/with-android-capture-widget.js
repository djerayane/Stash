const { withAndroidManifest, withDangerousMod } = require("expo/config-plugins");
const { mkdir, writeFile } = require("node:fs/promises");
const { join } = require("node:path");

function withManifest(config) {
  return withAndroidManifest(config, (result) => {
    const application = result.modResults.manifest.application?.[0];
    if (!application) throw new Error("Android application manifest is unavailable.");
    application.receiver ??= [];
    application.activity ??= [];
    if (!application.receiver.some((receiver) => receiver.$?.["android:name"] === ".StashCaptureWidgetProvider")) {
      application.receiver.push({ $: { "android:name": ".StashCaptureWidgetProvider", "android:exported": "true" },
        "intent-filter": [{ action: [{ $: { "android:name": "android.appwidget.action.APPWIDGET_UPDATE" } }] }],
        "meta-data": [{ $: { "android:name": "android.appwidget.provider", "android:resource": "@xml/stash_capture_widget_info" } }] });
    }
    if (!application.activity.some((activity) => activity.$?.["android:name"] === ".StashCaptureWidgetConfigureActivity")) {
      application.activity.push({ $: { "android:name": ".StashCaptureWidgetConfigureActivity", "android:exported": "true" },
        "intent-filter": [{ action: [{ $: { "android:name": "android.appwidget.action.APPWIDGET_CONFIGURE" } }] }] });
    }
    return result;
  });
}

function withSources(config) {
  return withDangerousMod(config, ["android", async (result) => {
    const projectRoot = result.modRequest.platformProjectRoot;
    const packageName = result.android?.package;
    if (!packageName) throw new Error("expo.android.package is required for the capture widget.");
    const sourceDirectory = join(projectRoot, "app", "src", "main", "java", ...packageName.split("."));
    const resourceDirectory = join(projectRoot, "app", "src", "main", "res");
    await Promise.all([mkdir(sourceDirectory, { recursive: true }), mkdir(join(resourceDirectory, "layout"), { recursive: true }),
      mkdir(join(resourceDirectory, "xml"), { recursive: true })]);
    await writeFile(join(sourceDirectory, "StashCaptureWidgetProvider.kt"), `package ${packageName}\n\nimport android.app.PendingIntent\nimport android.appwidget.AppWidgetManager\nimport android.appwidget.AppWidgetProvider\nimport android.content.Context\nimport android.content.Intent\nimport android.net.Uri\nimport android.widget.RemoteViews\n\nclass StashCaptureWidgetProvider : AppWidgetProvider() {\n  override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) { ids.forEach { update(context, manager, it) } }\n  companion object {\n    fun update(context: Context, manager: AppWidgetManager, id: Int) {\n      val content = context.getSharedPreferences(\"stash_capture_widget\", Context.MODE_PRIVATE).getString(\"content_$id\", \"New widget capture\")!!\n      val uri = Uri.Builder().scheme(\"stash\").authority(\"capture\").appendQueryParameter(\"source\", \"widget\").appendQueryParameter(\"content\", content).build()\n      val intent = Intent(Intent.ACTION_VIEW, uri, context, MainActivity::class.java)\n      val pending = PendingIntent.getActivity(context, id, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)\n      val views = RemoteViews(context.packageName, R.layout.stash_capture_widget)\n      views.setTextViewText(R.id.stash_capture_action, content)\n      views.setOnClickPendingIntent(R.id.stash_capture_action, pending)\n      manager.updateAppWidget(id, views)\n    }\n  }\n}\n`);
    await writeFile(join(sourceDirectory, "StashCaptureWidgetConfigureActivity.kt"), `package ${packageName}\n\nimport android.app.Activity\nimport android.appwidget.AppWidgetManager\nimport android.content.Intent\nimport android.os.Bundle\nimport android.widget.Button\nimport android.widget.EditText\nimport android.widget.LinearLayout\n\nclass StashCaptureWidgetConfigureActivity : Activity() {\n  public override fun onCreate(state: Bundle?) {\n    super.onCreate(state)\n    val id = intent.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID)\n    setResult(RESULT_CANCELED)\n    val input = EditText(this).apply { hint = \"What should this widget capture?\"; maxLines = 4 }\n    val save = Button(this).apply { text = \"Save widget\"; setOnClickListener {\n      val content = input.text.toString().trim()\n      if (id == AppWidgetManager.INVALID_APPWIDGET_ID || content.isEmpty()) { input.error = \"Capture text is required\"; return@setOnClickListener }\n      getSharedPreferences(\"stash_capture_widget\", MODE_PRIVATE).edit().putString(\"content_$id\", content).apply()\n      StashCaptureWidgetProvider.update(this@StashCaptureWidgetConfigureActivity, AppWidgetManager.getInstance(this@StashCaptureWidgetConfigureActivity), id)\n      setResult(RESULT_OK, Intent().putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, id)); finish()\n    } }\n    setContentView(LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(48, 48, 48, 48); addView(input); addView(save) })\n  }\n}\n`);
    await writeFile(join(resourceDirectory, "layout", "stash_capture_widget.xml"), `<?xml version="1.0" encoding="utf-8"?>\n<FrameLayout xmlns:android="http://schemas.android.com/apk/res/android" android:layout_width="match_parent" android:layout_height="match_parent" android:padding="16dp" android:background="#F2F0E9"><TextView android:id="@+id/stash_capture_action" android:layout_width="match_parent" android:layout_height="match_parent" android:gravity="center" android:text="Capture in Stash" android:textColor="#151515" android:textSize="18sp" android:textStyle="bold" /></FrameLayout>\n`);
    await writeFile(join(resourceDirectory, "xml", "stash_capture_widget_info.xml"), `<?xml version="1.0" encoding="utf-8"?>\n<appwidget-provider xmlns:android="http://schemas.android.com/apk/res/android" android:configure="${packageName}.StashCaptureWidgetConfigureActivity" android:initialLayout="@layout/stash_capture_widget" android:minWidth="110dp" android:minHeight="40dp" android:resizeMode="horizontal|vertical" android:widgetCategory="home_screen" />\n`);
    return result;
  }]);
}

module.exports = (config) => withSources(withManifest(config));
