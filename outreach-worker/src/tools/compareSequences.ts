// compareSequences — side-by-side performance for 2-5 sequences over the same window.

import { runTool } from "./_helpers.js";
import { analyzeSequencePerformance } from "./analyzeSequencePerformance.js";
import { isErrorEnvelope, tooManyInputs, validationError } from "../errors/envelopes.js";

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

    const firstError = parsed.find((p) => p.error !== undefined);
    if (firstError !== undefined && isErrorEnvelope(firstError)) return firstError;

    const sequences = parsed.flatMap((p, i) => {
      const sequenceId = ids[i];
      if (sequenceId === undefined) return [];
      return [
        {
          sequenceId,
          sequenceName: p.sequenceName,
          sequenceProfileUrl: p.sequenceProfileUrl,
          totals: p.totals ?? {},
          rates: p.rates ?? {},
        },
      ];
    });

    const winners = {
      bestOpenRate: pickWinner(sequences, "openRate"),
      bestReplyRate: pickWinner(sequences, "replyRate"),
      bestCompletionRate: pickWinner(sequences, "completionRate"),
    };

    return {
      dateRange: parsed[0]?.dateRange,
      sequences,
      winners,
    };
  });
}

function pickWinner(
  sequences: readonly { sequenceId: number; rates: Record<string, number> }[],
  metric: string,
): { sequenceId: number; rate: number } | null {
  let best: { sequenceId: number; rate: number } | null = null;
  for (const s of sequences) {
    const r = s.rates[metric] ?? 0;
    if (best === null || r > best.rate) best = { sequenceId: s.sequenceId, rate: r };
  }
  return best;
}
