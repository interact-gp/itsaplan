'use client';
import { useTranslations } from 'next-intl';
import { useTeamRoleOptionsQuery } from '@/services/roles.service';
import type { TeamMember } from '@/lib/api/endpoints/teams';
import { useSetTeamMemberRole } from '@/services/teams.service';

export default function TeamMemberCustomRoleControl({
  teamId,
  member,
  canManage,
}: {
  teamId: number;
  member: TeamMember;
  canManage: boolean;
}) {
  const t = useTranslations('teams.managed');
  const roles = useTeamRoleOptionsQuery(teamId);
  const setRole = useSetTeamMemberRole(teamId);
  if (!canManage)
    return <p className="text-xs">{roles.data?.find((role) => role.id === member.roleId)?.name}</p>;
  return (
    <div>
      <select
        aria-label={t('customRoleFor', { name: member.name })}
        value={member.roleId ?? ''}
        disabled={setRole.isPending}
        onChange={(event) =>
          setRole.mutate({
            userId: member.userId,
            role: 'member',
            roleId: event.target.value ? Number(event.target.value) : null,
          })
        }
      >
        <option value="">{t('defaultMember')}</option>
        {roles.data?.map((role) => (
          <option key={role.id} value={role.id}>
            {role.name}
          </option>
        ))}
      </select>
      {setRole.isError && <p role="alert">{setRole.error.message}</p>}
    </div>
  );
}
