import { useQuery } from '@tanstack/react-query';
import { ApiError } from '@/lib/api/core/client';
import { getPersonalPage } from '@/lib/api/endpoints/personalPage';
import { useSession } from '@/lib/auth-client';
import { qk } from '@/services/queryKeys';

// The signed-in user's "My To-do" page, or null while it has not been provisioned yet.
export function usePersonalPageQuery() {
  const { data: session } = useSession();
  return useQuery({
    queryKey: qk.personalPage,
    queryFn: async () => {
      try {
        return await getPersonalPage();
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    },
    enabled: Boolean(session),
    staleTime: 5 * 60_000,
    // A new member's page is created within about 30 seconds; look again until it is.
    refetchInterval: (query) => (query.state.data === null ? 30_000 : false),
  });
}
