'use client';

import { type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { useInstanceAdmin } from '@/hooks/useInstanceAdmin';
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar';
import { Separator } from '@/components/ui/separator';
import { ThemeToggle } from '@/components/theme-toggle';
import { LocaleToggle } from '@/components/locale-toggle';
import SectionPageSkeleton from '@/components/common/skeleton/SectionPageSkeleton';
import UserMenu from '@/components/layout/UserMenu';
import GodSidebar from '@/components/layout/GodSidebar';

export default function GodShell({
  defaultSidebarOpen,
  children,
}: {
  defaultSidebarOpen: boolean;
  children: ReactNode;
}) {
  const t = useTranslations('nav');
  const { isAdmin, isPending } = useInstanceAdmin();

  return (
    <SidebarProvider defaultOpen={defaultSidebarOpen} className="h-svh overflow-hidden">
      <GodSidebar />
      <SidebarInset className="min-w-0">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b px-2 sm:px-4">
          <SidebarTrigger />
          <Separator orientation="vertical" className="mr-1 h-4" />
          <div className="min-w-0 truncate text-sm font-medium">{t('godMode')}</div>
          <div className="ml-auto flex items-center gap-2">
            <LocaleToggle />
            <ThemeToggle />
            <UserMenu />
          </div>
        </header>

        <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
          {isAdmin && children}
          {!isAdmin && !isPending && (
            <div className="flex h-full items-center justify-center px-4 text-center text-sm text-muted-foreground">
              {t('godModeAdminOnly')}
            </div>
          )}
          {!isAdmin && isPending && <SectionPageSkeleton />}
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
