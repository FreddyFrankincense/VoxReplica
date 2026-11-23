/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';
import {
  AudioWaveform,
  Cpu,
  Mic,
  Sliders,
  Users,
} from 'lucide-react';
import {
  ConversationSegment,
  CustomVoiceProfile,
  StudioStage,
  SynthesisTake,
  VoiceAnchorSample,
} from './types/voice';
import {
  DEFAULT_VOICE_PROFILE,
  loadStudioState,
  saveStoreValue,
} from './utils/storage';
import { VoiceAnchorLab } from './components/VoiceAnchorLab';
import { DiarizationStudio } from './components/DiarizationStudio';
import { VocalDnaBuilder } from './components/VocalDnaBuilder';
import { SynthesisStudio } from './components/SynthesisStudio';
import { LiveProfileAuditionBar } from './components/LiveProfileAuditionBar';
import { PhonemeDiagnosticPanel } from './components/PhonemeDiagnosticPanel';
import { computeLearnedCorpusDiagnostic } from './utils/phonemeCoverage';

export default function App() {
  const [activeStage, setActiveStage] = useState<StudioStage>('anchor');
  const [anchors, setAnchors] = useState<VoiceAnchorSample[]>([]);
  const [segments, setSegments] = useState<ConversationSegment[]>([]);
  const [profiles, setProfiles] = useState<CustomVoiceProfile[]>([DEFAULT_VOICE_PROFILE]);
  const [activeProfileId, setActiveProfileId] = useState<string>(DEFAULT_VOICE_PROFILE.id);
  const [takes, setTakes] = useState<SynthesisTake[]>([]);
  const [isLoaded, setIsLoaded] = useState<boolean>(false);
  const [targetedPhonemeScript, setTargetedPhonemeScript] = useState<string | null>(null);
  const [targetedPhonemeTitle, setTargetedPhonemeTitle] = useState<string | null>(null);

  useEffect(() => {
    loadStudioState().then((state) => {
      setAnchors(state.anchors);
      setSegments(state.segments);
      setProfiles(state.profiles);
      setActiveProfileId(state.activeProfileId);
      setTakes(state.takes);
      setIsLoaded(true);
    });
  }, []);

  useEffect(() => {
    if (!isLoaded) return;
    saveStoreValue('vox_anchors', anchors);
  }, [anchors, isLoaded]);

  useEffect(() => {
    if (!isLoaded) return;
    saveStoreValue('vox_segments', segments);
  }, [segments, isLoaded]);

  useEffect(() => {
    if (!isLoaded) return;
    saveStoreValue('vox_profiles', profiles);
  }, [profiles, isLoaded]);

  useEffect(() => {
    if (!isLoaded) return;
    saveStoreValue('vox_active_profile_id', activeProfileId);
  }, [activeProfileId, isLoaded]);

  useEffect(() => {
    if (!isLoaded) return;
    saveStoreValue('vox_takes', takes);
  }, [takes, isLoaded]);

  const activeProfile =
    profiles.find((p) => p.id === activeProfileId) || profiles[0] || DEFAULT_VOICE_PROFILE;

  const diagnostic = computeLearnedCorpusDiagnostic(anchors, segments, activeProfile);
  const lowestElement = diagnostic.elementsByLowestConfidence[0] || null;

  const handleJumpToAnchorWithScript = (script?: string, title?: string) => {
    if (script) {
      setTargetedPhonemeScript(script);
      setTargetedPhonemeTitle(title || 'Targeted Phoneme Calibration Drill');
    }
    setActiveStage('anchor');
  };

  const handleAddAnchor = (sample: VoiceAnchorSample) => {
    setAnchors((prev) => [sample, ...prev]);
  };

  const handleRemoveAnchor = (id: string) => {
    setAnchors((prev) => prev.filter((a) => a.id !== id));
  };

  const handleAddSegments = (newSegs: ConversationSegment[]) => {
    setSegments((prev) => [...prev, ...newSegs]);
  };

  const handleUpdateSegment = (id: string, patch: Partial<ConversationSegment>) => {
    setSegments((prev) =>
      prev.map((seg) => (seg.id === id ? { ...seg, ...patch } : seg))
    );
  };

  const handleRemoveSegment = (id: string) => {
    setSegments((prev) => prev.filter((seg) => seg.id !== id));
  };

  const handleClearAllSegments = () => {
    setSegments([]);
  };

  const handleUpdateProfile = (updated: CustomVoiceProfile) => {
    setProfiles((prev) =>
      prev.map((p) => (p.id === updated.id ? updated : p))
    );
  };

  const handleImportProfile = (imported: CustomVoiceProfile) => {
    setProfiles((prev) => [imported, ...prev]);
    setActiveProfileId(imported.id);
  };

  const handleAddTake = (take: SynthesisTake) => {
    setTakes((prev) => [take, ...prev]);
  };

  const handleRemoveTake = (id: string) => {
    setTakes((prev) => prev.filter((t) => t.id !== id));
  };

  const verifiedConversationalTurns = segments.filter(
    (s) => s.assignment === 'target_user' && s.includedInCorpus
  );

  return (
    <div className="min-h-screen bg-[#0B0F17] text-slate-100 flex flex-col">
      {/* Strict 3-Zone Top Bar Contract */}
      <header className="flex items-center justify-between gap-8 px-6 py-4 border-b border-slate-800/90 bg-[#0B0F17]/95 sticky top-0 z-30">
        {/* Zone 1: Single text element wordmark */}
        <a
          href="#top"
          onClick={(e) => {
            e.preventDefault();
            setActiveStage('anchor');
          }}
          className="text-lg font-bold tracking-tight text-slate-50 font-display whitespace-nowrap shrink-0"
        >
          VoxReplica Studio
        </a>

        {/* Zone 2: 4 concise single-line text navigation links */}
        <nav className="hidden md:flex items-center gap-6 text-sm font-medium text-slate-400">
          <a
            href="#anchor"
            onClick={(e) => {
              e.preventDefault();
              setActiveStage('anchor');
            }}
            className={`transition-colors whitespace-nowrap shrink-0 ${
              activeStage === 'anchor'
                ? 'text-slate-50 underline underline-offset-8 decoration-cyan-400'
                : 'hover:text-slate-200'
            }`}
          >
            Voice Anchor
          </a>
          <a
            href="#diarizer"
            onClick={(e) => {
              e.preventDefault();
              setActiveStage('diarizer');
            }}
            className={`transition-colors whitespace-nowrap shrink-0 ${
              activeStage === 'diarizer'
                ? 'text-slate-50 underline underline-offset-8 decoration-amber-400'
                : 'hover:text-slate-200'
            }`}
          >
            Speaker Separation
          </a>
          <a
            href="#profile"
            onClick={(e) => {
              e.preventDefault();
              setActiveStage('profile');
            }}
            className={`transition-colors whitespace-nowrap shrink-0 ${
              activeStage === 'profile'
                ? 'text-slate-50 underline underline-offset-8 decoration-amber-400'
                : 'hover:text-slate-200'
            }`}
          >
            Vocal DNA Model
          </a>
          <a
            href="#studio"
            onClick={(e) => {
              e.preventDefault();
              setActiveStage('studio');
            }}
            className={`transition-colors whitespace-nowrap shrink-0 ${
              activeStage === 'studio'
                ? 'text-slate-50 underline underline-offset-8 decoration-amber-400'
                : 'hover:text-slate-200'
            }`}
          >
            Synthesis Studio
          </a>
        </nav>

        {/* Zone 3: 1 primary action */}
        <div className="flex items-center gap-3 shrink-0">
          <button
            onClick={() => setActiveStage('studio')}
            className="px-4 py-2 text-xs font-semibold text-slate-950 bg-amber-500 hover:bg-amber-400 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            Synthesize Audio
          </button>
        </div>
      </header>

      {/* Full-Width Desktop Studio Workspace (270px Sidebar + Main Canvas) */}
      <div className="flex-1 flex flex-col lg:flex-row">
        {/* Left Pipeline Rail */}
        <aside className="w-full lg:w-[270px] shrink-0 border-b lg:border-b-0 lg:border-r border-slate-800/90 bg-[#0E131F] p-5 flex flex-col justify-between gap-6">
          <div className="space-y-6">
            {/* Pipeline Steps Navigation */}
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-slate-400 px-2 mb-2">
                Voice Replication Pipeline
              </p>

              <button
                onClick={() => setActiveStage('anchor')}
                className={`w-full flex items-center justify-between gap-2.5 px-3 py-2.5 rounded-lg text-left text-xs font-medium transition-colors cursor-pointer ${
                  activeStage === 'anchor'
                    ? 'bg-slate-800 text-slate-50 border border-slate-700'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900/60'
                }`}
              >
                <span className="flex items-center gap-2.5 whitespace-nowrap">
                  <Mic className="w-4 h-4 text-cyan-400 shrink-0" />
                  <span>01. Mic Anchor Lab</span>
                </span>
                <span className="font-mono tabular-nums text-slate-400">
                  {anchors.length}
                </span>
              </button>

              <button
                onClick={() => setActiveStage('diarizer')}
                className={`w-full flex items-center justify-between gap-2.5 px-3 py-2.5 rounded-lg text-left text-xs font-medium transition-colors cursor-pointer ${
                  activeStage === 'diarizer'
                    ? 'bg-slate-800 text-slate-50 border border-slate-700'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900/60'
                }`}
              >
                <span className="flex items-center gap-2.5 whitespace-nowrap">
                  <Users className="w-4 h-4 text-amber-400 shrink-0" />
                  <span>02. Speaker Diarizer</span>
                </span>
                <span className="font-mono tabular-nums text-emerald-400">
                  {verifiedConversationalTurns.length}/{segments.length}
                </span>
              </button>

              <button
                onClick={() => setActiveStage('profile')}
                className={`w-full flex items-center justify-between gap-2.5 px-3 py-2.5 rounded-lg text-left text-xs font-medium transition-colors cursor-pointer ${
                  activeStage === 'profile'
                    ? 'bg-slate-800 text-slate-50 border border-slate-700'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900/60'
                }`}
              >
                <span className="flex items-center gap-2.5 whitespace-nowrap">
                  <Cpu className="w-4 h-4 text-cyan-400 shrink-0" />
                  <span>03. Vocal DNA Model</span>
                </span>
                <span className="font-mono tabular-nums text-cyan-400">
                  {diagnostic.liveLearnedProfile.acousticFingerprint.medianF0Hz}Hz
                </span>
              </button>

              <button
                onClick={() => setActiveStage('studio')}
                className={`w-full flex items-center justify-between gap-2.5 px-3 py-2.5 rounded-lg text-left text-xs font-medium transition-colors cursor-pointer ${
                  activeStage === 'studio'
                    ? 'bg-slate-800 text-slate-50 border border-slate-700'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900/60'
                }`}
              >
                <span className="flex items-center gap-2.5 whitespace-nowrap">
                  <Sliders className="w-4 h-4 text-amber-400 shrink-0" />
                  <span>04. Synthesis Studio</span>
                </span>
                <span className="font-mono tabular-nums text-amber-400">
                  {takes.length}
                </span>
              </button>
            </div>

            {/* Active Voice Model Telemetry Summary */}
            <div className="p-4 rounded-xl bg-[#111827] border border-slate-800/90 space-y-3">
              <div className="flex items-center gap-2">
                <AudioWaveform className="w-4 h-4 text-amber-400 shrink-0" />
                <span className="text-xs font-semibold text-slate-200 truncate">
                  {activeProfile.name}
                </span>
              </div>

              <div className="space-y-1.5 text-xs text-slate-400 font-mono tabular-nums">
                <div className="flex justify-between">
                  <span>Learned F0:</span>
                  <span className="text-cyan-400">
                    {diagnostic.liveLearnedProfile.acousticFingerprint.medianF0Hz} Hz
                  </span>
                </div>
                <div className="flex justify-between">
                  <span>Speaking Cadence:</span>
                  <span className="text-amber-400">
                    {diagnostic.liveLearnedProfile.acousticFingerprint.avgWpm} WPM
                  </span>
                </div>
                <div className="flex justify-between">
                  <span>Data Floor Status:</span>
                  <span
                    className={
                      diagnostic.meetsDataFloor ? 'text-emerald-400' : 'text-amber-400'
                    }
                  >
                    {diagnostic.currentVerifiedSeconds}s / {diagnostic.dataFloorSeconds}s
                  </span>
                </div>
                <div className="flex justify-between">
                  <span>Phonetic Coverage:</span>
                  <span className="text-slate-200">
                    {diagnostic.overallConfidencePercent}%
                  </span>
                </div>
              </div>

              {lowestElement && (
                <div className="pt-2.5 border-t border-slate-800 space-y-1.5">
                  <span className="text-xs text-slate-400 block">
                    Lowest Confidence Element:
                  </span>
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-amber-300 font-medium truncate">
                      {lowestElement.name}
                    </span>
                    <span className="font-mono tabular-nums text-rose-400 shrink-0 ml-1">
                      {lowestElement.confidencePercent}%
                    </span>
                  </div>
                  <button
                    onClick={() =>
                      handleJumpToAnchorWithScript(
                        lowestElement.targetedPracticeScript,
                        `Targeted Phoneme Drill: ${lowestElement.name}`
                      )
                    }
                    className="w-full mt-1 px-2.5 py-1.5 text-xs font-medium text-cyan-300 bg-cyan-500/10 hover:bg-cyan-500/20 border border-cyan-500/30 rounded transition-colors whitespace-nowrap truncate cursor-pointer"
                  >
                    Record Missing Phonemes →
                  </button>
                </div>
              )}
            </div>
          </div>

          <div className="pt-4 border-t border-slate-800/80 text-xs text-slate-500">
            <p>Acoustic DSP + Gemini 3.8 Voice Design</p>
          </div>
        </aside>

        {/* Main Stage Viewport */}
        <main className="flex-1 p-6 lg:p-8 max-w-6xl space-y-8">
          {/* Persistent Live Learned Profile Audio Playback & Data Floor Monitor */}
          <LiveProfileAuditionBar
            diagnostic={diagnostic}
            onJumpToAnchorLab={(script) =>
              handleJumpToAnchorWithScript(
                script,
                lowestElement
                  ? `Targeted Phoneme Drill: ${lowestElement.name}`
                  : 'Voice Floor Calibration'
              )
            }
          />

          {activeStage === 'anchor' && (
            <VoiceAnchorLab
              anchors={anchors}
              onAddAnchor={handleAddAnchor}
              onRemoveAnchor={handleRemoveAnchor}
              onProceedToDiarizer={() => setActiveStage('diarizer')}
              targetedPhonemeScript={targetedPhonemeScript}
              targetedPhonemeTitle={targetedPhonemeTitle}
            />
          )}

          {activeStage === 'diarizer' && (
            <DiarizationStudio
              anchors={anchors}
              segments={segments}
              onAddSegments={handleAddSegments}
              onUpdateSegment={handleUpdateSegment}
              onRemoveSegment={handleRemoveSegment}
              onClearAllSegments={handleClearAllSegments}
              onProceedToProfile={() => setActiveStage('profile')}
            />
          )}

          {activeStage === 'profile' && (
            <VocalDnaBuilder
              anchors={anchors}
              segments={segments}
              activeProfile={activeProfile}
              onUpdateProfile={handleUpdateProfile}
              onImportProfile={handleImportProfile}
              onProceedToStudio={() => setActiveStage('studio')}
            />
          )}

          {activeStage === 'studio' && (
            <SynthesisStudio
              activeProfile={activeProfile}
              diagnostic={diagnostic}
              anchors={anchors}
              takes={takes}
              onAddTake={handleAddTake}
              onRemoveTake={handleRemoveTake}
              onJumpToAnchorLab={(script) =>
                handleJumpToAnchorWithScript(
                  script,
                  lowestElement
                    ? `Targeted Phoneme Drill: ${lowestElement.name}`
                    : 'Voice Floor Calibration'
                )
              }
            />
          )}

          {/* Dedicated Section: Lowest Confidence Phonemes & Verbal Elements Diagnostic Matrix */}
          <PhonemeDiagnosticPanel
            diagnostic={diagnostic}
            onPracticeTargetedScript={(script, title) =>
              handleJumpToAnchorWithScript(script, title)
            }
          />
        </main>
      </div>
    </div>
  );
}
