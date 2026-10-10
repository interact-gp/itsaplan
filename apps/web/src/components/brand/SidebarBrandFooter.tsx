'use client';

import { useState } from 'react';
import ItsAPlanMark from '@/components/brand/ItsAPlanMark';
import ReleaseHistory from '@/features/whats-new/components/ReleaseHistory';
import { useInstanceAdmin } from '@/hooks/useInstanceAdmin';
import { cn } from '@/lib/utils';
import { useAppVersionQuery, useUpdateStatusQuery } from '@/services/updates.service';

export default function SidebarBrandFooter() {
  const { isAdmin } = useInstanceAdmin();

  const { data: appVersion } = useAppVersionQuery();
  const { data: status } = useUpdateStatusQuery(isAdmin);
  const [showUpdates, setShowUpdates] = useState(false);

  const version = appVersion?.version ?? status?.currentVersion;
  // The version to offer, or null when the running one is the newest known.
  const newerVersion = status?.updateAvailable ? status.latestVersion : null;

  const layout =
    'flex w-full items-center gap-2.5 px-2 pt-2 pb-1.5 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0';

  const content = (
    <>
      <ItsAPlanMark className="size-9 shrink-0 text-sidebar-foreground" />
      <div className="grid text-left leading-none group-data-[collapsible=icon]:hidden">
        <span className="text-base font-semibold tracking-tight text-sidebar-foreground">
          It&apos;s a Plan
        </span>
        {newerVersion ? (
          <span className="mt-1 flex items-center gap-1.5 text-[10px] font-medium tracking-wider text-primary uppercase">
            <span className="relative flex size-1.5" aria-hidden>
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-500 opacity-75" />
              <span className="relative inline-flex size-1.5 rounded-full bg-emerald-500" />
            </span>
            {`v${newerVersion} available`}
          </span>
        ) : (
          <span className="mt-1 text-[10px] font-medium tracking-wider text-muted-foreground uppercase">
            {version ? `v${version}` : 'Self-hosted'}
          </span>
        )}
      </div>
    </>
  );

  if (!isAdmin || !status) return <div className={layout}>{content}</div>;

  return (
    <>
      <button
        type="button"
        className={cn(layout, 'rounded-md hover:bg-sidebar-accent')}
        onClick={() => setShowUpdates(true)}
      >
        {content}
      </button>
      {showUpdates && <ReleaseHistory status={status} onClose={() => setShowUpdates(false)} />}
    </>
  );
}
