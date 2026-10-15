'use client';

import GodSettingsGate from './components/GodSettingsGate';
import SlackRemindersForm from './components/SlackRemindersForm';
import { useSlackReminderSettingsQuery } from './services/god.service';

export default function GodSlackRemindersPage() {
  const query = useSlackReminderSettingsQuery();

  return (
    <GodSettingsGate slug="slack-reminders" data={query.data}>
      {(settings) => <SlackRemindersForm settings={settings} />}
    </GodSettingsGate>
  );
}
