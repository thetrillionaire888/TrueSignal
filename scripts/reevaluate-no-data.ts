/**
 * Re-evaluate signals that currently have outcome='no_data'.
 *
 * For each such signal:
 *   1. Fetch fresh bars from Dukascopy (48h window from signal.postedAt)
 *   2. Re-run the evaluator
 *   3. Replace the existing Evaluation row
 *
 * Usage:  bun scripts/reevaluate-no-data.ts
 */
import { sqlite } from "@/lib/db";
import {
  evaluateSignal,
  parseDbDate,
  toDukascopyInstrument,
  saveEvaluation,
  type SignalRow,
} from "../mini-services/telegram-collector/evaluator";
import { fetchBarsCached } from "../mini-services/telegram-collector/bar-cache";

interface NoDataSignal extends SignalRow {}

async function main() {
  // Find all signals with outcome='no_data'
  const signals = sqlite.prepare(`
    SELECT s.id as signalId, s.messageId, s.channelId, s.instrument, s.action,
           s.entryPrice, s.entryLow, s.entryHigh, s.isRange, s.stopLoss,
           s.takeProfits, s.notes, m.postedAt
    FROM Signal s
    JOIN Message m ON s.messageId = m.id
    JOIN Evaluation e ON e.signalId = s.id
    WHERE e.outcome = 'no_data'
    ORDER BY m.postedAt ASC
  `).all() as NoDataSignal[];

  console.log(`\nFound ${signals.length} signal(s) with outcome='no_data'\n`);

  if (signals.length === 0) {
    console.log("Nothing to re-evaluate. ✅");
    return;
  }

  let reevaluated = 0;
  let stillNoData = 0;
  let errors = 0;

  for (const signal of signals) {
    const dukascopyInstrument = toDukascopyInstrument(signal.instrument);
    if (!dukascopyInstrument) {
      console.log(`  ✗ ${signal.signalId} (${signal.instrument}): cannot map to Dukascopy instrument`);
      errors++;
      continue;
    }

    const signalTime = parseDbDate(signal.postedAt);
    if (isNaN(signalTime.getTime())) {
      console.log(`  ✗ ${signal.signalId}: invalid postedAt '${signal.postedAt}'`);
      errors++;
      continue;
    }

    const windowEnd = new Date(signalTime.getTime() + 48 * 3600 * 1000);
    console.log(`  → ${signal.signalId} (${signal.instrument}, posted ${signal.postedAt})`);
    console.log(`    window: ${signalTime.toISOString()} → ${windowEnd.toISOString()}`);

    // Fetch bars with forceRefresh=true to bypass cache-hit optimization.
    // The cache may have partial data from a previous (failed) fetch attempt;
    // we want to always try Dukascopy again to pick up newly-available bars.
    try {
      const { bars, stats } = await fetchBarsCached(
        dukascopyInstrument,
        "m15",
        signalTime,
        windowEnd,
        (msg) => console.log(`      ${msg}`),
        true // forceRefresh
      );
      console.log(`    bars: ${bars.length} (${stats.cached} cached / ${stats.fetched} fetched)`);

      if (bars.length === 0) {
        console.log(`    ⚠ still no bars in window — will remain 'no_data'\n`);
        stillNoData++;
        // Don't re-save — the existing 'no_data' eval is still correct
        continue;
      }

      // Delete old evaluation
      sqlite.prepare("DELETE FROM Evaluation WHERE signalId = ?").run(signal.signalId);

      // Re-evaluate
      const result = evaluateSignal(signal, bars);
      saveEvaluation(result);

      console.log(`    ✅ re-evaluated → ${result.outcome} (R=${result.rMultiple}, exit=${result.exitPrice}, reason=${result.exitReason})\n`);
      reevaluated++;
    } catch (e) {
      console.log(`    ✗ error: ${e instanceof Error ? e.message : String(e)}\n`);
      errors++;
    }
  }

  console.log("─".repeat(60));
  console.log(`Re-evaluated: ${reevaluated}`);
  console.log(`Still no_data: ${stillNoData}`);
  console.log(`Errors:       ${errors}`);
  console.log();
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
