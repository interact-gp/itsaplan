import { useEffect, useState } from 'react';
import { useSession } from '@/lib/auth-client';
import { useOrganizationAccessQuery } from '@/services/organization.service';

export function useInstanceAdmin() {
  const { data: session, isPending: sessionPending } = useSession();
  const access = useOrganizationAccessQuery();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const owner = session?.user.role === 'god';
  const isAdmin =
    mounted &&
    Boolean(session) &&
    Boolean(owner || (!access.isError && access.data?.globalAccess === true));
  const isPending = !mounted || sessionPending || Boolean(session && !owner && access.isPending);
  return { isAdmin, isPending };
}
