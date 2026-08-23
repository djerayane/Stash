export interface StashApiClientOptions {
  readonly baseUrl: string;
  readonly fetch?: typeof globalThis.fetch;
}

export class StashApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "StashApiError";
  }
}

export function createStashApiClient(options: StashApiClientOptions) {
  const request = options.fetch ?? globalThis.fetch;
  const baseUrl = options.baseUrl.replace(/\/$/, "");
  return {
    async get<T>(path: string): Promise<T> {
      const response = await request(`${baseUrl}${path}`, { credentials: "include" });
      if (!response.ok) throw new StashApiError(response.status, `Stash request failed with ${response.status}`);
      return response.json() as Promise<T>;
    },
  };
}
