import React, { useRef, useState } from 'react';
import {
  CheckCircle2,
  Cpu,
  Download,
  Loader2,
  Plus,
  Sparkles,
  Trash2,
  Upload,
} from 'lucide-react';
import {
  ConversationSegment,
  CustomVoiceProfile,
  VoiceAnchorSample,
} from '../types/voice';

interface VocalDnaBuilderProps {
  anchors: VoiceAnchorSample[];
  segments: ConversationSegment[];
  activeProfile: CustomVoiceProfile;
  onUpdateProfile: (updated: CustomVoiceProfile) => void;
  onImportProfile: (imported: CustomVoiceProfile) => void;
  onProceedToStudio: () => void;
}

const FOUNDATION_VOICES: Array<{
  id: 'Puck' | 'Charon' | 'Kore' | 'Fenrir' | 'Zephyr';
  label: string;
  register: string;
}> = [
  { id: 'Charon', label: 'Charon', register: 'Deep, warm, low-mid resonant register (~95–130 Hz)' },
  { id: 'Fenrir', label: 'Fenrir', register: 'Textured, authoritative baritone (~115–145 Hz)' },
  { id: 'Puck', label: 'Puck', register: 'Expressive, natural conversational mid-register (~130–175 Hz)' },
  { id: 'Kore', label: 'Kore', register: 'Poised, articulate upper-mid register (~165–225 Hz)' },
  { id: 'Zephyr', label: 'Zephyr', register: 'Smooth, bright, airy high register (~190–260 Hz)' },
];

export const VocalDnaBuilder: React.FC<VocalDnaBuilderProps> = ({
  anchors,
  segments,
  activeProfile,
  onUpdateProfile,
  onImportProfile,
  onProceedToStudio,
}) => {
  const [isTraining, setIsTraining] = useState<boolean>(false);
  const [statusNotice, setStatusNotice] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [newHabitInput, setNewHabitInput] = useState<string>('');
  const importInputRef = useRef<HTMLInputElement | null>(null);

  const verifiedSegments = segments.filter(
    (s) => s.assignment === 'target_user' && s.includedInCorpus
  );

  const allCorpusMetrics = [
    ...anchors.map((a) => a.dspMetrics),
    ...verifiedSegments.map((s) => s.dspMetrics),
  ];

  const totalVerifiedDurationSec = Number(
    allCorpusMetrics.reduce((acc, m) => acc + m.durationSec, 0).toFixed(1)
  );

  const computedMedianF0 =
    allCorpusMetrics.length > 0
      ? Math.round(
          allCorpusMetrics.reduce((acc, m) => acc + m.medianF0Hz, 0) / allCorpusMetrics.length
        )
      : activeProfile.acousticFingerprint.medianF0Hz;

  const computedF0StdDev =
    allCorpusMetrics.length > 0
      ? Math.round(
          allCorpusMetrics.reduce((acc, m) => acc + m.f0StdDevHz, 0) / allCorpusMetrics.length
        )
      : activeProfile.acousticFingerprint.f0StdDevHz;

  const computedAvgWpm =
    allCorpusMetrics.length > 0
      ? Math.round(
          allCorpusMetrics.reduce((acc, m) => acc + m.estimatedWpm, 0) / allCorpusMetrics.length
        )
      : activeProfile.acousticFingerprint.avgWpm;

  const computedWarmthHz =
    allCorpusMetrics.length > 0
      ? Math.round(
          allCorpusMetrics.reduce((acc, m) => acc + m.spectralCentroidHz, 0) /
            allCorpusMetrics.length
        )
      : activeProfile.acousticFingerprint.spectralWarmthHz;

  const handleTrainCustomProfile = async () => {
    setIsTraining(true);
    setErrorMsg(null);
    setStatusNotice(null);

    try {
      const transcripts = [
        ...anchors.map((a) => a.transcript),
        ...verifiedSegments.map((s) => s.transcript),
      ].filter(Boolean);

      const sampleAudios = [
        ...anchors.slice(0, 1).map((a) => ({
          audioBase64: a.audioBase64,
          mimeType: a.mimeType,
        })),
        ...verifiedSegments.slice(0, 1).map((s) => ({
          audioBase64: s.audioBase64,
          mimeType: s.mimeType,
        })),
      ];

      const acousticSummary = {
        anchorSampleCount: anchors.length,
        isolatedConversationalTurns: verifiedSegments.length,
        totalVerifiedDurationSec,
        medianF0Hz: computedMedianF0,
        f0StdDevHz: computedF0StdDev,
        avgWpm: computedAvgWpm,
        spectralWarmthHz: computedWarmthHz,
      };

      const resp = await fetch('/api/voice/train-profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          profileName: activeProfile.name,
          acousticSummary,
          transcripts,
          sampleAudios,
        }),
      });

      const data = await resp.json();
      if (!resp.ok) {
        throw new Error(data.error || 'Failed to train custom vocal profile.');
      }

      const updated: CustomVoiceProfile = {
        ...activeProfile,
        updatedAt: new Date().toISOString(),
        anchorSampleCount: anchors.length,
        isolatedSegmentCount: verifiedSegments.length,
        totalVerifiedDurationSec,
        acousticFingerprint: {
          medianF0Hz: computedMedianF0,
          f0StdDevHz: computedF0StdDev,
          avgWpm: computedAvgWpm,
          pauseFrequencyPer100Words: Number((computedF0StdDev * 0.28).toFixed(1)),
          spectralWarmthHz: computedWarmthHz,
        },
        timbreClassification: data.timbreClassification || activeProfile.timbreClassification,
        baseFoundationVoice: data.baseFoundationVoice || activeProfile.baseFoundationVoice,
        voiceDesignDirective: data.voiceDesignDirective || activeProfile.voiceDesignDirective,
        signatureHabits:
          Array.isArray(data.signatureHabits) && data.signatureHabits.length > 0
            ? data.signatureHabits
            : activeProfile.signatureHabits,
        dspCalibration: data.dspCalibration || activeProfile.dspCalibration,
      };

      onUpdateProfile(updated);
      setStatusNotice(
        `Custom Voice Profile calibrated from ${anchors.length} solo anchors and ${verifiedSegments.length} isolated conversational turns.`
      );
    } catch (err: any) {
      setErrorMsg(err?.message || 'Error training custom voice profile.');
    } finally {
      setIsTraining(false);
    }
  };

  const handleAddHabit = () => {
    if (!newHabitInput.trim()) return;
    onUpdateProfile({
      ...activeProfile,
      updatedAt: new Date().toISOString(),
      signatureHabits: [...activeProfile.signatureHabits, newHabitInput.trim()],
    });
    setNewHabitInput('');
  };

  const handleRemoveHabit = (index: number) => {
    onUpdateProfile({
      ...activeProfile,
      updatedAt: new Date().toISOString(),
      signatureHabits: activeProfile.signatureHabits.filter((_, idx) => idx !== index),
    });
  };

  const handleExportProfileJson = () => {
    const jsonStr = JSON.stringify(activeProfile, null, 2);
    const blob = new Blob([jsonStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${activeProfile.name.toLowerCase().replace(/\s+/g, '_')}.voxprofile.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleImportProfileJson = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as CustomVoiceProfile;
      if (!parsed.voiceDesignDirective || !parsed.baseFoundationVoice) {
        throw new Error('Invalid .voxprofile.json format.');
      }
      onImportProfile({
        ...parsed,
        id: parsed.id || `profile-${Date.now()}`,
        updatedAt: new Date().toISOString(),
      });
      setStatusNotice(`Imported voice profile "${parsed.name}" successfully.`);
    } catch (err: any) {
      setErrorMsg(err?.message || 'Could not import voice profile JSON.');
    } finally {
      if (importInputRef.current) importInputRef.current.value = '';
    }
  };

  return (
    <div className="space-y-8">
      {/* Stage Header */}
      <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-4 pb-6 border-b border-slate-800">
        <div>
          <p className="text-xs font-medium text-amber-400 tracking-wide">
            Stage 03 · Custom Vocal Model Training & Calibration
          </p>
          <h1 className="text-2xl sm:text-3xl font-semibold text-slate-50 mt-1">
            Vocal DNA Blueprint & Custom Persona Architecture
          </h1>
          <p className="text-sm text-slate-400 mt-2 max-w-3xl">
            Synthesize your isolated voice dataset ({anchors.length} microphone anchors +{' '}
            {verifiedSegments.length} separated conversational turns) with multimodal Gemini 4
            Hydrogen analysis to compile a custom Voice Design Blueprint and Web Audio DSP formant
            calibration.
          </p>
        </div>

        <div className="flex items-center gap-3 shrink-0">
          <button
            onClick={onProceedToStudio}
            className="px-4 py-2.5 text-xs font-semibold text-slate-950 bg-amber-500 hover:bg-amber-400 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            Launch Nuance Synthesis Studio →
          </button>
        </div>
      </div>

      {errorMsg && (
        <div className="p-4 rounded-lg bg-rose-950/60 border border-rose-800/80 text-sm text-rose-200 flex items-center justify-between gap-4">
          <span>{errorMsg}</span>
          <button
            onClick={() => setErrorMsg(null)}
            className="text-xs font-medium text-rose-300 hover:text-white underline cursor-pointer"
          >
            Dismiss
          </button>
        </div>
      )}

      {statusNotice && (
        <div className="p-4 rounded-lg bg-emerald-950/60 border border-emerald-700/70 text-sm text-emerald-200 flex items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
            <span>{statusNotice}</span>
          </div>
          <button
            onClick={() => setStatusNotice(null)}
            className="text-xs font-medium text-emerald-300 hover:text-white underline cursor-pointer"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* 4-Column Acoustic Fingerprint Strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="p-4 rounded-xl bg-[#111827] border border-slate-800">
          <span className="text-xs text-slate-400 block">Verified Clean Corpus</span>
          <span className="text-2xl font-mono font-semibold text-slate-100 tabular-nums mt-1 block">
            {anchors.length + verifiedSegments.length} clips · {totalVerifiedDurationSec}s
          </span>
          <span className="text-xs text-slate-400 mt-1 block">
            {anchors.length} anchors · {verifiedSegments.length} isolated turns
          </span>
        </div>

        <div className="p-4 rounded-xl bg-[#111827] border border-slate-800">
          <span className="text-xs text-slate-400 block">Median Fundamental Pitch (F0)</span>
          <span className="text-2xl font-mono font-semibold text-cyan-400 tabular-nums mt-1 block">
            {computedMedianF0} Hz ± {computedF0StdDev} Hz
          </span>
          <span className="text-xs text-slate-400 mt-1 block">
            {activeProfile.timbreClassification}
          </span>
        </div>

        <div className="p-4 rounded-xl bg-[#111827] border border-slate-800">
          <span className="text-xs text-slate-400 block">Conversational Cadence</span>
          <span className="text-2xl font-mono font-semibold text-amber-400 tabular-nums mt-1 block">
            {computedAvgWpm} WPM
          </span>
          <span className="text-xs text-slate-400 mt-1 block">
            Spectral centroid: {computedWarmthHz} Hz
          </span>
        </div>

        <div className="p-4 rounded-xl bg-[#111827] border border-slate-800 flex flex-col justify-between">
          <span className="text-xs text-slate-400 block">Model Calibration Action</span>
          <button
            onClick={handleTrainCustomProfile}
            disabled={isTraining}
            className="mt-2 w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 text-xs font-semibold text-slate-950 bg-cyan-400 hover:bg-cyan-300 disabled:opacity-50 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            {isTraining ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Calibrating Vocal DNA...
              </>
            ) : (
              <>
                <Sparkles className="w-4 h-4" />
                Train / Re-Calibrate Voice Model
              </>
            )}
          </button>
        </div>
      </div>

      {/* Main 2-Column Blueprint Editor */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-stretch">
        {/* Left 7 cols: Voice Design Persona Directive & Signature Habits */}
        <div className="lg:col-span-7 bg-[#111827] border border-slate-800 rounded-xl p-6 space-y-6">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 border-b border-slate-800">
            <div>
              <h2 className="text-base font-semibold text-slate-100">
                Custom Voice Profile Configuration
              </h2>
              <p className="text-xs text-slate-400 mt-0.5">
                This blueprint compiles directly into <span className="font-mono">gemini-3.8-flash-tts</span>{' '}
                Voice Design metadata during speech generation.
              </p>
            </div>

            <div className="flex items-center gap-2">
              <input
                ref={importInputRef}
                type="file"
                accept=".json"
                onChange={handleImportProfileJson}
                className="hidden"
              />
              <button
                onClick={() => importInputRef.current?.click()}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-300 bg-slate-800 hover:bg-slate-700 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Upload className="w-3.5 h-3.5" />
                Import Profile
              </button>
              <button
                onClick={handleExportProfileJson}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-300 bg-slate-800 hover:bg-slate-700 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Download className="w-3.5 h-3.5" />
                Export .voxprofile.json
              </button>
            </div>
          </div>

          {/* Profile Name & Timbre Classification */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs text-slate-400 mb-1.5">
                Custom Voice Model Name
              </label>
              <input
                type="text"
                value={activeProfile.name}
                onChange={(e) =>
                  onUpdateProfile({ ...activeProfile, name: e.target.value })
                }
                className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-800 text-sm text-slate-100 focus:outline-none focus:border-cyan-500"
              />
            </div>

            <div>
              <label className="block text-xs text-slate-400 mb-1.5">
                Detected Vocal Register Classification
              </label>
              <input
                type="text"
                value={activeProfile.timbreClassification}
                onChange={(e) =>
                  onUpdateProfile({ ...activeProfile, timbreClassification: e.target.value })
                }
                className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-800 text-sm text-slate-100 focus:outline-none focus:border-cyan-500"
              />
            </div>
          </div>

          {/* Voice Design Persona Prompt */}
          <div>
            <label className="block text-xs text-slate-400 mb-1.5">
              Compiled Gemini Voice Design Persona Directive (<span className="font-mono">speechMetadata.style</span>)
            </label>
            <textarea
              rows={4}
              value={activeProfile.voiceDesignDirective}
              onChange={(e) =>
                onUpdateProfile({
                  ...activeProfile,
                  voiceDesignDirective: e.target.value,
                })
              }
              className="w-full p-3.5 rounded-lg bg-slate-950 border border-slate-800 text-sm text-slate-100 leading-relaxed focus:outline-none focus:border-cyan-500"
            />
          </div>

          {/* Learned Signature Vocal & Prosodic Habits */}
          <div className="space-y-3">
            <label className="block text-xs text-slate-400">
              Signature Vocal Nuances & Conversational Habits (Used by Auto-Nuance Annotator)
            </label>

            <div className="space-y-2">
              {activeProfile.signatureHabits.map((habit, idx) => (
                <div
                  key={idx}
                  className="flex items-center justify-between gap-3 px-3.5 py-2.5 rounded-lg bg-slate-900/90 border border-slate-800 text-xs text-slate-200"
                >
                  <span>{habit}</span>
                  <button
                    onClick={() => handleRemoveHabit(idx)}
                    className="text-slate-500 hover:text-rose-400 transition-colors cursor-pointer shrink-0"
                    title="Remove habit"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>

            <div className="flex items-center gap-2">
              <input
                type="text"
                value={newHabitInput}
                onChange={(e) => setNewHabitInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    handleAddHabit();
                  }
                }}
                placeholder="Add a custom vocal habit (e.g., Soft breath before key points)..."
                className="flex-1 px-3 py-2 rounded-lg bg-slate-950 border border-slate-800 text-xs text-slate-100 focus:outline-none focus:border-cyan-500"
              />
              <button
                onClick={handleAddHabit}
                className="inline-flex items-center gap-1 px-3 py-2 text-xs font-medium text-slate-200 bg-slate-800 hover:bg-slate-700 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5" />
                Add Habit
              </button>
            </div>
          </div>
        </div>

        {/* Right 5 cols: Foundation Timber Anchor & Web Audio DSP Calibration */}
        <div className="lg:col-span-5 bg-[#111827] border border-slate-800 rounded-xl p-6 flex flex-col justify-between space-y-6">
          <div className="space-y-4">
            <div>
              <h2 className="text-base font-semibold text-slate-100">
                Acoustic Foundation & DSP Lock
              </h2>
              <p className="text-xs text-slate-400 mt-0.5">
                Selects the closest base neural vocal tract in <span className="font-mono">gemini-3.8-flash-tts</span>{' '}
                and applies fine-grained Web Audio formant and pitch alignment.
              </p>
            </div>

            {/* Foundation Voice Selector */}
            <div className="space-y-2">
              <label className="block text-xs text-slate-400">
                Matched Neural Vocal Tract Foundation
              </label>
              {FOUNDATION_VOICES.map((voice) => {
                const isSelected = activeProfile.baseFoundationVoice === voice.id;
                return (
                  <button
                    key={voice.id}
                    onClick={() =>
                      onUpdateProfile({
                        ...activeProfile,
                        baseFoundationVoice: voice.id,
                      })
                    }
                    className={`w-full text-left p-3 rounded-lg border transition-colors cursor-pointer ${
                      isSelected
                        ? 'bg-slate-800 border-amber-500/70 text-slate-50'
                        : 'bg-slate-900/60 border-slate-800 text-slate-300 hover:border-slate-700'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-semibold">{voice.label}</span>
                      {isSelected && (
                        <span className="text-xs text-amber-400 font-medium">Active Base</span>
                      )}
                    </div>
                    <p className="text-xs text-slate-400 mt-0.5">{voice.register}</p>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Fine DSP Calibration Sliders */}
          <div className="pt-4 border-t border-slate-800 space-y-4">
            <div className="flex items-center gap-2 text-xs font-semibold text-slate-200">
              <Cpu className="w-4 h-4 text-cyan-400" />
              <span>Post-Synthesis Web Audio DSP Calibration</span>
            </div>

            <div>
              <div className="flex justify-between text-xs mb-1">
                <span className="text-slate-400">Fine Pitch Lock Offset</span>
                <span className="font-mono tabular-nums text-cyan-400">
                  {activeProfile.dspCalibration.pitchShiftSemitones > 0 ? '+' : ''}
                  {activeProfile.dspCalibration.pitchShiftSemitones} semitones
                </span>
              </div>
              <input
                type="range"
                min={-3}
                max={3}
                step={0.1}
                value={activeProfile.dspCalibration.pitchShiftSemitones}
                onChange={(e) =>
                  onUpdateProfile({
                    ...activeProfile,
                    dspCalibration: {
                      ...activeProfile.dspCalibration,
                      pitchShiftSemitones: Number(e.target.value),
                    },
                  })
                }
                className="w-full accent-cyan-400 cursor-pointer"
              />
            </div>

            <div>
              <div className="flex justify-between text-xs mb-1">
                <span className="text-slate-400">Baseline Cadence Multiplier</span>
                <span className="font-mono tabular-nums text-amber-400">
                  {activeProfile.dspCalibration.playbackRate.toFixed(2)}x
                </span>
              </div>
              <input
                type="range"
                min={0.88}
                max={1.15}
                step={0.01}
                value={activeProfile.dspCalibration.playbackRate}
                onChange={(e) =>
                  onUpdateProfile({
                    ...activeProfile,
                    dspCalibration: {
                      ...activeProfile.dspCalibration,
                      playbackRate: Number(e.target.value),
                    },
                  })
                }
                className="w-full accent-amber-400 cursor-pointer"
              />
            </div>

            <div>
              <div className="flex justify-between text-xs mb-1">
                <span className="text-slate-400">Chest Resonance / Low-Mid Warmth (240 Hz)</span>
                <span className="font-mono tabular-nums text-emerald-400">
                  {activeProfile.dspCalibration.formantWarmthDb > 0 ? '+' : ''}
                  {activeProfile.dspCalibration.formantWarmthDb} dB
                </span>
              </div>
              <input
                type="range"
                min={-3}
                max={5}
                step={0.5}
                value={activeProfile.dspCalibration.formantWarmthDb}
                onChange={(e) =>
                  onUpdateProfile({
                    ...activeProfile,
                    dspCalibration: {
                      ...activeProfile.dspCalibration,
                      formantWarmthDb: Number(e.target.value),
                    },
                  })
                }
                className="w-full accent-emerald-400 cursor-pointer"
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
