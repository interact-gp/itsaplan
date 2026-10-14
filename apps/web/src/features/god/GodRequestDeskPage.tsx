'use client';

import GodSettingsGate from './components/GodSettingsGate';
import GodRequestDeskForm from './components/GodRequestDeskForm';
import { useRequestDeskSettingsQuery } from './services/god.service';

export default function GodRequestDeskPage() {
  const query = useRequestDeskSettingsQuery();

  return (
    <GodSettingsGate slug="frnd-requests" data={query.data}>
      {(settings) => <GodRequestDeskForm settings={settings} />}
    </GodSettingsGate>
  );
}
