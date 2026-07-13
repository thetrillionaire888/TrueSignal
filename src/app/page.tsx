'use client'

import * as React from 'react'
import { Providers } from '@/components/providers'
import { AppSidebar } from '@/components/app-sidebar'
import { AppHeader } from '@/components/app-header'
import { OverviewView } from '@/components/views/overview-view'
import { ChannelsView } from '@/components/views/channels-view'
import { SignalsView } from '@/components/views/signals-view'
import { AnalyticsView } from '@/components/views/analytics-view'
import { ChartViewerView } from '@/components/views/chart-viewer-view'
import { IngestView } from '@/components/views/ingest-view'
import { PipelineView } from '@/components/views/pipeline-view'
import { DataManagerView } from '@/components/views/data-manager-view'
import { SignalDetailDrawer } from '@/components/signal-detail-drawer'
import { ChannelDetailDrawer } from '@/components/channel-detail-drawer'
import { useUI } from '@/lib/store'
import { Radar, Github, Shield } from 'lucide-react'

function ViewRouter() {
  const view = useUI((s) => s.view)
  switch (view) {
    case 'overview':
      return <OverviewView />
    case 'channels':
      return <ChannelsView />
    case 'signals':
      return <SignalsView />
    case 'analytics':
      return <AnalyticsView />
    case 'chart-viewer':
      return <ChartViewerView />
    case 'ingest':
      return <IngestView />
    case 'pipeline':
      return <PipelineView />
    case 'data-manager':
      return <DataManagerView />
    default:
      return <OverviewView />
  }
}

function Footer() {
  return (
    <footer className="mt-auto border-t border-border/60 bg-card/50 px-4 py-3 lg:px-6">
      <div className="flex flex-col items-center justify-between gap-2 text-xs text-muted-foreground sm:flex-row">
        <div className="flex items-center gap-1.5">
          <Radar className="h-3.5 w-3.5 text-primary" />
          <span className="font-medium text-foreground">TrueSignal</span>
          <span>· Telegram Trading Signal Analytics</span>
        </div>
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1">
            <Shield className="h-3 w-3" />
            MTProto/TDLib audit
          </span>
          <span className="flex items-center gap-1">
            <Github className="h-3 w-3" />
            v1.4.0
          </span>
          <span className="hidden sm:inline">© {new Date().getFullYear()}</span>
        </div>
      </div>
    </footer>
  )
}

export default function Home() {
  return (
    <Providers>
      <div className="flex min-h-screen">
        {/* Sidebar — desktop fixed, mobile in Sheet (handled in header) */}
        <div className="hidden lg:block">
          <div className="sticky top-0 h-screen">
            <AppSidebar />
          </div>
        </div>

        <div className="flex min-w-0 flex-1 flex-col">
          <AppHeader />
          <main className="grid-bg flex-1 px-4 py-5 lg:px-6">
            <ViewRouter />
          </main>
          <Footer />
        </div>
      </div>

      <SignalDetailDrawer />
      <ChannelDetailDrawer />
    </Providers>
  )
}
