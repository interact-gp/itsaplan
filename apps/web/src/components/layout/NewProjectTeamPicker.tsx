'use client';

import { useQueries } from '@tanstack/react-query';
import { useTeamsQuery } from '@/services/teams.service';
import { getTeam } from '@/lib/api/endpoints/teams';
import { useTranslations } from 'next-intl';
import { qk } from '@/services/queryKeys';

export default function NewProjectTeamPicker({
  value,
  onChange,
}: {
  value?: number;
  onChange: (id: number | undefined) => void;
}) {
  const t = useTranslations('newProject');
  const teams = useTeamsQuery();
  const details = useQueries({
    queries: (teams.data ?? []).map((team) => ({
      queryKey: qk.team(team.id),
      queryFn: () => getTeam(team.id),
    })),
  });
  const permitted = details.flatMap((result) =>
    result.data?.permissions.projects.create ? [result.data] : [],
  );
  return (
    <label className="mb-4 flex flex-col gap-2 text-sm">
      {t('team')}
      <select
        aria-label={t('team')}
        value={value ?? ''}
        onChange={(event) => onChange(event.target.value ? Number(event.target.value) : undefined)}
      >
        <option value="">{t('chooseTeam')}</option>
        {permitted.map((team) => (
          <option key={team.id} value={team.id}>
            {team.name}
          </option>
        ))}
      </select>
      {!teams.isPending && permitted.length === 0 && <p>{t('noTeamAccess')}</p>}
    </label>
  );
}
