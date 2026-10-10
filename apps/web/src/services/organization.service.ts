import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  getOrganizationAccess,
  listOrganizationUsers,
  setOrganizationAccess,
} from '@/lib/api/endpoints/organization';

export const useOrganizationAccessQuery = () =>
  useQuery({ queryKey: ['organization-access'], queryFn: getOrganizationAccess });

export const useOrganizationUsersQuery = (enabled: boolean) =>
  useQuery({ queryKey: ['organization-users'], queryFn: listOrganizationUsers, enabled });

export function useSetOrganizationAccess() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: setOrganizationAccess,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['organization-users'] }),
  });
}
