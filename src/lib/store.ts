'use client'

import { create } from 'zustand'

export type ViewId = 'overview' | 'channels' | 'signals' | 'analytics' | 'chart-viewer' | 'ingest' | 'pipeline' | 'data-manager'

type SignalFilters = {
  channelId: string | null
  instrument: string | null
  outcome: string | null
  action: string | null
  category: string | null
  q: string
  page: number
  pageSize: number
  sort: string
  sortDir: 'asc' | 'desc'
}

type UIState = {
  view: ViewId
  selectedSignalId: string | null
  detailOpen: boolean
  selectedChannelId: string | null
  channelDetailOpen: boolean
  mobileNavOpen: boolean
  filters: SignalFilters
  setView: (v: ViewId) => void
  openSignal: (id: string) => void
  closeSignal: () => void
  openChannel: (id: string) => void
  closeChannel: () => void
  setMobileNav: (open: boolean) => void
  setFilter: <K extends keyof SignalFilters>(key: K, value: SignalFilters[K]) => void
  setSort: (column: string, dir: 'asc' | 'desc') => void
  resetFilters: () => void
}

const defaultFilters: SignalFilters = {
  channelId: null,
  instrument: null,
  outcome: null,
  action: null,
  category: null,
  q: '',
  page: 1,
  pageSize: 25,
  sort: 'postedAt',
  sortDir: 'desc',
}

export const useUI = create<UIState>((set) => ({
  view: 'overview',
  selectedSignalId: null,
  detailOpen: false,
  selectedChannelId: null,
  channelDetailOpen: false,
  mobileNavOpen: false,
  filters: defaultFilters,
  setView: (v) => set({ view: v, mobileNavOpen: false }),
  openSignal: (id) => set({ selectedSignalId: id, detailOpen: true }),
  closeSignal: () => set({ detailOpen: false, selectedSignalId: null }),
  openChannel: (id) => set({ selectedChannelId: id, channelDetailOpen: true }),
  closeChannel: () => set({ channelDetailOpen: false, selectedChannelId: null }),
  setMobileNav: (open) => set({ mobileNavOpen: open }),
  setFilter: (key, value) =>
    set((s) => ({ filters: { ...s.filters, [key]: value, page: key === 'page' ? (value as number) : 1 } })),
  setSort: (column, dir) =>
    set((s) => ({ filters: { ...s.filters, sort: column, sortDir: dir, page: 1 } })),
  resetFilters: () => set({ filters: defaultFilters }),
}))
