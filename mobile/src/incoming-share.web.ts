export function useIncomingSharePayloads() {
  return { deliveries: [] as { id: string; payload: { value: string; shareType: string; mimeType?: string } }[],
    acknowledge: (_id: string) => undefined, error: null as Error | null };
}
