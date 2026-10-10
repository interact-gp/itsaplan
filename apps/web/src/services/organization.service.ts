import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSession } from '@/lib/auth-client';
import {
  getOrganizationAccess,
  listOrganizationUsers,
  setOrganizationAccess,
} from '@/lib/api/endpoints/organization';

export function useOrganizationAccessQuery() {
  const { data: session } = useSession();
  return useQuery({
    queryKey: ['organization-access', session?.user.id],
    queryFn: getOrganizationAccess,
    enabled: Boolean(session?.user.id),
  });
}

export const useOrganizationUsersQuery = (enabled: boolean) =>
  useQuery({ queryKey: ['organization-users'], queryFn: listOrganizationUsers, enabled });

export function useSetOrganizationAccess() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: setOrganizationAccess,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['organization-users'] }),
  });
}
