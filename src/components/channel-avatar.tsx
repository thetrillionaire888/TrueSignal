'use client'

import { cn } from '@/lib/utils'
import { AVATAR_GRADIENTS } from '@/lib/format'
import { ShieldCheck } from 'lucide-react'

export function ChannelAvatar({
  name,
  color,
  size = 'md',
  className,
}: {
  name: string
  color: string
  size?: 'sm' | 'md' | 'lg'
  className?: string
}) {
  const gradient = AVATAR_GRADIENTS[color] ?? AVATAR_GRADIENTS.slate
  const sizes = {
    sm: 'h-7 w-7 text-[11px]',
    md: 'h-9 w-9 text-sm',
    lg: 'h-12 w-12 text-base',
  }
  const initials = name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase()
  return (
    <div
      className={cn(
        'flex shrink-0 items-center justify-center rounded-lg bg-gradient-to-br font-bold text-white shadow-sm',
        gradient,
        sizes[size],
        className
      )}
    >
      {initials}
    </div>
  )
}

export function VerifiedTick({ className }: { className?: string }) {
  return <ShieldCheck className={cn('h-3.5 w-3.5 text-primary', className)} />
}
