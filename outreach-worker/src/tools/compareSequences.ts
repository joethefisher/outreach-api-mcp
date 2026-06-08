// compareSequences — side-by-side performance for 2-5 sequences over the same window.

import { tooManyInputs, validationError } from "../errors/envelopes.js";

import { runTool } from "./_helpers.js";
import { analyzeSequencePerformance } from "./analyzeSequencePerformance.js";

export interface CompareSequencesInput {
  readonly sequenceIds: readonly number[];
  readonly dateRangeFrom?: string | null;
  readonly dateRangeTo?: string | null;
}

interface SingleAnalysis {
  readonly sequenceName?: string;
  readonly sequenceProfileUrl?: string;
  readonly totals?: Record<string, number>;
  readonly rates?: Record<string, number>;
  readonly dateRange?: { readonly from: string; readonly to: string };
  readonly error?: string;
  readonly message?: string;
}

interface WinnerOrNoData {
  readonly sequenceIds: readonly number[];
  readonly rate: number;
  readonly tied: boolean;
}

export async function compareSequences(input: CompareSequencesInput): Promise<string> {
  return runTool("compareSequences", input, async () => {
    const ids = input.sequenceIds;
    if (ids.length < 2) {
      return validationError("Need at least 2 sequence IDs to compare.", "sequenceIds");
    }
    if (ids.length > 5) return tooManyInputs(5, ids.length);

    const results = await Promise.all(
      ids.map((id) =>
        analyzeSequencePerformance({
          sequenceId: id,
          dateRangeFrom: input.dateRangeFrom ?? null,
          dateRangeTo: input.dateRangeTo ?? null,
        }),
      ),
    );
    const parsed: SingleAnalysis[] = results.map((r) => JSON.parse(r) as SingleAnalysis);

    // COR-06: annotate failed sequences instead of aborting the whole
    // comparison. A notFound / tooLarge on ONE id is information about
    // that id — it doesn't invalidate the others' rates.
    const sequences: {
      sequenceId: number;
      sequenceName: string | undefined;
      sequenceProfileUrl: string | undefined;
      totals: Record<string, number>;
      rates: Record<string, number>;
    }[] = [];
    const failedSequences: { sequenceId: number; error: string; message?: string }[] = [];

    parsed.forEach((p, i) => {
      const sequenceId = ids[i];
      if (sequenceId === undefined) return;
      if (p.error !== undefined) {
        failedSequences.push({
          sequenceId,
          error: p.error,
          ...(p.message !== undefined && { message: p.message }),
        });
        return;
      }
      sequences.push({
        sequenceId,
        sequenceName: p.sequenceName,
        sequenceProfileUrl: p.sequenceProfileUrl,
        totals: p.totals ?? {},
        rates: p.rates ?? {},
      });
    });

    // If literally nothing succeeded, surface the first error envelope —
    // there's nothing to compare. Otherwise continue with what we have.
    if (sequences.length === 0) {
      return parsed[0] ?? validationError("All sequences failed to analyze.");
    }

    const winners = {
      bestOpenRate: pickWinner(sequences, "openRate"),
      bestReplyRate: pickWinner(sequences, "replyRate"),
      bestCompletionRate: pickWinner(sequences, "completionRate"),
    };

    return {
      dateRange: parsed.find((p) => p.dateRange !== undefined)?.dateRange,
      sequences,
      winners,
      ...(failedSequences.length > 0 && { failedSequences }),
    };
  });
}

// COR-06: when the best rate is 0 across all sequences, there's no
// meaningful winner — return null rather than picking the first id as
// a fake "winner at rate: 0". When multiple sequences tie at the best
// rate, surface all of them with `tied: true`.
function pickWinner(
  sequences: readonly { sequenceId: number; rates: Record<string, number> }[],
  metric: string,
): WinnerOrNoData | null {
  let bestRate = 0;
  const winnerIds: number[] = [];
  for (const s of sequences) {
    const r = s.rates[metric] ?? 0;
    if (r > bestRate) {
      bestRate = r;
      winnerIds.length = 0;
      winnerIds.push(s.sequenceId);
    } else if (r === bestRate && r > 0) {
      winnerIds.push(s.sequenceId);
    }
  }
  if (winnerIds.length === 0 || bestRate === 0) return null;
  return { sequenceIds: winnerIds, rate: bestRate, tied: winnerIds.length > 1 };
}
