'use client'

import * as React from 'react'
import { useUI } from '@/lib/store'
import { NAV } from '@/lib/nav'
import { cn } from '@/lib/utils'
import { Menu, Moon, Sun, RefreshCw } from 'lucide-react'
import { useTheme } from 'next-themes'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { AppSidebar } from './app-sidebar'

export function AppHeader() {
  const { view, mobileNavOpen, setMobileNav } = useUI()
  const { theme, setTheme } = useTheme()
  const [mounted, setMounted] = React.useState(false)
  React.useEffect(() => setMounted(true), [])

  const current = NAV.find((n) => n.id === view)

  return (
    <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-border/70 bg-background/80 px-4 backdrop-blur-md lg:px-6">
      <Button
        variant="ghost"
        size="icon"
        className="lg:hidden"
        onClick={() => setMobileNav(true)}
        aria-label="Open navigation"
      >
        <Menu className="h-5 w-5" />
      </Button>

      <div className="min-w-0 flex-1">
        <h1 className="truncate text-base font-semibold tracking-tight sm:text-lg">
          {current?.label ?? 'Overview'}
        </h1>
        <p className="hidden truncate text-xs text-muted-foreground sm:block">{current?.desc}</p>
      </div>

      <div className="flex items-center gap-1.5">
        <div className="mr-1 hidden items-center gap-1.5 rounded-md border border-emerald-500/25 bg-emerald-500/10 px-2 py-1 text-xs font-medium text-emerald-600 dark:text-emerald-400 sm:flex">
          <span className="relative flex h-1.5 w-1.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500" />
          </span>
          Live
        </div>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
          aria-label="Toggle theme"
        >
          {mounted && theme === 'dark' ? <Sun className="h-4.5 w-4.5" /> : <Moon className="h-4.5 w-4.5" />}
        </Button>
      </div>

      <Sheet open={mobileNavOpen} onOpenChange={setMobileNav}>
        <SheetContent side="left" className="w-72 p-0">
          <SheetHeader className="sr-only">
            <SheetTitle>Navigation</SheetTitle>
          </SheetHeader>
          <AppSidebar />
        </SheetContent>
      </Sheet>
    </header>
  )
}

export function RefreshButton({ onClick, isFetching }: { onClick: () => void; isFetching?: boolean }) {
  return (
    <Button variant="outline" size="sm" onClick={onClick} disabled={isFetching} className="gap-1.5">
      <RefreshCw className={cn('h-3.5 w-3.5', isFetching && 'animate-spin')} />
      Refresh
    </Button>
  )
}
