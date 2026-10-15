'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import type { SlackReminderSettings } from '@/lib/api/endpoints/god';
import SettingsCard from '@/components/common/page/SettingsCard';
import EnabledSwitch from '@/components/common/inputs/EnabledSwitch';
import SettingsSection from '@/components/common/page/SettingsSection';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import GodSectionPage from './GodSectionPage';
import { useSendSlackReminderTest, useUpdateSlackReminderSettings } from '../services/god.service';

export default function SlackRemindersForm({ settings }: { settings: SlackReminderSettings }) {
  const t = useTranslations('god.slackReminders');
  const tCommon = useTranslations('common');
  const update = useUpdateSlackReminderSettings();
  const test = useSendSlackReminderTest();
  const [enabled, setEnabled] = useState(settings.enabled);
  const [cron, setCron] = useState(settings.cron);
  const [timezone, setTimezone] = useState(settings.timezone);

  const dirty =
    enabled !== settings.enabled || cron !== settings.cron || timezone !== settings.timezone;

  async function save() {
    try {
      await update.mutateAsync({ enabled, cron: cron.trim(), timezone: timezone.trim() });
      toast.success(t('saved'));
    } catch {
      // A schedule the server refuses already surfaced through the global error toast.
    }
  }

  async function sendTest() {
    try {
      const result = await test.mutateAsync();
      if (result.status === 'sent') toast.success(t('testSent'));
      else toast.info(t('testNotSent', { outcome: result.outcome }));
    } catch {
      // Surfaced through the global error toast.
    }
  }

  return (
    <GodSectionPage
      slug="slack-reminders"
      actions={
        <>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void sendTest()}
            disabled={!settings.slackConfigured || test.isPending}
          >
            {t('sendTest')}
          </Button>
          <Button size="sm" onClick={() => void save()} disabled={!dirty || update.isPending}>
            {update.isPending ? tCommon('saving') : tCommon('save')}
          </Button>
        </>
      }
    >
      <SettingsSection
        title={t('schedule')}
        description={settings.slackConfigured ? t('scheduleHint') : t('slackMissing')}
        action={
          <EnabledSwitch checked={enabled} onChange={setEnabled} disabled={update.isPending} />
        }
      >
        <SettingsCard className="space-y-6 p-4">
          <div className="space-y-1.5 sm:max-w-md">
            <Label htmlFor="slack-reminders-cron">{t('cron')}</Label>
            <Input
              id="slack-reminders-cron"
              value={cron}
              onChange={(event) => setCron(event.target.value)}
              placeholder="0 9 * * 1-5"
            />
            <p className="text-xs text-muted-foreground">{t('cronHint')}</p>
          </div>
          <div className="space-y-1.5 sm:max-w-md">
            <Label htmlFor="slack-reminders-timezone">{t('timezone')}</Label>
            <Input
              id="slack-reminders-timezone"
              value={timezone}
              onChange={(event) => setTimezone(event.target.value)}
              placeholder="Asia/Kolkata"
            />
          </div>
          <p className="border-t border-border/60 pt-4 text-xs text-muted-foreground">
            {settings.enabled && settings.nextRunAt
              ? t('nextRun', { when: new Date(settings.nextRunAt).toLocaleString() })
              : t('off')}
          </p>
          <p className="text-xs text-muted-foreground">{t('privacy')}</p>
        </SettingsCard>
      </SettingsSection>
    </GodSectionPage>
  );
}
