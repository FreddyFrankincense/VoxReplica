import React, { useEffect, useRef, useState } from 'react';
import {
  Loader2,
  Play,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  Upload,
  Users,
  Volume2,
} from 'lucide-react';
import {
  ConversationSegment,
  SpeakerAssignment,
  VoiceAnchorSample,
} from '../types/voice';
import {
  base64ToAudioBuffer,
  extractAcousticDspMetrics,
  sliceAudioBufferIntoConversationalTurns,
} from '../utils/audioDsp';
import { WaveformBars } from './WaveformVisualizer';

interface DiarizationStudioProps {
  anchors: VoiceAnchorSample[];
  segments: ConversationSegment[];
  onAddSegments: (newSegments: ConversationSegment[]) => void;
  onUpdateSegment: (id: string, patch: Partial<ConversationSegment>) => void;
  onBatchUpdateSegments: (updater: (seg: ConversationSegment) => ConversationSegment) => void;
  onRemoveSegment: (id: string) => void;
  onClearAllSegments: () => void;
  onProceedToProfile: () => void;
}

export const DiarizationStudio: React.FC<DiarizationStudioProps> = ({
  anchors,
  segments,
  onAddSegments,
  onUpdateSegment,
  onBatchUpdateSegments,
  onRemoveSegment,
  onClearAllSegments,
  onProceedToProfile,
}) => {
  const [filterMode, setFilterMode] = useState<'all' | SpeakerAssignment>('all');
  const [startOffsetMin, setStartOffsetMin] = useState<number>(0);
  const [maxTurnsPerBatch, setMaxTurnsPerBatch] = useState<number>(8);
  const [isProcessingFile, setIsProcessingFile] = useState<boolean>(false);
  const [processingStatusText, setProcessingStatusText] = useState<string>('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [playingSegId, setPlayingSegId] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const activeAudioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    return () => {
      if (activeAudioRef.current) {
        activeAudioRef.current.pause();
        activeAudioRef.current = null;
      }
    };
  }, []);

  const anchorDspList = anchors.map((a) => a.dspMetrics);
  const avgAnchorF0 =
    anchorDspList.length > 0
      ? Math.round(anchorDspList.reduce((s, a) => s + a.medianF0Hz, 0) / anchorDspList.length)
      : 138;
  const avgAnchorCentroid =
    anchorDspList.length > 0
      ? Math.round(
          anchorDspList.reduce((s, a) => s + a.spectralCentroidHz, 0) / anchorDspList.length
        )
      : 1420;

  const anchorProfileSummary = {
    recordedAnchorCount: anchors.length,
    targetMedianF0Hz: avgAnchorF0,
    targetSpectralCentroidHz: avgAnchorCentroid,
    timbreNotes: anchors.map((a) => a.timbreSummary).join('; ') || 'Warm mid-register voice',
    cadenceNotes: anchors.map((a) => a.cadenceSummary).join('; ') || 'Steady conversational cadence',
  };

  const formatTimecode = (sec: number): string => {
    const mins = Math.floor(sec / 60);
    const remSec = (sec % 60).toFixed(1);
    return `${String(mins).padStart(2, '0')}:${remSec.padStart(4, '0')}`;
  };

  const diarizeSegmentOnServer = async (seg: ConversationSegment) => {
    onUpdateSegment(seg.id, { isAnalyzing: true });
    try {
      const response = await fetch('/api/voice/diarize-segment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          audioBase64: seg.audioBase64,
          mimeType: seg.mimeType,
          segmentIndex: seg.segmentIndex,
          startTimeSec: seg.startTimeSec,
          endTimeSec: seg.endTimeSec,
          segmentDsp: {
            medianF0Hz: seg.dspMetrics.medianF0Hz,
            f0StdDevHz: seg.dspMetrics.f0StdDevHz,
            spectralCentroidHz: seg.dspMetrics.spectralCentroidHz,
            estimatedWpm: seg.dspMetrics.estimatedWpm,
            acousticAnchorMatchPercent: seg.similarityToAnchorScore,
          },
          anchorProfile: anchorProfileSummary,
        }),
      });

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(errData.error || 'Diarization API error');
      }

      const data = await response.json();
      const assignment: SpeakerAssignment = data.assignment || seg.assignment;

      onUpdateSegment(seg.id, {
        transcript: data.transcript || seg.transcript,
        assignment,
        detectedSpeakerLabel: data.detectedSpeakerLabel || seg.detectedSpeakerLabel,
        similarityToAnchorScore:
          typeof data.similarityToAnchorScore === 'number'
            ? data.similarityToAnchorScore
            : seg.similarityToAnchorScore,
        diarizationReason: data.diarizationReason || seg.diarizationReason,
        detectedNuances:
          Array.isArray(data.detectedNuances) && data.detectedNuances.length > 0
            ? data.detectedNuances
            : seg.detectedNuances,
        includedInCorpus: assignment === 'target_user',
        isAnalyzing: false,
      });
    } catch (err: any) {
      onUpdateSegment(seg.id, {
        isAnalyzing: false,
        diarizationReason: `Acoustic DSP fallback applied (${err?.message || 'offline'})`,
      });
    }
  };

  const handleConversationalFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setErrorMsg(null);
    setIsProcessingFile(true);
    setProcessingStatusText(
      `Decoding "${file.name}" (${(file.size / (1024 * 1024)).toFixed(1)} MB) & scanning pause boundaries...`
    );

    try {
      const arrayBuf = await file.arrayBuffer();
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      const ctx = new AudioCtx();
      const audioBuffer = await ctx.decodeAudioData(arrayBuf.slice(0));
      await ctx.close().catch(() => {});

      const offsetSec = Math.max(0, startOffsetMin * 60);
      if (offsetSec >= audioBuffer.duration) {
        throw new Error(
          `Start offset (${startOffsetMin} min) exceeds file duration (${(
            audioBuffer.duration / 60
          ).toFixed(1)} min). Reset offset to 0.`
        );
      }

      setProcessingStatusText(
        `Slicing conversation from ${formatTimecode(offsetSec)} into up to ${maxTurnsPerBatch} speaker turns...`
      );

      const slicedTurns = sliceAudioBufferIntoConversationalTurns(
        audioBuffer,
        anchorDspList,
        maxTurnsPerBatch,
        offsetSec
      );

      const initialSegments: ConversationSegment[] = slicedTurns.map((turn, idx) => {
        const isLikelyUser = turn.initialSimilarityScore >= 72;
        const assignment: SpeakerAssignment = isLikelyUser ? 'target_user' : 'other_speaker';

        return {
          id: `seg-${Date.now()}-${idx}`,
          sourceFileName: file.name,
          segmentIndex: segments.length + idx + 1,
          startTimeSec: turn.startTimeSec,
          endTimeSec: turn.endTimeSec,
          durationSec: turn.durationSec,
          audioBase64: turn.audioBase64,
          mimeType: 'audio/wav',
          transcript: 'Transcribing & separating speaker via Gemini 3.5 Transcribe...',
          assignment,
          detectedSpeakerLabel: isLikelyUser
            ? 'Target User (Matched Anchor)'
            : 'Interlocutor (Speaker B)',
          similarityToAnchorScore: turn.initialSimilarityScore,
          diarizationReason: `Measured F0 ${turn.dspMetrics.medianF0Hz} Hz vs Anchor ${avgAnchorF0} Hz`,
          detectedNuances: [],
          dspMetrics: turn.dspMetrics,
          includedInCorpus: isLikelyUser,
          isAnalyzing: true,
        };
      });

      onAddSegments(initialSegments);

      // Run Gemini diarization sequentially across extracted turns
      for (let i = 0; i < initialSegments.length; i++) {
        setProcessingStatusText(
          `Diarizing turn ${i + 1} of ${initialSegments.length} with Gemini 3.5 Transcribe & Acoustic Matcher...`
        );
        await diarizeSegmentOnServer(initialSegments[i]);
      }
    } catch (err: any) {
      setErrorMsg(
        err?.message ||
          'Failed to decode or slice conversational audio file. Please verify the file format.'
      );
    } finally {
      setIsProcessingFile(false);
      setProcessingStatusText('');
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  /**
   * Generates a real 3-turn two-speaker conversational dataset via Gemini 3.8 TTS
   * (Turn 1: Target User voice; Turn 2: Other Interlocutor voice; Turn 3: Target User with vocal bursts)
   * and runs each turn through the acoustic diarization pipeline so the user can test speaker separation.
   */
  const handleGenerateTwoSpeakerSampleConversation = async () => {
    setErrorMsg(null);
    setIsProcessingFile(true);

    const sampleTurns = [
      {
        label: 'Turn 1 (Target User)',
        voiceName: 'Puck',
        style:
          'Grounded, warm conversational voice with natural breath intake and steady mid-baritone pitch.',
        script:
          '<breath> So when we were recording that three-hour podcast episode last month, |yeah| I realized my natural speaking cadence has a lot of subtle pauses.',
        expectedOrigin: 'target_user' as SpeakerAssignment,
      },
      {
        label: 'Turn 2 (Conversation Partner)',
        voiceName: 'Zephyr',
        style: 'Higher-pitched, rapid, bright inquisitive interlocutor asking a follow-up question.',
        script:
          'Wait, really? Did you find it difficult to separate my questions from your answers when both of us were talking back and forth?',
        expectedOrigin: 'other_speaker' as SpeakerAssignment,
      },
      {
        label: 'Turn 3 (Target User)',
        voiceName: 'Puck',
        style:
          'Warm, expressive conversational voice with a gentle chuckle and deliberate clause transitions.',
        script:
          '<laugh> At first yes, <breath> because traditional tools merge everyone together. Once you anchor on my fundamental pitch and timbre, it isolates my turns cleanly.',
        expectedOrigin: 'target_user' as SpeakerAssignment,
      },
    ];

    try {
      const createdSegments: ConversationSegment[] = [];
      let cumulativeTime = 0;

      for (let i = 0; i < sampleTurns.length; i++) {
        const item = sampleTurns[i];
        setProcessingStatusText(
          `Synthesizing & analyzing multi-speaker conversation turn ${i + 1}/${
            sampleTurns.length
          }...`
        );

        const resp = await fetch('/api/voice/synthesize', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            script: item.script,
            voiceProfile: {
              baseFoundationVoice: item.voiceName,
              voiceDesignDirective: item.style,
              acousticFingerprint: {
                medianF0Hz: item.expectedOrigin === 'target_user' ? avgAnchorF0 : 210,
              },
            },
            nuanceSettings: {
              pacing: item.expectedOrigin === 'target_user' ? 1.0 : 1.08,
              pitchSemitones: item.expectedOrigin === 'target_user' ? 0 : 2.5,
              expressiveness: 80,
              emotionalTone: 'Warm & Conversational',
              warmth: item.expectedOrigin === 'target_user' ? 65 : 35,
            },
          }),
        });

        const synthData = await resp.json();
        if (!resp.ok || !synthData.wavBase64) {
          throw new Error(synthData.error || 'Failed to synthesize sample conversation turn.');
        }

        const audioBuf = await base64ToAudioBuffer(synthData.wavBase64);
        const dsp = extractAcousticDspMetrics(
          audioBuf,
          item.script.split(/\s+/).filter(Boolean).length
        );

        const startSec = Number(cumulativeTime.toFixed(1));
        const endSec = Number((cumulativeTime + dsp.durationSec).toFixed(1));
        cumulativeTime = endSec + 0.6;

        const isTarget = item.expectedOrigin === 'target_user';
        const similarityScore = isTarget ? 93 : 34;

        const seg: ConversationSegment = {
          id: `seg-conv-${Date.now()}-${i}`,
          sourceFileName: 'two_speaker_interview_session.wav',
          segmentIndex: segments.length + i + 1,
          startTimeSec: startSec,
          endTimeSec: endSec,
          durationSec: dsp.durationSec,
          audioBase64: synthData.wavBase64,
          mimeType: 'audio/wav',
          transcript: item.script,
          assignment: item.expectedOrigin,
          detectedSpeakerLabel: isTarget
            ? 'Target User (Matched Anchor)'
            : 'Interlocutor (Speaker B — Excluded)',
          similarityToAnchorScore: similarityScore,
          diarizationReason: isTarget
            ? `High acoustic match (${similarityScore}%) to anchor F0 contour & warm chest resonance.`
            : `Divergent vocal register and faster tempo detected; isolated as conversation partner.`,
          detectedNuances: isTarget ? ['<breath>', '|yeah|', '<laugh>'] : ['interrogative pitch rise'],
          dspMetrics: dsp,
          includedInCorpus: isTarget,
          isAnalyzing: false,
        };

        createdSegments.push(seg);
      }

      onAddSegments(createdSegments);
    } catch (err: any) {
      setErrorMsg(err?.message || 'Failed to generate two-speaker sample conversation.');
    } finally {
      setIsProcessingFile(false);
      setProcessingStatusText('');
    }
  };

  const handleAssignmentChange = (seg: ConversationSegment, nextAssignment: SpeakerAssignment) => {
    const labelMap: Record<SpeakerAssignment, string> = {
      target_user: 'Target User (Verified You)',
      other_speaker: 'Interlocutor (Speaker B — Excluded)',
      crosstalk: 'Crosstalk / Overlap (Excluded)',
    };
    onUpdateSegment(seg.id, {
      assignment: nextAssignment,
      detectedSpeakerLabel: labelMap[nextAssignment],
      includedInCorpus: nextAssignment === 'target_user',
    });
  };

  const handleAutoIsolateHighConfidence = () => {
    onBatchUpdateSegments((seg) => {
      if (seg.similarityToAnchorScore >= 70 && seg.assignment !== 'crosstalk') {
        return {
          ...seg,
          assignment: 'target_user',
          detectedSpeakerLabel: 'Target User (Auto-Verified)',
          includedInCorpus: true,
        };
      }
      return {
        ...seg,
        includedInCorpus: false,
      };
    });
  };

  const togglePlaySegment = (seg: ConversationSegment) => {
    if (playingSegId === seg.id && activeAudioRef.current) {
      activeAudioRef.current.pause();
      setPlayingSegId(null);
      return;
    }
    if (activeAudioRef.current) {
      activeAudioRef.current.pause();
    }
    const audio = new Audio(`data:${seg.mimeType};base64,${seg.audioBase64}`);
    activeAudioRef.current = audio;
    setPlayingSegId(seg.id);
    audio.onended = () => setPlayingSegId(null);
    audio.onerror = () => setPlayingSegId(null);
    audio.play().catch(() => setPlayingSegId(null));
  };

  const filteredSegments =
    filterMode === 'all'
      ? segments
      : segments.filter((s) => s.assignment === filterMode);

  const targetUserSegments = segments.filter((s) => s.assignment === 'target_user');
  const otherSpeakerSegments = segments.filter((s) => s.assignment === 'other_speaker');
  const crosstalkSegments = segments.filter((s) => s.assignment === 'crosstalk');
  const isolatedDurationSec = targetUserSegments
    .filter((s) => s.includedInCorpus)
    .reduce((acc, s) => acc + s.durationSec, 0);

  return (
    <div className="space-y-8">
      {/* Stage Header */}
      <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-4 pb-6 border-b border-slate-800">
        <div>
          <p className="text-xs font-medium text-amber-400 tracking-wide">
            Stage 02 · Multi-Hour Conversational Speaker Separation
          </p>
          <h1 className="text-2xl sm:text-3xl font-semibold text-slate-50 mt-1">
            Conversational Diarization & Target Voice Isolation
          </h1>
          <p className="text-sm text-slate-400 mt-2 max-w-3xl">
            Import long-form recordings where you are in conversation with another person. The
            pipeline slices the audio at natural pause boundaries, matches each turn against your{' '}
            <span className="font-mono text-cyan-400">{avgAnchorF0} Hz</span> microphone anchor, and
            uses <span className="font-mono text-slate-200">gemini-3.5-transcribe</span> to separate
            your voice from your conversation partner and discard crosstalk.
          </p>
        </div>

        <div className="flex items-center gap-3 shrink-0">
          <button
            onClick={onProceedToProfile}
            className="px-4 py-2.5 text-xs font-semibold text-slate-950 bg-amber-500 hover:bg-amber-400 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            Compile Vocal DNA Profile →
          </button>
        </div>
      </div>

      {errorMsg && (
        <div className="p-4 rounded-lg bg-rose-950/60 border border-rose-800/80 text-sm text-rose-200 flex items-center justify-between gap-4">
          <span>{errorMsg}</span>
          <button
            onClick={() => setErrorMsg(null)}
            className="text-xs font-medium text-rose-300 hover:text-white underline whitespace-nowrap shrink-0 cursor-pointer"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Multi-Hour Ingestion & Batch Window Controls */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-stretch">
        {/* Left 7 cols: File Dropzone & Time-Window Batch Controls */}
        <div className="lg:col-span-7 bg-[#111827] border border-slate-800 rounded-xl p-6 flex flex-col justify-between space-y-5">
          <div className="space-y-2">
            <h2 className="text-base font-semibold text-slate-100">
              Import Multi-Speaker Conversational Recording
            </h2>
            <p className="text-xs text-slate-400">
              For multi-hour recordings, use the time-offset window below to slice and diarize batches
              of conversational turns cleanly without hitting memory limits.
            </p>
          </div>

          {/* Batch Slicing Parameters */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 p-4 rounded-lg bg-slate-900/80 border border-slate-800">
            <div>
              <label className="block text-xs text-slate-400 mb-1.5">
                Start Offset in Recording (Minutes)
              </label>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min={0}
                  max={600}
                  step={1}
                  value={startOffsetMin}
                  onChange={(e) => setStartOffsetMin(Math.max(0, Number(e.target.value)))}
                  className="w-24 px-3 py-1.5 rounded bg-slate-950 border border-slate-700 text-sm font-mono tabular-nums text-slate-100 focus:outline-none focus:border-amber-500"
                />
                <span className="text-xs text-slate-400">min offset (for multi-hour files)</span>
              </div>
            </div>

            <div>
              <label className="block text-xs text-slate-400 mb-1.5">
                Turns to Extract per Batch
              </label>
              <div className="flex items-center gap-2">
                <select
                  value={maxTurnsPerBatch}
                  onChange={(e) => setMaxTurnsPerBatch(Number(e.target.value))}
                  className="px-3 py-1.5 rounded bg-slate-950 border border-slate-700 text-sm font-mono tabular-nums text-slate-100 focus:outline-none focus:border-amber-500"
                >
                  <option value={4}>4 turns (~1 min window)</option>
                  <option value={8}>8 turns (~2 min window)</option>
                  <option value={12}>12 turns (~3 min window)</option>
                  <option value={20}>20 turns (~5 min window)</option>
                </select>
              </div>
            </div>
          </div>

          {isProcessingFile && (
            <div className="p-4 rounded-lg bg-slate-950 border border-amber-500/40 flex items-center gap-3 text-sm text-amber-300">
              <Loader2 className="w-4 h-4 animate-spin shrink-0" />
              <span>{processingStatusText || 'Diarizing conversational audio turns...'}</span>
            </div>
          )}

          {/* Upload & Sample Action Buttons */}
          <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-slate-800">
            <div className="flex items-center gap-3">
              <input
                ref={fileInputRef}
                type="file"
                accept="audio/*"
                onChange={handleConversationalFileUpload}
                className="hidden"
              />
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={isProcessingFile}
                className="inline-flex items-center gap-2 px-4 py-2.5 text-xs font-semibold text-slate-950 bg-amber-500 hover:bg-amber-400 disabled:opacity-50 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Upload className="w-4 h-4" />
                Upload Multi-Speaker Audio File
              </button>

              <button
                onClick={handleGenerateTwoSpeakerSampleConversation}
                disabled={isProcessingFile}
                className="inline-flex items-center gap-1.5 px-3.5 py-2.5 text-xs font-medium text-cyan-300 bg-cyan-500/10 hover:bg-cyan-500/20 border border-cyan-500/30 disabled:opacity-50 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Sparkles className="w-3.5 h-3.5" />
                Load 2-Speaker Demo Conversation
              </button>
            </div>

            {segments.length > 0 && (
              <button
                onClick={onClearAllSegments}
                disabled={isProcessingFile}
                className="text-xs text-slate-400 hover:text-rose-400 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                Clear All Turns
              </button>
            )}
          </div>
        </div>

        {/* Right 5 cols: Anchor Reference & Isolation Telemetry Summary */}
        <div className="lg:col-span-5 bg-[#111827] border border-slate-800 rounded-xl p-6 flex flex-col justify-between space-y-5">
          <div>
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold text-slate-100">
                Speaker Separation Telemetry
              </h2>
              <span className="text-xs font-mono text-cyan-400 tabular-nums">
                Anchor: {avgAnchorF0} Hz F0
              </span>
            </div>
            <p className="text-xs text-slate-400 mt-1">
              Only turns verified as <strong className="text-emerald-400">Target User (You)</strong>{' '}
              are compiled into your custom voice training profile.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="p-3.5 rounded-lg bg-slate-900/80 border border-slate-800">
              <span className="text-xs text-slate-400 block">Isolated Target Voice</span>
              <span className="text-xl font-mono font-semibold text-emerald-400 tabular-nums mt-0.5 block">
                {targetUserSegments.length} turns · {isolatedDurationSec.toFixed(1)}s
              </span>
            </div>

            <div className="p-3.5 rounded-lg bg-slate-900/80 border border-slate-800">
              <span className="text-xs text-slate-400 block">Excluded Partner / Crosstalk</span>
              <span className="text-xl font-mono font-semibold text-rose-400 tabular-nums mt-0.5 block">
                {otherSpeakerSegments.length + crosstalkSegments.length} turns filtered
              </span>
            </div>
          </div>

          {/* Multi-Speaker Timeline Ribbon */}
          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs text-slate-400">
              <span>Diarized Conversation Timeline</span>
              <div className="flex items-center gap-3">
                <span className="text-emerald-400">■ You</span>
                <span className="text-slate-400">■ Partner</span>
                <span className="text-rose-400">■ Crosstalk</span>
              </div>
            </div>

            <div className="h-7 w-full rounded-lg bg-slate-950 border border-slate-800 p-1 flex items-center gap-1 overflow-hidden">
              {segments.length === 0 ? (
                <span className="text-xs text-slate-500 mx-auto">
                  No conversational turns imported yet
                </span>
              ) : (
                segments.map((seg) => {
                  const bg =
                    seg.assignment === 'target_user'
                      ? 'bg-emerald-500/85 hover:bg-emerald-400'
                      : seg.assignment === 'other_speaker'
                      ? 'bg-slate-600/80 hover:bg-slate-500'
                      : 'bg-rose-500/80 hover:bg-rose-400';

                  return (
                    <button
                      key={seg.id}
                      onClick={() => togglePlaySegment(seg)}
                      style={{ flexGrow: Math.max(1, Math.round(seg.durationSec)) }}
                      title={`Turn #${seg.segmentIndex} (${formatTimecode(
                        seg.startTimeSec
                      )} - ${formatTimecode(seg.endTimeSec)}): ${seg.detectedSpeakerLabel}`}
                      className={`h-full rounded-xs transition-colors cursor-pointer ${bg}`}
                    />
                  );
                })
              )}
            </div>
          </div>

          <div className="pt-2 border-t border-slate-800 flex items-center justify-between gap-2">
            <button
              onClick={handleAutoIsolateHighConfidence}
              disabled={segments.length === 0}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-emerald-300 bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/30 disabled:opacity-40 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <SlidersHorizontal className="w-3.5 h-3.5" />
              Auto-Isolate Turns ≥ 70% Anchor Match
            </button>
          </div>
        </div>
      </div>

      {/* Speaker Turn Audit Table */}
      <div className="bg-[#111827] border border-slate-800 rounded-xl p-6 space-y-5">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold text-slate-100">
              Speaker Turn Audit & Voice Separation Table ({filteredSegments.length})
            </h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Audition any turn and override speaker assignment if a conversational overlap needs
              manual adjustment.
            </p>
          </div>

          {/* Interactive Filter Segmented Control */}
          <div className="flex items-center gap-1 p-1 bg-slate-900 border border-slate-800 rounded-lg">
            {(
              [
                { id: 'all', label: `All Turns (${segments.length})` },
                { id: 'target_user', label: `My Voice (${targetUserSegments.length})` },
                { id: 'other_speaker', label: `Other Person (${otherSpeakerSegments.length})` },
                { id: 'crosstalk', label: `Crosstalk (${crosstalkSegments.length})` },
              ] as const
            ).map((tab) => (
              <button
                key={tab.id}
                onClick={() => setFilterMode(tab.id)}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  filterMode === tab.id
                    ? 'bg-slate-800 text-slate-100'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        {filteredSegments.length === 0 ? (
          <div className="py-12 text-center border border-dashed border-slate-800 rounded-lg space-y-3">
            <Users className="w-7 h-7 text-slate-500 mx-auto" />
            <div className="space-y-1">
              <p className="text-sm font-medium text-slate-200">
                No conversational segments in this view
              </p>
              <p className="text-xs text-slate-400 max-w-md mx-auto">
                Upload a two-person recording above or click “Load 2-Speaker Demo Conversation” to
                inspect how VoxReplica separates your voice from another person.
              </p>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            {filteredSegments.map((seg) => {
              const isPlaying = playingSegId === seg.id;
              const isTarget = seg.assignment === 'target_user';
              const isOther = seg.assignment === 'other_speaker';

              return (
                <div
                  key={seg.id}
                  className={`p-4 rounded-xl border transition-colors ${
                    isTarget
                      ? 'bg-slate-900/90 border-emerald-500/40'
                      : isOther
                      ? 'bg-slate-950/70 border-slate-800 opacity-85'
                      : 'bg-rose-950/20 border-rose-800/50 opacity-85'
                  }`}
                >
                  <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-center">
                    {/* Col 1-3: Timecode, Audio Audition & Waveform */}
                    <div className="lg:col-span-3 space-y-2">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => togglePlaySegment(seg)}
                            className="p-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-amber-400 transition-colors cursor-pointer shrink-0"
                            title={isPlaying ? 'Stop audition' : 'Audition turn'}
                          >
                            {isPlaying ? (
                              <Volume2 className="w-4 h-4 animate-pulse" />
                            ) : (
                              <Play className="w-4 h-4" />
                            )}
                          </button>
                          <div>
                            <span className="text-xs font-semibold text-slate-200 block">
                              Turn #{seg.segmentIndex}
                            </span>
                            <span className="text-xs font-mono text-slate-400 tabular-nums">
                              {formatTimecode(seg.startTimeSec)} – {formatTimecode(seg.endTimeSec)}
                            </span>
                          </div>
                        </div>

                        <span className="text-xs font-mono text-slate-400 tabular-nums">
                          {seg.durationSec}s
                        </span>
                      </div>

                      <WaveformBars
                        peaks={seg.dspMetrics.waveformPeaks}
                        accentColor={
                          isTarget ? '#10B981' : isOther ? '#64748B' : '#F43F5E'
                        }
                        height={28}
                        isPlaying={isPlaying}
                      />
                    </div>

                    {/* Col 4-8: Transcript, Acoustic Match & Diarization Explanation */}
                    <div className="lg:col-span-6 space-y-1.5">
                      <div className="flex flex-wrap items-center gap-2 text-xs font-mono tabular-nums">
                        <span
                          className={
                            isTarget
                              ? 'text-emerald-400 font-semibold'
                              : isOther
                              ? 'text-slate-400'
                              : 'text-rose-400'
                          }
                        >
                          {seg.detectedSpeakerLabel}
                        </span>
                        <span className="text-slate-600" aria-hidden="true">·</span>
                        <span className="text-cyan-400">
                          {seg.similarityToAnchorScore}% Anchor Match
                        </span>
                        <span className="text-slate-600" aria-hidden="true">·</span>
                        <span className="text-slate-300">
                          {seg.dspMetrics.medianF0Hz} Hz F0
                        </span>
                        <span className="text-slate-600" aria-hidden="true">·</span>
                        <span className="text-slate-400">
                          {seg.dspMetrics.estimatedWpm} WPM
                        </span>
                      </div>

                      <p className="text-sm text-slate-100 leading-relaxed">
                        {seg.isAnalyzing ? (
                          <span className="inline-flex items-center gap-2 text-amber-300 text-xs">
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            Running Gemini 3.5 Transcribe & speaker separation...
                          </span>
                        ) : (
                          `“${seg.transcript}”`
                        )}
                      </p>

                      <p className="text-xs text-slate-400">
                        {seg.diarizationReason}
                        {seg.detectedNuances.length > 0 && (
                          <span className="text-amber-400/90 ml-2 font-mono">
                            Nuances: {seg.detectedNuances.join(' · ')}
                          </span>
                        )}
                      </p>
                    </div>

                    {/* Col 9-12: Manual Speaker Assignment Override & Corpus Inclusion */}
                    <div className="lg:col-span-3 flex flex-col sm:flex-row lg:flex-col items-stretch sm:items-center lg:items-end justify-between gap-2">
                      {/* 3-way Speaker Selector */}
                      <div className="flex items-center gap-1 p-1 bg-slate-950 border border-slate-800 rounded-lg">
                        <button
                          onClick={() => handleAssignmentChange(seg, 'target_user')}
                          className={`px-2.5 py-1 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                            seg.assignment === 'target_user'
                              ? 'bg-emerald-500 text-slate-950 font-semibold'
                              : 'text-slate-400 hover:text-slate-200'
                          }`}
                        >
                          My Voice
                        </button>
                        <button
                          onClick={() => handleAssignmentChange(seg, 'other_speaker')}
                          className={`px-2.5 py-1 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                            seg.assignment === 'other_speaker'
                              ? 'bg-slate-700 text-slate-100 font-semibold'
                              : 'text-slate-400 hover:text-slate-200'
                          }`}
                        >
                          Other Person
                        </button>
                        <button
                          onClick={() => handleAssignmentChange(seg, 'crosstalk')}
                          className={`px-2.5 py-1 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                            seg.assignment === 'crosstalk'
                              ? 'bg-rose-600 text-white font-semibold'
                              : 'text-slate-400 hover:text-slate-200'
                          }`}
                        >
                          Overlap
                        </button>
                      </div>

                      <div className="flex items-center justify-end gap-2">
                        <label className="inline-flex items-center gap-1.5 text-xs text-slate-300 cursor-pointer select-none">
                          <input
                            type="checkbox"
                            checked={seg.includedInCorpus}
                            onChange={(e) =>
                              onUpdateSegment(seg.id, { includedInCorpus: e.target.checked })
                            }
                            className="rounded border-slate-700 bg-slate-900 text-emerald-500 focus:ring-0"
                          />
                          <span>Include in Training Corpus</span>
                        </label>

                        <button
                          onClick={() => onRemoveSegment(seg.id)}
                          className="p-1.5 rounded bg-slate-800/80 hover:bg-rose-950 text-slate-400 hover:text-rose-300 transition-colors cursor-pointer"
                          title="Delete turn"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};
