import type { ViewId } from '@/lib/store'
import {
  LayoutDashboard,
  Radio,
  ListChecks,
  BarChart3,
  CandlestickChart,
  Workflow,
  DatabaseZap,
  Radar,
} from 'lucide-react'
import type { ComponentType } from 'react'

export type NavItem = {
  id: ViewId
  label: string
  icon: ComponentType<{ className?: string }>
  desc: string
}

export const NAV: NavItem[] = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard, desc: 'Performance dashboard' },
  { id: 'channels', label: 'Channels', icon: Radio, desc: 'Audited sources' },
  { id: 'signals', label: 'Signals', icon: ListChecks, desc: 'Parsed signal log' },
  { id: 'analytics', label: 'Analytics', icon: BarChart3, desc: 'Deep metrics' },
  { id: 'chart-viewer', label: 'Chart Viewer', icon: CandlestickChart, desc: 'Visual signal inspection' },
  { id: 'ingest', label: 'Ingest', icon: Radar, desc: 'Telegram MTProto collector' },
  { id: 'pipeline', label: 'Pipeline', icon: Workflow, desc: 'Ingestion & parsing' },
  { id: 'data-manager', label: 'Data Manager', icon: DatabaseZap, desc: 'Fetch, export & analyze data' },
]
