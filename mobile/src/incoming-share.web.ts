export function useIncomingSharePayloads() {
  return { sharedPayloads: [] as { value: string; shareType: string; mimeType?: string }[],
    clearSharedPayloads: () => undefined, error: null as Error | null };
}
