// Correlate multi-message signals by order ID (magic number).
// Usage: bun scripts/correlate-signals.ts [channelId]
// If no channelId given, runs on all channels.
import { Database } from 'bun:sqlite'
import { resolve } from 'node:path'
import { correlateChannelSignals } from '../mini-services/telegram-collector/correlator'

const DB_DIR = resolve(import.meta.dir, '../db')
const db = new Database(resolve(DB_DIR, 'audit.db'))
db.exec(`ATTACH '${resolve(DB_DIR, 'catalog.db')}' AS catalog;`)

// Patch the correlator's sqlite reference to use our connection
;(globalThis as any).__correlatorDb = db

// Monkey-patch: the correlator imports from @/lib/db which won't resolve in bun scripts.
// Instead, we re-export the functions with our local db.
import { groupByOrderId, extractCorrelatedSignal } from '../mini-services/telegram-collector/correlator'

// Re-implement correlateChannelSignals with local db
function correlateChannelSignalsLocal(channelId: string) {
  const messages = db.prepare(
    "SELECT id, channelId, rawText, postedAt, parseStatus FROM Message WHERE channelId = ? AND parseStatus = 'no_signal' ORDER BY postedAt ASC"
  ).all(channelId) as any[]

  const groups = groupByOrderId(messages)
  let signalsCreated = 0, evaluationsCreated = 0, skipped = 0

  const stmts = {
    insertSignal: db.prepare(
      `INSERT OR IGNORE INTO Signal (id, messageId, channelId, instrument, instrumentType, action, entryPrice, entryLow, entryHigh, isRange, stopLoss, takeProfits, positionSize, leverage, timeframe, confidence, parserVersion, parsedAt, status, notes, dedupHash) VALUES ($id, $messageId, $channelId, $instrument, $instrumentType, $action, $entryPrice, $entryLow, $entryHigh, $isRange, $stopLoss, $takeProfits, $positionSize, $leverage, $timeframe, $confidence, $parserVersion, $parsedAt, $status, $notes, $dedupHash)`
    ),
    insertEvaluation: db.prepare(
      `INSERT OR REPLACE INTO Evaluation (id, signalId, outcome, exitPrice, exitReason, hitTpLevel, maxFavorablePct, maxAdversePct, rMultiple, pnlPercent, durationMinutes, marketDataSource, evaluatedAt) VALUES ($id, $signalId, $outcome, $exitPrice, $exitReason, $hitTpLevel, $maxFavorablePct, $maxAdversePct, $rMultiple, $pnlPercent, $durationMinutes, $marketDataSource, $evaluatedAt)`
    ),
    updateParseStatus: db.prepare("UPDATE Message SET parseStatus = 'parsed' WHERE id = ?"),
    incrementSignalCount: db.prepare("UPDATE catalog.ChannelStats SET signalCount = signalCount + 1, updatedAt = datetime('now') WHERE channelId = ?"),
  }

  // Simple cuid replacement
  let cuidCounter = 0
  const cuid = () => 'cor' + Date.now().toString(36) + (cuidCounter++).toString(36)

  const tx = db.transaction(() => {
    for (const [, group] of groups) {
      const totalMsgs = (group.signalMessage ? 1 : 0) + group.dirubahMessages.length + (group.closeMessage ? 1 : 0) + (group.cancelMessage ? 1 : 0)
      if (totalMsgs < 2) { skipped++; continue }

      const signal = extractCorrelatedSignal(group)
      if (!signal) { skipped++; continue }

      const signalId = cuid()
      const dedupHash = `${channelId}|${signal.postedAt}`
      stmts.insertSignal.run({
        $id: signalId, $messageId: signal.messageId, $channelId: channelId,
        $instrument: signal.instrument, $instrumentType: signal.instrumentType,
        $action: signal.action, $entryPrice: signal.entryPrice,
        $entryLow: null, $entryHigh: null, $isRange: 0,
        $stopLoss: signal.stopLoss, $takeProfits: JSON.stringify(signal.takeProfits),
        $positionSize: null, $leverage: null, $timeframe: null,
        $confidence: 0.6, $parserVersion: 'correlator-v1',
        $parsedAt: new Date().toISOString(), $status: signal.outcome ? 'closed' : 'evaluating',
        $notes: signal.notes, $dedupHash: dedupHash,
      })
      signalsCreated++
      stmts.incrementSignalCount.run(channelId)

      if (group.signalMessage) stmts.updateParseStatus.run(group.signalMessage.id)

      if (signal.outcome && signal.exitPrice !== undefined) {
        stmts.insertEvaluation.run({
          $id: cuid(), $signalId: signalId, $outcome: signal.outcome,
          $exitPrice: signal.exitPrice, $exitReason: 'manual', $hitTpLevel: null,
          $maxFavorablePct: null, $maxAdversePct: null,
          $rMultiple: signal.rMultiple ?? 0, $pnlPercent: signal.pnlPercent ?? 0,
          $durationMinutes: null, $marketDataSource: 'channel-reported',
          $evaluatedAt: new Date().toISOString(),
        })
        evaluationsCreated++
      }
    }
  })
  tx()

  return { groupsFound: groups.size, signalsCreated, evaluationsCreated, skipped }
}

// ── Main ────────────────────────────────────────────────────────────────────
const targetChannelId = process.argv[2]

let channels: { id: string; name: string }[]
if (targetChannelId) {
  channels = db.prepare('SELECT id, name FROM catalog.Channel WHERE id = ?').all(targetChannelId)
} else {
  channels = db.prepare('SELECT id, name FROM catalog.Channel ORDER BY name').all()
}

console.log('🔄 Multi-message signal correlation by order ID (magic number)')
console.log(`   Channels to process: ${channels.length}`)
console.log('')

for (const ch of channels) {
  console.log(`Processing: ${ch.name}`)
  const result = correlateChannelSignalsLocal(ch.id)
  console.log(`  groups found:    ${result.groupsFound}`)
  console.log(`  signals created: ${result.signalsCreated}`)
  console.log(`  evaluations:     ${result.evaluationsCreated} (from channel-reported close messages)`)
  console.log(`  skipped:         ${result.skipped}`)
  console.log('')
}

// Final stats
const totalSignals = (db.prepare('SELECT COUNT(*) as c FROM Signal').get() as { c: number }).c
const totalEvals = (db.prepare('SELECT COUNT(*) as c FROM Evaluation').get() as { c: number }).c
console.log('═══════════════════════════════════════════════════════════════')
console.log(`✅ Correlation complete.`)
console.log(`   Total signals:     ${totalSignals}`)
console.log(`   Total evaluations: ${totalEvals}`)
console.log('═══════════════════════════════════════════════════════════════')

db.close()
