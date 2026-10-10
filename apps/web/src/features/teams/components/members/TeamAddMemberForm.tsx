'use client';
import { useTranslations } from 'next-intl';
import { useOrganizationAccessQuery } from '@/services/organization.service';
import { useState } from 'react';
import { useAddTeamMember } from '@/services/teams.service';
import { useTeamRoleOptionsQuery } from '@/services/roles.service';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

export default function TeamAddMemberForm({ teamId }: { teamId: number }) {
  const t = useTranslations('teams.managed');
  const [email, setEmail] = useState('');
  const [roleId, setRoleId] = useState('');
  const access = useOrganizationAccessQuery();
  const roles = useTeamRoleOptionsQuery(teamId);
  const add = useAddTeamMember(teamId);
  if (!access.data?.managed) return null;
  return (
    <form
      className="flex flex-wrap gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        add.mutate(
          { email, role: 'member', roleId: roleId ? Number(roleId) : null },
          { onSuccess: () => setEmail('') },
        );
      }}
    >
      <Input
        aria-label={t('teamMemberEmail')}
        type="email"
        value={email}
        onChange={(event) => setEmail(event.target.value)}
        placeholder={t('companyEmail')}
        required
        className="max-w-xs"
      />
      <select
        aria-label={t('customTeamRole')}
        value={roleId}
        onChange={(event) => setRoleId(event.target.value)}
      >
        <option value="">{t('defaultMember')}</option>
        {roles.data?.map((role) => (
          <option key={role.id} value={role.id}>
            {role.name}
          </option>
        ))}
      </select>
      <Button disabled={add.isPending}>{t('addMember')}</Button>
      {add.isError && <p role="alert">{add.error.message}</p>}
      {add.isSuccess && <p role="status">{t('added')}</p>}
    </form>
  );
}
