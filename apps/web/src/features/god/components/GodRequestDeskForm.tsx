'use client';

import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import type { RequestDeskSettings } from '@/lib/api/endpoints/god';
import SettingsCard from '@/components/common/page/SettingsCard';
import EnabledSwitch from '@/components/common/inputs/EnabledSwitch';
import SettingsSection from '@/components/common/page/SettingsSection';
import GodSectionPage from './GodSectionPage';
import { useUpdateRequestDeskSettings } from '../services/god.service';

// The FRND Requests switch: on, every member who may use the app is enrolled in the
// General Requests project.
export default function GodRequestDeskForm({ settings }: { settings: RequestDeskSettings }) {
  const t = useTranslations('god.frndRequests');
  const update = useUpdateRequestDeskSettings();

  async function change(enabled: boolean) {
    try {
      await update.mutateAsync(enabled);
      toast.success(t(enabled ? 'enabled' : 'disabled'));
    } catch {
      // Surfaced through the global error toast.
    }
  }

  return (
    <GodSectionPage slug="frnd-requests">
      <SettingsSection
        title={t('enrolment')}
        description={t('enrolmentHint')}
        action={
          <EnabledSwitch
            checked={settings.enabled}
            onChange={(enabled) => void change(enabled)}
            disabled={update.isPending}
          />
        }
      >
        <SettingsCard className="space-y-2 p-4">
          <p className="text-sm">{t(settings.enabled ? 'on' : 'off')}</p>
          <p className="text-xs text-muted-foreground">{t('privacy')}</p>
        </SettingsCard>
      </SettingsSection>
    </GodSectionPage>
  );
}
