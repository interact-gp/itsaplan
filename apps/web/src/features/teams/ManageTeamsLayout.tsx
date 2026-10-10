'use client';

import { useState, type ReactNode } from 'react';
import { useOrganizationAccessQuery } from '@/services/organization.service';
import { useParams, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { teamPath } from '@/utils/paths';
import { useTeamsQuery } from '@/services/teams.service';
import NewTeamModal from './components/NewTeamModal';
import TeamsPageView from './components/TeamsPageView';
import TeamsRail from './components/TeamsRail';

// The teams the account belongs to, as the rail every team route is opened from.
// The list carries each team's counters, so the section rail beside it shows them
// without a request of its own.
export default function ManageTeamsLayout({ children }: { children: ReactNode }) {
  const t = useTranslations('teams.manage');
  const { data, isPending } = useTeamsQuery();
  const router = useRouter();
  const params = useParams<{ teamId?: string }>();
  const [creating, setCreating] = useState(false);
  const access = useOrganizationAccessQuery();

  const activeId = params.teamId ? Number(params.teamId) : null;

  return (
    <TeamsPageView
      label={t('label')}
      list={
        <TeamsRail
          teams={data ?? []}
          isPending={isPending}
          activeId={activeId}
          onCreate={access.data?.admin ? () => setCreating(true) : undefined}
          canManageAccess={Boolean(access.data?.managed && access.data.admin)}
        />
      }
    >
      {children}

      {creating && (
        <NewTeamModal
          onClose={() => setCreating(false)}
          onCreated={(team) => router.push(teamPath(team.id))}
        />
      )}
    </TeamsPageView>
  );
}
