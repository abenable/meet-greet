import { QueryClient } from '@tanstack/react-query'

export function getContext() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        // The client was constructed with no defaults, so staleTime was 0 and
        // every query refetched on mount and on window focus. Combined with
        // router preloading on hover, a single session generated far more
        // server-function traffic than it needed.
        staleTime: 30_000,
        gcTime: 5 * 60_000,
        refetchOnWindowFocus: false,
        refetchOnMount: false,
        retry: (failureCount, error) => {
          // Don't retry authorization failures — they won't resolve on their own.
          const message = (error as Error | undefined)?.message ?? ''
          if (/unauthorized|forbidden|not verified/i.test(message)) return false
          return failureCount < 2
        },
      },
      mutations: {
        retry: false,
      },
    },
  })

  return {
    queryClient,
  }
}
export default function TanstackQueryProvider() {}
