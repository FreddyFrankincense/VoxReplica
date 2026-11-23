import React from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Mic,
  Sparkles,
} from 'lucide-react';
import {
  LearnedCorpusDiagnostic,
  PhonemeCategoryConfidence,
} from '../utils/phonemeCoverage';

interface PhonemeDiagnosticPanelProps {
  diagnostic: LearnedCorpusDiagnostic;
  onPracticeTargetedScript: (script: string, title: string) => void;
}

export const PhonemeDiagnosticPanel: React.FC<PhonemeDiagnosticPanelProps> = ({
  diagnostic,
  onPracticeTargetedScript,
}) => {
  const {
    elementsByLowestConfidence,
    lowestConfidenceElements,
    overallConfidencePercent,
    currentVerifiedSeconds,
    dataFloorSeconds,
  } = diagnostic;

  const primaryDeficit: PhonemeCategoryConfidence | null =
    elementsByLowestConfidence[0] || null;

  return (
    <section
      aria-label="Phoneme and Verbal Element Confidence Diagnostics"
      className="bg-[#111827] border border-slate-800 rounded-xl p-6 space-y-5"
    >
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 pb-4 border-b border-slate-800">
        <div>
          <p className="text-xs font-medium text-amber-400 tracking-wide">
            Speech Coverage & Missing Phoneme Telemetry
          </p>
          <h2 className="text-lg font-semibold text-slate-50 mt-0.5">
            Phoneme & Verbal Element Confidence Matrix (Ordered by Lowest Confidence)
          </h2>
          <p className="text-xs text-slate-400 mt-1 max-w-3xl">
            Identifies which specific phonemes, consonant transients, vowel glides, and prosodic
            inflections have the lowest representation in your submitted audio so you know exactly
            what speech elements the voice model needs more information on.
          </p>
        </div>

        <div className="flex items-center gap-4 shrink-0">
          <div className="text-right">
            <span className="text-xs text-slate-400 block">Overall Phonetic Coverage</span>
            <span className="text-xl font-mono font-semibold text-cyan-400 tabular-nums">
              {overallConfidencePercent}% Confidence
            </span>
          </div>
        </div>
      </div>

      {/* Lowest-Confidence Alert Callout */}
      {primaryDeficit && primaryDeficit.confidencePercent < 80 ? (
        <div className="p-4 rounded-xl bg-slate-900/90 border border-amber-500/40 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <AlertCircle className="w-4 h-4 text-amber-400 shrink-0" />
              <span className="font-semibold text-amber-300">
                Lowest Current Confidence Element: {primaryDeficit.name} (
                {primaryDeficit.confidencePercent}%)
              </span>
              <span className="text-slate-600" aria-hidden="true">·</span>
              <span className="font-mono text-slate-300">{primaryDeficit.ipaExamples}</span>
              <span className="text-slate-600" aria-hidden="true">·</span>
              <span className="text-slate-400">
                {lowestConfidenceElements.length} speech element(s) need more training audio
              </span>
            </div>
            <p className="text-xs text-slate-300 leading-relaxed">
              {primaryDeficit.diagnosticExplanation}
            </p>
            <p className="text-xs text-cyan-300 italic pt-0.5">
              Recommended calibration phrase: “{primaryDeficit.targetedPracticeScript}”
            </p>
          </div>

          <button
            onClick={() =>
              onPracticeTargetedScript(
                primaryDeficit.targetedPracticeScript,
                `Targeted Phoneme Calibration: ${primaryDeficit.name}`
              )
            }
            className="inline-flex items-center gap-2 px-4 py-2.5 text-xs font-semibold text-slate-950 bg-amber-500 hover:bg-amber-400 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Mic className="w-3.5 h-3.5" />
            Record Targeted Phoneme Script
          </button>
        </div>
      ) : (
        <div className="p-4 rounded-xl bg-emerald-950/40 border border-emerald-700/50 flex items-center justify-between gap-4 text-xs text-emerald-200">
          <div className="flex items-center gap-2.5">
            <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
            <span>
              All 6 core phoneme groups and prosodic inflection classes have reached ≥ 80%
              calibration confidence across {currentVerifiedSeconds}s of verified audio (minimum
              floor: {dataFloorSeconds}s).
            </span>
          </div>
        </div>
      )}

      {/* 6-Element Diagnostic Cards Grid (Sorted Lowest Confidence First) */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {elementsByLowestConfidence.map((el, index) => {
          const isCritical = el.status === 'Critical Deficit';
          const isNeedsData = el.status === 'Needs More Data';

          return (
            <div
              key={el.id}
              className={`p-4 rounded-xl border flex flex-col justify-between space-y-3 transition-colors ${
                isCritical
                  ? 'bg-slate-950/90 border-rose-500/40'
                  : isNeedsData
                  ? 'bg-slate-950/80 border-amber-500/35'
                  : 'bg-slate-900/60 border-slate-800'
              }`}
            >
              <div className="space-y-2">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <span className="text-xs text-slate-400">
                      #{index + 1} Lowest · {el.categoryType}
                    </span>
                    <h3 className="text-sm font-semibold text-slate-100 mt-0.5">
                      {el.name}
                    </h3>
                  </div>

                  <span
                    className={`text-sm font-mono font-semibold tabular-nums whitespace-nowrap shrink-0 ${
                      isCritical
                        ? 'text-rose-400'
                        : isNeedsData
                        ? 'text-amber-400'
                        : 'text-emerald-400'
                    }`}
                  >
                    {el.confidencePercent}%
                  </span>
                </div>

                {/* Progress Bar */}
                <div className="w-full h-1.5 bg-slate-900 rounded-full overflow-hidden">
                  <div
                    className={`h-full transition-all duration-200 ${
                      isCritical
                        ? 'bg-rose-500'
                        : isNeedsData
                        ? 'bg-amber-400'
                        : 'bg-emerald-400'
                    }`}
                    style={{ width: `${Math.max(4, el.confidencePercent)}%` }}
                  />
                </div>

                <div className="flex items-center justify-between text-xs font-mono tabular-nums text-slate-400">
                  <span className="truncate">{el.ipaExamples}</span>
                  <span className="shrink-0 ml-2">
                    {el.observedCount}/{el.targetCount} tokens
                  </span>
                </div>

                <p className="text-xs text-slate-300 leading-relaxed">
                  {el.diagnosticExplanation}
                </p>
              </div>

              <div className="pt-3 border-t border-slate-800/80 space-y-2">
                <p className="text-xs text-slate-400 line-clamp-2 italic">
                  Prompt: “{el.targetedPracticeScript}”
                </p>

                <button
                  onClick={() =>
                    onPracticeTargetedScript(
                      el.targetedPracticeScript,
                      `Phoneme Target: ${el.name}`
                    )
                  }
                  className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-medium text-cyan-300 bg-cyan-500/10 hover:bg-cyan-500/20 border border-cyan-500/30 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <Sparkles className="w-3.5 h-3.5" />
                  Load Targeted Prompt into Mic Recorder
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
};
