export type MessageTemplate = string | Readonly<Partial<Record<Intl.LDMLPluralRule, string>>>;

// English is the source catalog. Translators can add a catalog with these same
// keys and omit unfinished entries; missing translations safely fall back here.
export const englishCatalog = {
  "instance.running": "This Instance is running.",
  "localization.preferences.updated": "Localization preferences updated for {locale}.",
  "localization.messages.available": {
    one: "{count} message available",
    other: "{count} messages available",
  },
  "error.member_session_required": "A valid Member session is required.",
  "error.localization.method_unsupported": "This localization operation is not supported.",
  "error.localization.preferences_invalid": "Locale, time zone, date format, and week start must be valid.",
  "error.localization.render_invalid": "A supported message and an ISO 8601 timestamp with an offset are required.",
  "error.invalid_json": "Request body must be valid JSON.",
  "error.body_too_large": "Request body exceeds the 64 KiB limit.",
  "error.localization.unavailable": "Localization preferences are temporarily unavailable.",
} as const satisfies Readonly<Record<string, MessageTemplate>>;

export type MessageKey = keyof typeof englishCatalog;
export type MessageCatalog = Readonly<Partial<Record<MessageKey, MessageTemplate>>>;
export type MessageParameters = Readonly<Record<string, string | number>>;

function pseudoLocalizeTemplate(template: string): string {
  const accents: Record<string, string> = {
    a: "à", e: "ë", i: "ï", o: "ô", u: "ü",
    A: "À", E: "Ë", I: "Ï", O: "Ô", U: "Ü",
  };
  return template.split(/(\{[A-Za-z][A-Za-z0-9_]*\})/g)
    .map((part) => part.startsWith("{") ? part : [...part].map((character) => accents[character] ?? character).join(""))
    .join("");
}

function interpolate(template: string, parameters: MessageParameters): string {
  return template.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
    const value = parameters[name];
    return value === undefined ? `{${name}}` : String(value);
  });
}

export class MessageCatalogs {
  readonly #catalogs: Readonly<Record<string, MessageCatalog>>;

  constructor(catalogs: Readonly<Record<string, MessageCatalog>> = {}) {
    this.#catalogs = catalogs;
  }

  format(locale: string, key: MessageKey, parameters: MessageParameters = {}): string {
    const canonical = Intl.getCanonicalLocales(locale)[0] ?? "en";
    const pseudo = canonical.toLowerCase() === "en-xa";
    const language = canonical.split("-")[0]!.toLowerCase();
    const catalog = this.#catalogs[canonical] ?? this.#catalogs[canonical.toLowerCase()] ?? this.#catalogs[language];
    const entry: MessageTemplate = catalog?.[key] ?? englishCatalog[key];
    const selected = typeof entry === "string" ? entry : this.#selectPlural(canonical, entry, parameters.count);
    const template = pseudo ? pseudoLocalizeTemplate(selected) : selected;
    const rendered = interpolate(template, parameters);
    return pseudo ? `[${rendered} !!!]` : rendered;
  }

  #selectPlural(locale: string, entry: Exclude<MessageTemplate, string>, count: string | number | undefined): string {
    if (typeof count !== "number" || !Number.isFinite(count)) return entry.other ?? Object.values(entry)[0] ?? "";
    const rule = new Intl.PluralRules(locale.toLowerCase() === "en-xa" ? "en" : locale).select(count);
    return entry[rule] ?? entry.other ?? Object.values(entry)[0] ?? "";
  }
}
