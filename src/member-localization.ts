import { normalizeExplicitOffsetTimestamp } from "./explicit-offset-timestamp.js";
import {
  MessageCatalogs,
  type MessageCatalog,
  type MessageKey,
  type MessageParameters,
} from "./localization-catalog.js";

export type { MessageCatalog, MessageKey, MessageParameters } from "./localization-catalog.js";

export type DateFormat = "short" | "medium" | "long";
export type WeekStart = "sunday" | "monday" | "saturday";

export interface MemberLocalizationPreferences {
  locale: string;
  timeZone: string;
  dateFormat: DateFormat;
  weekStartsOn: WeekStart;
  updatedAt: string;
}

export interface MemberLocalizationRepository {
  findMemberLocalizationPreferences(memberId: string): Promise<MemberLocalizationPreferences | undefined>;
  saveMemberLocalizationPreferences(memberId: string, preferences: MemberLocalizationPreferences): Promise<void>;
}

export const defaultMemberLocalizationPreferences: MemberLocalizationPreferences = {
  locale: "en",
  timeZone: "UTC",
  dateFormat: "medium",
  weekStartsOn: "monday",
  updatedAt: "1970-01-01T00:00:00.000Z",
};

export class InvalidLocalizationPreferences extends Error {}
export class InvalidLocalizationRenderRequest extends Error {}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validLocale(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 100) return false;
  try {
    return Intl.getCanonicalLocales(value).length === 1;
  } catch {
    return false;
  }
}

function validTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 100) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

function parsePreferences(value: unknown, updatedAt: string): MemberLocalizationPreferences {
  if (!isPlainObject(value)
    || Object.keys(value).length !== 4
    || !validLocale(value.locale)
    || !validTimeZone(value.timeZone)
    || !["short", "medium", "long"].includes(value.dateFormat as string)
    || !["sunday", "monday", "saturday"].includes(value.weekStartsOn as string)) {
    throw new InvalidLocalizationPreferences();
  }
  return {
    locale: Intl.getCanonicalLocales(value.locale)[0]!,
    timeZone: value.timeZone,
    dateFormat: value.dateFormat as DateFormat,
    weekStartsOn: value.weekStartsOn as WeekStart,
    updatedAt,
  };
}

export class MemberLocalizationService {
  readonly #repository: MemberLocalizationRepository;
  readonly #now: () => Date;
  readonly #messages: MessageCatalogs;

  constructor(
    repository: MemberLocalizationRepository,
    now: () => Date = () => new Date(),
    catalogs: Readonly<Record<string, MessageCatalog>> = {},
  ) {
    this.#repository = repository;
    this.#now = now;
    this.#messages = new MessageCatalogs(catalogs);
  }

  async get(memberId: string): Promise<MemberLocalizationPreferences> {
    return await this.#repository.findMemberLocalizationPreferences(memberId) ?? defaultMemberLocalizationPreferences;
  }

  async update(memberId: string, value: unknown): Promise<MemberLocalizationPreferences> {
    const preferences = parsePreferences(value, this.#now().toISOString());
    await this.#repository.saveMemberLocalizationPreferences(memberId, preferences);
    return preferences;
  }

  formatForLocale(locale: string, key: MessageKey, parameters: MessageParameters = {}): string {
    return this.#messages.format(locale, key, parameters);
  }

  async formatForMember(memberId: string, key: MessageKey, parameters: MessageParameters = {}): Promise<string> {
    return this.formatForLocale((await this.get(memberId)).locale, key, parameters);
  }

  async render(memberId: string, message: string | null, timestamp: string | null) {
    if (message !== "instance.running" || !timestamp) throw new InvalidLocalizationRenderRequest();
    const normalizedTimestamp = normalizeExplicitOffsetTimestamp(timestamp);
    if (!normalizedTimestamp) throw new InvalidLocalizationRenderRequest();
    const instant = new Date(normalizedTimestamp);
    const preferences = await this.get(memberId);
    const localeForDates = preferences.locale.toLowerCase() === "en-xa" ? "en" : preferences.locale;
    return {
      message: this.formatForLocale(preferences.locale, "instance.running"),
      date: new Intl.DateTimeFormat(localeForDates, {
        timeZone: preferences.timeZone,
        dateStyle: preferences.dateFormat,
      }).format(instant),
      timestamp: instant.toISOString(),
      weekStartsOn: preferences.weekStartsOn,
    };
  }
}
