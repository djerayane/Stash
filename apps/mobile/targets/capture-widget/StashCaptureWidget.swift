import AppIntents
import SwiftUI
import WidgetKit

struct CaptureConfiguration: WidgetConfigurationIntent {
  static var title: LocalizedStringResource = "Capture text"
  static var description = IntentDescription("Choose the text Stash will capture when you tap the widget.")

  @Parameter(title: "Text", default: "New widget capture")
  var content: String
}

struct CaptureEntry: TimelineEntry {
  let date: Date
  let configuration: CaptureConfiguration
}

struct CaptureProvider: AppIntentTimelineProvider {
  func placeholder(in context: Context) -> CaptureEntry { CaptureEntry(date: .now, configuration: CaptureConfiguration()) }
  func snapshot(for configuration: CaptureConfiguration, in context: Context) async -> CaptureEntry {
    CaptureEntry(date: .now, configuration: configuration)
  }
  func timeline(for configuration: CaptureConfiguration, in context: Context) async -> Timeline<CaptureEntry> {
    Timeline(entries: [CaptureEntry(date: .now, configuration: configuration)], policy: .never)
  }
}

struct CaptureWidgetView: View {
  let entry: CaptureEntry
  var destination: URL {
    var components = URLComponents(string: "stash://capture")!
    components.queryItems = [URLQueryItem(name: "source", value: "widget"), URLQueryItem(name: "content", value: entry.configuration.content)]
    return components.url!
  }
  var body: some View {
    Link(destination: destination) {
      VStack(alignment: .leading, spacing: 10) {
        Image(systemName: "tray.and.arrow.down.fill").font(.title2)
        Text(entry.configuration.content).font(.headline).lineLimit(3)
        Text("Tap to save securely").font(.caption).foregroundStyle(.secondary)
      }.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    }
  }
}

@main
struct StashCaptureWidget: Widget {
  var body: some WidgetConfiguration {
    AppIntentConfiguration(kind: "StashCaptureWidget", intent: CaptureConfiguration.self, provider: CaptureProvider()) { entry in
      CaptureWidgetView(entry: entry).containerBackground(.fill.tertiary, for: .widget)
    }.configurationDisplayName("Stash Capture").description("Capture configured text into your encrypted outbox.")
  }
}
