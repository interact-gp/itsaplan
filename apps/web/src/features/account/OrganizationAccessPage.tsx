'use client';
import { useTranslations } from 'next-intl';
import ConfirmDialog from '@/components/common/overlay/ConfirmDialog';
import {
  useOrganizationAccessQuery,
  useOrganizationUsersQuery,
  useSetOrganizationAccess,
} from '@/services/organization.service';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

export default function OrganizationAccessPage() {
  const t = useTranslations('teams.managed');
  const [confirming, setConfirming] = useState(false);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('member');
  const access = useOrganizationAccessQuery();
  const people = useOrganizationUsersQuery(access.data?.managed === true && access.data.admin);
  const save = useSetOrganizationAccess();
  function accessLabel(enabled: boolean, admin: boolean) {
    if (!enabled) return t('noAccess');
    return t(admin ? 'orgAdmin' : 'member');
  }
  if (!access.data) return <p>{t('loading')}</p>;
  if (!access.data.managed || !access.data.admin) return <p>{t('adminOnly')}</p>;
  return (
    <div className="space-y-6 p-6">
      <h1 className="text-xl font-semibold">{t('applicationAccess')}</h1>
      <p>{t('description')}</p>
      <form
        className="flex flex-wrap gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          setConfirming(true);
        }}
      >
        <Input
          aria-label={t('companyEmail')}
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          required
          className="max-w-xs"
        />
        <select
          aria-label={t('applicationRole')}
          value={role}
          onChange={(event) => setRole(event.target.value)}
        >
          <option value="member">{t('member')}</option>
          <option value="admin">{t('orgAdmin')}</option>
          <option value="none">{t('revoke')}</option>
        </select>
        <Button disabled={save.isPending}>{t('apply')}</Button>
      </form>
      {save.isError && <p role="alert">{save.error.message}</p>}
      {save.isSuccess && <p role="status">{t('updated')}</p>}
      <ul className="space-y-2">
        {people.data?.map((person) => (
          <li key={person.id}>
            {person.email} — {accessLabel(person.enabled, person.admin)}
          </li>
        ))}
      </ul>
      {confirming && (
        <ConfirmDialog
          title={t('reviewAccess')}
          confirmLabel={t('apply')}
          onClose={() => setConfirming(false)}
          onConfirm={async () => {
            await save.mutateAsync({ email, role });
            setConfirming(false);
          }}
        >
          <p>
            {t('reviewDescription', {
              email,
              role: role === 'none' ? t('noAccess') : accessLabel(true, role === 'admin'),
            })}
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}
