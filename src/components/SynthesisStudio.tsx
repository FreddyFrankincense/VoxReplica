import React, { useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Download,
  FileAudio,
  Layers,
  ListPlus,
  Loader2,
  Play,
  PlayCircle,
  RotateCcw,
  Scissors,
  Sparkles,
  Split,
  Trash2,
  Volume2,
  Wand2,
} from 'lucide-react';
import {
  BatchQueueTask,
  CustomVoiceProfile,
  EmotionalTonePreset,
  NuanceSettings,
  SynthesisTake,
  VoiceAnchorSample,
} from '../types/voice';
import {
  applyVocalDspCalibrationToWav,
  base64ToAudioBuffer,
  downloadWavFile,
  exportWavAtSampleRate,
  extractAcousticDspMetrics,
  stitchTakesToMasterWav,
} from '../utils/audioDsp';
import { WaveformBars } from './WaveformVisualizer';
import { WaveformTrimEditor } from './WaveformTrimEditor';
import { LearnedCorpusDiagnostic } from '../utils/phonemeCoverage';

interface SynthesisStudioProps {
  activeProfile: CustomVoiceProfile;
  diagnostic: LearnedCorpusDiagnostic;
  anchors: VoiceAnchorSample[];
  takes: SynthesisTake[];
  onAddTake: (take: SynthesisTake) => void;
  onUpdateTake: (id: string, patch: Partial<SynthesisTake>) => void;
  onRemoveTake: (id: string) => void;
  onJumpToAnchorLab: (targetedScript?: string) => void;
}

const EMOTIONAL_TONES: EmotionalTonePreset[] = [
  'Natural Baseline',
  'Warm & Conversational',
  'Authoritative & Crisp',
  'Enthusiastic & Bright',
  'Reflective & Intimate',
  'Urgent & Focused',
];

const INLINE_NUANCE_TOKENS = [
  { token: '<breath>', label: '<breath>', desc: 'Natural intake of breath' },
  { token: '<laugh>', label: '<laugh>', desc: 'Warm chuckle or laugh' },
  { token: '<gasp>', label: '<gasp>', desc: 'Quick surprised intake' },
  { token: '|yeah|', label: '|yeah|', desc: 'Conversational affirmation' },
  { token: '|mhm|', label: '|mhm|', desc: 'Thoughtful backchannel' },
  { token: ' ... ', label: 'Pause (...)', desc: 'Natural prosodic pause' },
];

const SAMPLE_SCRIPTS = [
  {
    label: 'Podcast Intro with Breath & Backchannel',
    text: '<breath> Welcome back everyone. |yeah| Today I want to share something we have been building behind the scenes... a voice synthesis pipeline calibrated directly from my own recorded conversations.',
  },
  {
    label: 'Expressive Storytelling with Chuckle',
    text: '<laugh> Honestly, when I first listened back to three hours of our raw interview tape, <breath> I had no idea how often I pause right before making a key point.',
  },
  {
    label: 'Technical & Articulate Explanation',
    text: 'By anchoring speaker diarization on fundamental pitch contour and spectral warmth, <breath> we can isolate a single voice from multi-speaker dialogue and replicate its micro-inflections.',
  },
];

export const SynthesisStudio: React.FC<SynthesisStudioProps> = ({
  activeProfile,
  diagnostic,
  anchors,
  takes,
  onAddTake,
  onUpdateTake,
  onRemoveTake,
  onJumpToAnchorLab,
}) => {
  const [scriptText, setScriptText] = useState<string>(SAMPLE_SCRIPTS[0].text);
  const [nuance, setNuance] = useState<NuanceSettings>({
    pacing: 1.0,
    pitchSemitones: 0,
    expressiveness: 80,
    emotionalTone: 'Warm & Conversational',
    warmth: 65,
    applyDspCalibration: true,
  });

  const [isAnnotating, setIsAnnotating] = useState<boolean>(false);
  const [isSynthesizing, setIsSynthesizing] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [exportStatusMsg, setExportStatusMsg] = useState<string | null>(null);
  const [playingTakeId, setPlayingTakeId] = useState<string | null>(null);
  const [playingAnchorCompare, setPlayingAnchorCompare] = useState<boolean>(false);
  const [editingTrimTakeId, setEditingTrimTakeId] = useState<string | null>(
    takes[0]?.id || null
  );

  // Local WAV Export Settings
  const [exportSampleRate, setExportSampleRate] = useState<24000 | 44100 | 48000>(44100);
  const [exportFilePrefix, setExportFilePrefix] = useState<string>('voxreplica_take');
  const [stitchSilenceGapSec, setStitchSilenceGapSec] = useState<number>(0.8);
  const [exportingTakeId, setExportingTakeId] = useState<string | null>(null);
  const [isExportingBatch, setIsExportingBatch] = useState<boolean>(false);

  // Multi-Task Batch Processing Queue State
  const [batchQueue, setBatchQueue] = useState<BatchQueueTask[]>([
    {
      id: 'batch-seed-1',
      label: 'Batch Task 01 · Podcast Intro',
      script: SAMPLE_SCRIPTS[0].text,
      nuanceSettings: {
        pacing: 1.0,
        pitchSemitones: 0,
        expressiveness: 80,
        emotionalTone: 'Warm & Conversational',
        warmth: 65,
        applyDspCalibration: true,
      },
      status: 'queued',
      createdAt: new Date().toISOString(),
    },
    {
      id: 'batch-seed-2',
      label: 'Batch Task 02 · Expressive Reflection',
      script: SAMPLE_SCRIPTS[1].text,
      nuanceSettings: {
        pacing: 0.96,
        pitchSemitones: -0.4,
        expressiveness: 85,
        emotionalTone: 'Reflective & Intimate',
        warmth: 75,
        applyDspCalibration: true,
      },
      status: 'queued',
      createdAt: new Date().toISOString(),
    },
  ]);
  const [isRunningBatchQueue, setIsRunningBatchQueue] = useState<boolean>(false);
  const [batchProgressText, setBatchProgressText] = useState<string | null>(null);
  const [takeSourceFilter, setTakeSourceFilter] = useState<'all' | 'batch' | 'single'>('all');

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const activeAudioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    return () => {
      if (activeAudioRef.current) {
        activeAudioRef.current.pause();
        activeAudioRef.current = null;
      }
    };
  }, []);

  const insertTokenAtCursor = (token: string) => {
    const el = textareaRef.current;
    if (!el) {
      setScriptText((prev) => `${prev} ${token}`);
      return;
    }
    const start = el.selectionStart ?? scriptText.length;
    const end = el.selectionEnd ?? scriptText.length;
    const before = scriptText.slice(0, start);
    const after = scriptText.slice(end);
    const needsLeadingSpace = before.length > 0 && !before.endsWith(' ') && !before.endsWith('\n');
    const needsTrailingSpace = after.length > 0 && !after.startsWith(' ');
    const inserted = `${needsLeadingSpace ? ' ' : ''}${token}${needsTrailingSpace ? ' ' : ''}`;
    const updated = `${before}${inserted}${after}`;
    setScriptText(updated);

    requestAnimationFrame(() => {
      el.focus();
      const nextPos = start + inserted.length;
      el.setSelectionRange(nextPos, nextPos);
    });
  };

  const handleAutoAnnotateNuances = async () => {
    if (!scriptText.trim()) return;
    setIsAnnotating(true);
    setErrorMsg(null);

    try {
      const resp = await fetch('/api/voice/annotate-script', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: scriptText,
          voiceProfile: activeProfile,
          emotionalTone: nuance.emotionalTone,
        }),
      });
      const data = await resp.json();
      if (!resp.ok) {
        throw new Error(data.error || 'Failed to annotate script with vocal nuances.');
      }
      if (data.annotatedScript) {
        setScriptText(data.annotatedScript);
      }
    } catch (err: any) {
      setErrorMsg(err?.message || 'Could not auto-inject nuance markup.');
    } finally {
      setIsAnnotating(false);
    }
  };

  const validateDataFloorBeforeSynthesis = (): boolean => {
    if (!diagnostic.meetsDataFloor) {
      const lowest = diagnostic.lowestConfidenceElements[0];
      setErrorMsg(
        `Insufficient Voice Profile Data: You currently have ${diagnostic.currentVerifiedSeconds}s of verified audio across ${diagnostic.verifiedClipCount} clip(s), which is below the ${diagnostic.dataFloorSeconds.toFixed(
          1
        )}s minimum data floor (need ${diagnostic.secondsShortfall}s more audio).${
          lowest
            ? ` Lowest confidence element: ${lowest.name} (${lowest.confidencePercent}%).`
            : ''
        } Please record or verify at least ${diagnostic.dataFloorSeconds.toFixed(
          1
        )}s of your voice in the Anchor Lab or Speaker Diarizer first.`
      );
      return false;
    }
    return true;
  };

  const executeSingleTaskSynthesis = async (
    taskScript: string,
    taskNuance: NuanceSettings,
    batchTaskLabel?: string
  ): Promise<SynthesisTake> => {
    const effectiveProfile = diagnostic.liveLearnedProfile || activeProfile;

    const resp = await fetch('/api/voice/synthesize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        script: taskScript,
        voiceProfile: effectiveProfile,
        nuanceSettings: taskNuance,
      }),
    });

    const data = await resp.json();
    if (!resp.ok || !data.wavBase64) {
      throw new Error(data.error || 'Voice synthesis failed.');
    }

    let finalWavBase64 = data.wavBase64;
    let durationSec = 0;
    let waveformPeaks: number[] = [];

    if (taskNuance.applyDspCalibration) {
      const totalPitch =
        Number(effectiveProfile.dspCalibration.pitchShiftSemitones || 0) +
        Number(taskNuance.pitchSemitones || 0);
      const totalRate =
        Number(effectiveProfile.dspCalibration.playbackRate || 1.0) *
        Number(taskNuance.pacing || 1.0);
      const warmthOffsetDb =
        Number(effectiveProfile.dspCalibration.formantWarmthDb || 0) +
        ((taskNuance.warmth - 50) / 50) * 3.0;

      const calibrated = await applyVocalDspCalibrationToWav(data.wavBase64, {
        pitchSemitones: totalPitch,
        playbackRate: totalRate,
        formantWarmthDb: warmthOffsetDb,
      });
      finalWavBase64 = calibrated.calibratedWavBase64;
      durationSec = calibrated.durationSec;
      waveformPeaks = calibrated.waveformPeaks;
    } else {
      const buf = await base64ToAudioBuffer(data.wavBase64);
      const metrics = extractAcousticDspMetrics(buf);
      durationSec = metrics.durationSec;
      waveformPeaks = metrics.waveformPeaks;
    }

    const newTake: SynthesisTake = {
      id: `take-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      profileId: activeProfile.id,
      profileName: activeProfile.name,
      rawScript: taskScript,
      compiledStyle: data.compiledStyle,
      foundationVoiceUsed: data.foundationVoiceUsed || activeProfile.baseFoundationVoice,
      nuanceSettings: { ...taskNuance },
      rawWavBase64: data.wavBase64,
      calibratedWavBase64: finalWavBase64,
      originalCalibratedWavBase64: finalWavBase64,
      originalRawWavBase64: data.wavBase64,
      originalDurationSec: durationSec,
      durationSec,
      waveformPeaks,
      batchTaskLabel,
      createdAt: new Date().toISOString(),
    };

    return newTake;
  };

  const handleSynthesizeSpeech = async () => {
    if (!scriptText.trim()) {
      setErrorMsg('Please enter text to convert into speech.');
      return;
    }

    if (!validateDataFloorBeforeSynthesis()) {
      return;
    }

    setIsSynthesizing(true);
    setErrorMsg(null);

    try {
      const newTake = await executeSingleTaskSynthesis(scriptText, nuance);
      onAddTake(newTake);
      setEditingTrimTakeId(newTake.id);
      playTakeAudio(newTake);
    } catch (err: any) {
      setErrorMsg(err?.message || 'Error generating speech audio.');
    } finally {
      setIsSynthesizing(false);
    }
  };

  const handleEnqueueCurrentScript = () => {
    const trimmed = scriptText.trim();
    if (!trimmed) {
      setErrorMsg('Enter a script in the editor before queuing a batch task.');
      return;
    }
    setErrorMsg(null);
    const nextNum = batchQueue.length + 1;
    const newTask: BatchQueueTask = {
      id: `batch-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      label: `Batch Task ${String(nextNum).padStart(2, '0')} · ${nuance.emotionalTone}`,
      script: trimmed,
      nuanceSettings: { ...nuance },
      status: 'queued',
      createdAt: new Date().toISOString(),
    };
    setBatchQueue((prev) => [...prev, newTask]);
  };

  const handleSplitScriptIntoBatchTasks = () => {
    const trimmed = scriptText.trim();
    if (!trimmed) {
      setErrorMsg('Enter multiple lines or sentences in the script editor to split into batch tasks.');
      return;
    }

    // Split by newline first; if only 1 line, split by sentence boundaries
    let parts = trimmed
      .split(/\n+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    if (parts.length <= 1) {
      parts = trimmed
        .split(/(?<=[.!?])\s+/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    }

    if (parts.length === 0) return;

    setErrorMsg(null);
    const baseIndex = batchQueue.length;
    const createdTasks: BatchQueueTask[] = parts.map((segmentText, idx) => ({
      id: `batch-${Date.now()}-${idx}-${Math.random().toString(36).slice(2, 6)}`,
      label: `Batch Task ${String(baseIndex + idx + 1).padStart(2, '0')} · Segment ${idx + 1}`,
      script: segmentText,
      nuanceSettings: { ...nuance },
      status: 'queued',
      createdAt: new Date().toISOString(),
    }));

    setBatchQueue((prev) => [...prev, ...createdTasks]);
  };

  const handleLoadThreePresetBatch = () => {
    setErrorMsg(null);
    const tones: EmotionalTonePreset[] = [
      'Warm & Conversational',
      'Reflective & Intimate',
      'Authoritative & Crisp',
    ];
    const presetTasks: BatchQueueTask[] = SAMPLE_SCRIPTS.map((preset, idx) => ({
      id: `batch-preset-${Date.now()}-${idx}`,
      label: `Batch Task ${String(idx + 1).padStart(2, '0')} · ${preset.label}`,
      script: preset.text,
      nuanceSettings: {
        ...nuance,
        emotionalTone: tones[idx % tones.length],
      },
      status: 'queued',
      createdAt: new Date().toISOString(),
    }));
    setBatchQueue(presetTasks);
  };

  const handleUpdateBatchTask = (taskId: string, patch: Partial<BatchQueueTask>) => {
    setBatchQueue((prev) =>
      prev.map((task) => (task.id === taskId ? { ...task, ...patch } : task))
    );
  };

  const handleRemoveBatchTask = (taskId: string) => {
    setBatchQueue((prev) => prev.filter((task) => task.id !== taskId));
  };

  const handleRunBatchQueue = async () => {
    const runnableTasks = batchQueue.filter(
      (t) => (t.status === 'queued' || t.status === 'failed') && t.script.trim().length > 0
    );

    if (runnableTasks.length === 0) {
      setErrorMsg('No pending or failed tasks in the batch queue. Add or reset tasks to run batch synthesis.');
      return;
    }

    if (!validateDataFloorBeforeSynthesis()) {
      return;
    }

    setIsRunningBatchQueue(true);
    setErrorMsg(null);
    let completedCount = 0;
    let lastGeneratedTake: SynthesisTake | null = null;

    for (let i = 0; i < runnableTasks.length; i++) {
      const task = runnableTasks[i];
      setBatchProgressText(
        `Processing ${i + 1} of ${runnableTasks.length}: ${task.label}`
      );

      setBatchQueue((prev) =>
        prev.map((item) =>
          item.id === task.id
            ? { ...item, status: 'processing', errorMessage: undefined }
            : item
        )
      );

      try {
        const generatedTake = await executeSingleTaskSynthesis(
          task.script,
          task.nuanceSettings,
          task.label
        );
        onAddTake(generatedTake);
        lastGeneratedTake = generatedTake;
        completedCount++;

        setBatchQueue((prev) =>
          prev.map((item) =>
            item.id === task.id
              ? {
                  ...item,
                  status: 'completed',
                  generatedTakeId: generatedTake.id,
                  errorMessage: undefined,
                }
              : item
          )
        );
      } catch (err: any) {
        const message = err?.message || 'Batch task synthesis failed.';
        setBatchQueue((prev) =>
          prev.map((item) =>
            item.id === task.id
              ? { ...item, status: 'failed', errorMessage: message }
              : item
          )
        );
      }
    }

    setIsRunningBatchQueue(false);
    setBatchProgressText(null);

    if (lastGeneratedTake) {
      setEditingTrimTakeId(lastGeneratedTake.id);
      setExportStatusMsg(
        `Batch synthesis complete: ${completedCount} of ${runnableTasks.length} queued tasks synthesized and added to the unified takes list below.`
      );
    }
  };

  const playTakeAudio = (take: SynthesisTake) => {
    if (playingTakeId === take.id && activeAudioRef.current) {
      activeAudioRef.current.pause();
      setPlayingTakeId(null);
      return;
    }

    if (activeAudioRef.current) {
      activeAudioRef.current.pause();
    }
    setPlayingAnchorCompare(false);

    const audio = new Audio(`data:audio/wav;base64,${take.calibratedWavBase64}`);
    activeAudioRef.current = audio;
    setPlayingTakeId(take.id);
    audio.onended = () => setPlayingTakeId(null);
    audio.onerror = () => setPlayingTakeId(null);
    audio.play().catch(() => setPlayingTakeId(null));
  };

  const playReferenceAnchorComparison = () => {
    if (anchors.length === 0) return;
    if (playingAnchorCompare && activeAudioRef.current) {
      activeAudioRef.current.pause();
      setPlayingAnchorCompare(false);
      return;
    }

    if (activeAudioRef.current) {
      activeAudioRef.current.pause();
    }
    setPlayingTakeId(null);

    const refAnchor = anchors[0];
    const audio = new Audio(`data:${refAnchor.mimeType};base64,${refAnchor.audioBase64}`);
    activeAudioRef.current = audio;
    setPlayingAnchorCompare(true);
    audio.onended = () => setPlayingAnchorCompare(false);
    audio.onerror = () => setPlayingAnchorCompare(false);
    audio.play().catch(() => setPlayingAnchorCompare(false));
  };

  const sanitizeSlug = (val: string) =>
    (val || 'voxreplica')
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'voxreplica';

  const formatWavSizeKb = (durationSec: number, sampleRate: number) => {
    const bytes = 44 + Math.round(durationSec * sampleRate * 2);
    if (bytes >= 1024 * 1024) {
      return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
    }
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  };

  const handleExportTakeWav = async (
    take: SynthesisTake,
    takeNumber: number,
    variant: 'calibrated' | 'raw' = 'calibrated'
  ) => {
    setExportingTakeId(`${take.id}-${variant}`);
    setErrorMsg(null);
    try {
      const sourceWav =
        variant === 'raw' && take.rawWavBase64
          ? take.rawWavBase64
          : take.calibratedWavBase64;

      const resampledWav = await exportWavAtSampleRate(sourceWav, exportSampleRate);
      const rateLabel =
        exportSampleRate === 48000
          ? '48kHz'
          : exportSampleRate === 44100
          ? '44.1kHz'
          : '24kHz';
      const toneSlug = sanitizeSlug(take.nuanceSettings.emotionalTone);
      const prefix = sanitizeSlug(exportFilePrefix);
      const filename = `${prefix}_${String(takeNumber).padStart(2, '0')}_${toneSlug}_${variant}_${rateLabel}.wav`;

      downloadWavFile(resampledWav, filename);
      setExportStatusMsg(
        `Saved "${filename}" (${formatWavSizeKb(take.durationSec, exportSampleRate)}, 16-bit PCM WAV) to local storage.`
      );
    } catch (err: any) {
      setErrorMsg(err?.message || 'Failed to export WAV file.');
    } finally {
      setExportingTakeId(null);
    }
  };

  const handleStitchAndExportMasterWav = async () => {
    if (takes.length === 0) return;
    setIsExportingBatch(true);
    setErrorMsg(null);
    try {
      // Stitch takes in chronological order (oldest first to newest last)
      const chronologicalTakes = [...takes].reverse();
      const wavList = chronologicalTakes.map((t) => t.calibratedWavBase64);
      const stitched = await stitchTakesToMasterWav(
        wavList,
        stitchSilenceGapSec,
        exportSampleRate
      );

      const rateLabel =
        exportSampleRate === 48000
          ? '48kHz'
          : exportSampleRate === 44100
          ? '44.1kHz'
          : '24kHz';
      const prefix = sanitizeSlug(exportFilePrefix);
      const filename = `${prefix}_stitched_master_${takes.length}takes_${rateLabel}.wav`;

      downloadWavFile(stitched.wavBase64, filename);
      setExportStatusMsg(
        `Exported stitched master "${filename}" (${takes.length} takes · ${stitched.totalDurationSec}s · ${formatWavSizeKb(
          stitched.totalDurationSec,
          exportSampleRate
        )}) to local storage.`
      );
    } catch (err: any) {
      setErrorMsg(err?.message || 'Failed to stitch and export master WAV.');
    } finally {
      setIsExportingBatch(false);
    }
  };

  const handleBatchExportAllIndividualWavs = async () => {
    if (takes.length === 0) return;
    setIsExportingBatch(true);
    setErrorMsg(null);
    try {
      for (let i = 0; i < takes.length; i++) {
        const take = takes[i];
        const takeNum = takes.length - i;
        await handleExportTakeWav(take, takeNum, 'calibrated');
        await new Promise((r) => setTimeout(r, 220));
      }
      setExportStatusMsg(
        `Exported all ${takes.length} individual WAV takes at ${(exportSampleRate / 1000).toFixed(
          1
        )} kHz to local storage.`
      );
    } catch (err: any) {
      setErrorMsg(err?.message || 'Failed during batch WAV export.');
    } finally {
      setIsExportingBatch(false);
    }
  };

  const resetNuanceSliders = () => {
    setNuance({
      pacing: 1.0,
      pitchSemitones: 0,
      expressiveness: 80,
      emotionalTone: 'Warm & Conversational',
      warmth: 65,
      applyDspCalibration: true,
    });
  };

  const latestTake = takes[0] || null;
  const pendingBatchCount = batchQueue.filter(
    (t) => t.status === 'queued' || t.status === 'failed'
  ).length;
  const completedBatchCount = batchQueue.filter((t) => t.status === 'completed').length;
  const filteredTakes = takes.filter((take) => {
    if (takeSourceFilter === 'batch') return Boolean(take.batchTaskLabel);
    if (takeSourceFilter === 'single') return !take.batchTaskLabel;
    return true;
  });

  return (
    <div className="space-y-8">
      {/* Stage Header */}
      <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-4 pb-6 border-b border-slate-800">
        <div>
          <p className="text-xs font-medium text-amber-400 tracking-wide">
            Stage 04 · Custom Voice Text-to-Speech Execution
          </p>
          <h1 className="text-2xl sm:text-3xl font-semibold text-slate-50 mt-1">
            Vocal Nuance Synthesis Workbench
          </h1>
          <p className="text-sm text-slate-400 mt-2 max-w-3xl">
            Convert any text input into 24kHz broadcast WAV audio matching{' '}
            <strong className="text-slate-200">{activeProfile.name}</strong> (
            <span className="font-mono text-cyan-400">
              {activeProfile.acousticFingerprint.medianF0Hz} Hz F0 ·{' '}
              {activeProfile.acousticFingerprint.avgWpm} WPM
            </span>
            ). Fine-tune prosody, pitch, pacing, and emotional tone or inject inline vocal bursts
            and breathing cues.
          </p>
        </div>

        {anchors.length > 0 && (
          <button
            onClick={playReferenceAnchorComparison}
            className="inline-flex items-center gap-2 px-3.5 py-2 text-xs font-medium text-cyan-300 bg-cyan-500/10 hover:bg-cyan-500/20 border border-cyan-500/30 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            {playingAnchorCompare ? (
              <>
                <Volume2 className="w-3.5 h-3.5 animate-pulse" />
                Stop Reference Mic Anchor
              </>
            ) : (
              <>
                <Play className="w-3.5 h-3.5" />
                A/B Audition My Mic Anchor ({anchors[0].dspMetrics.medianF0Hz} Hz)
              </>
            )}
          </button>
        )}
      </div>

      {errorMsg && (
        <div className="p-4 rounded-lg bg-rose-950/60 border border-rose-800/80 text-sm text-rose-200 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <span>{errorMsg}</span>
          <div className="flex items-center gap-2 shrink-0">
            {!diagnostic.meetsDataFloor && (
              <button
                onClick={() => {
                  setErrorMsg(null);
                  onJumpToAnchorLab(
                    diagnostic.lowestConfidenceElements[0]?.targetedPracticeScript
                  );
                }}
                className="px-3 py-1.5 text-xs font-semibold text-slate-950 bg-amber-400 hover:bg-amber-300 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                Record Missing Audio (+{diagnostic.secondsShortfall}s)
              </button>
            )}
            <button
              onClick={() => setErrorMsg(null)}
              className="text-xs font-medium text-rose-300 hover:text-white underline cursor-pointer"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {/* Main 12-Col Synthesis Console */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-stretch">
        {/* Left 7 Cols: Script & Vocal Bursts Markup Editor */}
        <div className="lg:col-span-7 bg-[#111827] border border-slate-800 rounded-xl p-6 flex flex-col justify-between space-y-5">
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-base font-semibold text-slate-100">
                Script & Vocal Burst Markup Editor
              </h2>

              <div className="flex items-center gap-2">
                {SAMPLE_SCRIPTS.map((preset, idx) => (
                  <button
                    key={idx}
                    onClick={() => setScriptText(preset.text)}
                    className="px-2.5 py-1 text-xs text-slate-300 bg-slate-800/90 hover:bg-slate-700 rounded transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    Preset {idx + 1}
                  </button>
                ))}
              </div>
            </div>

            {/* Inline Vocal Bursts & Breath Insertion Bar */}
            <div className="p-3 rounded-lg bg-slate-900/90 border border-slate-800 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs text-slate-400">
                  Insert Vocal Bursts, Breaths & Natural Pauses at Cursor:
                </span>
                <button
                  onClick={handleAutoAnnotateNuances}
                  disabled={isAnnotating || isSynthesizing}
                  className="inline-flex items-center gap-1.5 px-3 py-1 text-xs font-semibold text-amber-300 bg-amber-500/15 hover:bg-amber-500/25 border border-amber-500/30 disabled:opacity-50 rounded transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                >
                  {isAnnotating ? (
                    <>
                      <Loader2 className="w-3 h-3 animate-spin" />
                      Injecting Habits...
                    </>
                  ) : (
                    <>
                      <Wand2 className="w-3 h-3" />
                      Auto-Inject My Breathing & Pauses
                    </>
                  )}
                </button>
              </div>

              <div className="flex flex-wrap items-center gap-1.5">
                {INLINE_NUANCE_TOKENS.map((item) => (
                  <button
                    key={item.token}
                    onClick={() => insertTokenAtCursor(item.token)}
                    title={item.desc}
                    className="px-2.5 py-1 text-xs font-mono text-cyan-300 bg-slate-950 hover:bg-slate-800 border border-slate-800 rounded transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    + {item.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Script Textarea */}
            <div>
              <textarea
                ref={textareaRef}
                rows={7}
                value={scriptText}
                onChange={(e) => setScriptText(e.target.value)}
                placeholder="Type or paste any text to synthesize in your custom voice..."
                className="w-full p-4 rounded-xl bg-slate-950 border border-slate-800 text-base text-slate-100 leading-relaxed focus:outline-none focus:border-amber-500 font-sans"
              />
              <div className="flex items-center justify-between text-xs text-slate-400 mt-1.5 font-mono tabular-nums">
                <span>
                  {scriptText.trim().split(/\s+/).filter(Boolean).length} words · Est. duration ~
                  {Math.max(
                    1,
                    Math.round(
                      (scriptText.trim().split(/\s+/).filter(Boolean).length /
                        (activeProfile.acousticFingerprint.avgWpm * nuance.pacing)) *
                        60
                    )
                  )}
                  s
                </span>
                <span>
                  Active Foundation: {activeProfile.baseFoundationVoice} + Vocal DNA Blueprint
                </span>
              </div>
            </div>
          </div>

          {/* Primary Synthesize & Batch Queue Action Bar */}
          <div className="pt-4 border-t border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={handleEnqueueCurrentScript}
                disabled={isSynthesizing || isRunningBatchQueue || !scriptText.trim()}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-cyan-300 bg-cyan-500/15 hover:bg-cyan-500/25 border border-cyan-500/30 disabled:opacity-50 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                title="Add current script and nuance settings to the batch synthesis queue"
              >
                <ListPlus className="w-3.5 h-3.5" />
                + Queue Task for Batch
              </button>

              <button
                onClick={handleSplitScriptIntoBatchTasks}
                disabled={isSynthesizing || isRunningBatchQueue || !scriptText.trim()}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-200 bg-slate-800 hover:bg-slate-700 border border-slate-700 disabled:opacity-50 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                title="Split multi-line or multi-sentence text into separate queued batch tasks"
              >
                <Split className="w-3.5 h-3.5" />
                Split Lines → Batch Queue
              </button>
            </div>

            <button
              onClick={handleSynthesizeSpeech}
              disabled={isSynthesizing || isRunningBatchQueue || !scriptText.trim()}
              className="inline-flex items-center justify-center gap-2 px-5 py-2.5 text-sm font-semibold text-slate-950 bg-amber-500 hover:bg-amber-400 disabled:opacity-50 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              {isSynthesizing ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Synthesizing Custom Voice...
                </>
              ) : (
                <>
                  <Sparkles className="w-4 h-4" />
                  Synthesize Single Take
                </>
              )}
            </button>
          </div>
        </div>

        {/* Right 5 Cols: Prosody, Pacing, Pitch & Emotional Tone Control Rack */}
        <div className="lg:col-span-5 bg-[#111827] border border-slate-800 rounded-xl p-6 flex flex-col justify-between space-y-5">
          <div className="space-y-5">
            <div className="flex items-center justify-between pb-3 border-b border-slate-800">
              <div>
                <h2 className="text-base font-semibold text-slate-100">
                  Prosody & Vocal Nuance Rack
                </h2>
                <p className="text-xs text-slate-400 mt-0.5">
                  Modulates Voice Design prosody and post-synthesis DSP parameters.
                </p>
              </div>
              <button
                onClick={resetNuanceSliders}
                className="inline-flex items-center gap-1 text-xs text-slate-400 hover:text-slate-200 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                title="Reset sliders to profile baseline"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                Reset
              </button>
            </div>

            {/* Emotional Tone Preset Grid */}
            <div>
              <label className="block text-xs text-slate-400 mb-2">
                Emotional Tone & Delivery Posture
              </label>
              <div className="grid grid-cols-2 gap-2">
                {EMOTIONAL_TONES.map((tone) => {
                  const active = nuance.emotionalTone === tone;
                  return (
                    <button
                      key={tone}
                      onClick={() => setNuance({ ...nuance, emotionalTone: tone })}
                      className={`px-3 py-2 text-xs font-medium rounded-lg border text-left transition-colors whitespace-nowrap truncate cursor-pointer ${
                        active
                          ? 'bg-amber-500/15 border-amber-500 text-amber-300'
                          : 'bg-slate-900/70 border-slate-800 text-slate-300 hover:border-slate-700'
                      }`}
                    >
                      {tone}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Sliders */}
            <div className="space-y-4">
              {/* Pacing / Speaking Tempo */}
              <div>
                <div className="flex justify-between text-xs mb-1">
                  <span className="text-slate-300">Pacing & Speaking Cadence</span>
                  <span className="font-mono tabular-nums text-amber-400">
                    {nuance.pacing.toFixed(2)}x (~
                    {Math.round(activeProfile.acousticFingerprint.avgWpm * nuance.pacing)} WPM)
                  </span>
                </div>
                <input
                  type="range"
                  min={0.75}
                  max={1.25}
                  step={0.02}
                  value={nuance.pacing}
                  onChange={(e) =>
                    setNuance({ ...nuance, pacing: Number(e.target.value) })
                  }
                  className="w-full accent-amber-400 cursor-pointer"
                />
              </div>

              {/* Pitch Offset */}
              <div>
                <div className="flex justify-between text-xs mb-1">
                  <span className="text-slate-300">Pitch Register Shift</span>
                  <span className="font-mono tabular-nums text-cyan-400">
                    {nuance.pitchSemitones > 0 ? '+' : ''}
                    {nuance.pitchSemitones.toFixed(1)} st (~
                    {Math.round(
                      activeProfile.acousticFingerprint.medianF0Hz *
                        Math.pow(2, nuance.pitchSemitones / 12)
                    )}{' '}
                    Hz)
                  </span>
                </div>
                <input
                  type="range"
                  min={-4.0}
                  max={4.0}
                  step={0.2}
                  value={nuance.pitchSemitones}
                  onChange={(e) =>
                    setNuance({ ...nuance, pitchSemitones: Number(e.target.value) })
                  }
                  className="w-full accent-cyan-400 cursor-pointer"
                />
              </div>

              {/* Prosodic Expressiveness */}
              <div>
                <div className="flex justify-between text-xs mb-1">
                  <span className="text-slate-300">Inflection Variance & Expressiveness</span>
                  <span className="font-mono tabular-nums text-emerald-400">
                    {nuance.expressiveness}%
                  </span>
                </div>
                <input
                  type="range"
                  min={10}
                  max={100}
                  step={5}
                  value={nuance.expressiveness}
                  onChange={(e) =>
                    setNuance({ ...nuance, expressiveness: Number(e.target.value) })
                  }
                  className="w-full accent-emerald-400 cursor-pointer"
                />
              </div>

              {/* Acoustic Timbre Warmth */}
              <div>
                <div className="flex justify-between text-xs mb-1">
                  <span className="text-slate-300">Chest Resonance & Formant Warmth</span>
                  <span className="font-mono tabular-nums text-slate-200">
                    {nuance.warmth}%
                  </span>
                </div>
                <input
                  type="range"
                  min={10}
                  max={100}
                  step={5}
                  value={nuance.warmth}
                  onChange={(e) =>
                    setNuance({ ...nuance, warmth: Number(e.target.value) })
                  }
                  className="w-full accent-amber-400 cursor-pointer"
                />
              </div>
            </div>
          </div>

          <div className="pt-3 border-t border-slate-800">
            <label className="flex items-center justify-between text-xs text-slate-300 cursor-pointer select-none">
              <span>Apply Web Audio DSP Formant & F0 Lock</span>
              <input
                type="checkbox"
                checked={nuance.applyDspCalibration}
                onChange={(e) =>
                  setNuance({ ...nuance, applyDspCalibration: e.target.checked })
                }
                className="rounded border-slate-700 bg-slate-900 text-amber-500 focus:ring-0"
              />
            </label>
          </div>
        </div>
      </div>

      {/* Multi-Task Batch Synthesis Queue */}
      <div className="bg-[#111827] border border-slate-800 rounded-xl p-6 space-y-5">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 pb-4 border-b border-slate-800">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-base font-semibold text-slate-100">
                Batch Text-to-Speech Task Queue
              </h2>
              <span className="text-xs font-mono tabular-nums text-slate-400">
                {batchQueue.length} total · {pendingBatchCount} pending · {completedBatchCount} completed
              </span>
            </div>
            <p className="text-xs text-slate-400 mt-0.5">
              Queue multiple scripts with distinct emotional tones or pacing, run sequential batch
              processing with one click, and view all generated takes in the unified list below.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <button
              onClick={handleLoadThreePresetBatch}
              disabled={isRunningBatchQueue || isSynthesizing}
              className="px-3 py-2 text-xs font-medium text-slate-300 bg-slate-800 hover:bg-slate-700 disabled:opacity-50 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              Load 3-Task Preset Batch
            </button>

            {completedBatchCount > 0 && (
              <button
                onClick={() =>
                  setBatchQueue((prev) =>
                    prev.map((t) => ({ ...t, status: 'queued', errorMessage: undefined }))
                  )
                }
                disabled={isRunningBatchQueue || isSynthesizing}
                className="px-3 py-2 text-xs font-medium text-slate-300 bg-slate-800 hover:bg-slate-700 disabled:opacity-50 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                Re-Queue Completed
              </button>
            )}

            {batchQueue.length > 0 && (
              <button
                onClick={() => setBatchQueue([])}
                disabled={isRunningBatchQueue || isSynthesizing}
                className="px-3 py-2 text-xs font-medium text-slate-400 hover:text-rose-300 bg-slate-900 hover:bg-rose-950/60 border border-slate-800 disabled:opacity-50 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                Clear Queue
              </button>
            )}

            <button
              onClick={handleRunBatchQueue}
              disabled={isRunningBatchQueue || isSynthesizing || pendingBatchCount === 0}
              className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-slate-950 bg-cyan-400 hover:bg-cyan-300 disabled:opacity-50 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              {isRunningBatchQueue ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  {batchProgressText || 'Processing Batch Queue...'}
                </>
              ) : (
                <>
                  <PlayCircle className="w-4 h-4" />
                  Run Batch Queue ({pendingBatchCount} {pendingBatchCount === 1 ? 'Task' : 'Tasks'})
                </>
              )}
            </button>
          </div>
        </div>

        {batchQueue.length === 0 ? (
          <div className="py-8 text-center border border-dashed border-slate-800 rounded-lg space-y-2">
            <ListPlus className="w-6 h-6 text-slate-500 mx-auto" />
            <p className="text-sm font-medium text-slate-200">
              Batch queue is currently empty
            </p>
            <p className="text-xs text-slate-400 max-w-md mx-auto">
              Use “+ Queue Task for Batch” or “Split Lines → Batch Queue” in the script editor
              above, or load the 3-Task Preset Batch to process multiple takes sequentially.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {batchQueue.map((task, idx) => {
              const linkedTake = task.generatedTakeId
                ? takes.find((t) => t.id === task.generatedTakeId)
                : undefined;

              return (
                <div
                  key={task.id}
                  className={`p-4 rounded-xl border transition-colors ${
                    task.status === 'processing'
                      ? 'bg-cyan-950/30 border-cyan-500/60'
                      : task.status === 'completed'
                      ? 'bg-emerald-950/20 border-emerald-700/50'
                      : task.status === 'failed'
                      ? 'bg-rose-950/30 border-rose-700/60'
                      : 'bg-slate-950/80 border-slate-800'
                  }`}
                >
                  <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
                    <div className="flex flex-wrap items-center gap-2 text-xs font-mono tabular-nums">
                      <span className="text-cyan-400 font-semibold">
                        #{String(idx + 1).padStart(2, '0')}
                      </span>
                      <input
                        type="text"
                        value={task.label}
                        disabled={isRunningBatchQueue}
                        onChange={(e) =>
                          handleUpdateBatchTask(task.id, { label: e.target.value })
                        }
                        className="px-2 py-1 rounded bg-slate-900 border border-slate-800 text-xs font-sans font-medium text-slate-100 focus:outline-none focus:border-cyan-400"
                      />
                      <span aria-hidden="true" className="text-slate-600">
                        ·
                      </span>
                      <select
                        value={task.nuanceSettings.emotionalTone}
                        disabled={isRunningBatchQueue}
                        onChange={(e) =>
                          handleUpdateBatchTask(task.id, {
                            nuanceSettings: {
                              ...task.nuanceSettings,
                              emotionalTone: e.target.value as EmotionalTonePreset,
                            },
                          })
                        }
                        className="px-2.5 py-1 rounded bg-slate-900 border border-slate-800 text-xs font-sans text-slate-200 focus:outline-none focus:border-cyan-400"
                      >
                        {EMOTIONAL_TONES.map((tone) => (
                          <option key={tone} value={tone}>
                            {tone}
                          </option>
                        ))}
                      </select>
                      <span aria-hidden="true" className="text-slate-600">
                        ·
                      </span>
                      <span className="text-slate-400">
                        {task.nuanceSettings.pacing.toFixed(2)}x ·{' '}
                        {task.nuanceSettings.pitchSemitones >= 0 ? '+' : ''}
                        {task.nuanceSettings.pitchSemitones.toFixed(1)} st
                      </span>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      {task.status === 'queued' && (
                        <span className="text-xs font-mono text-slate-400">
                          Status: Queued
                        </span>
                      )}
                      {task.status === 'processing' && (
                        <span className="inline-flex items-center gap-1.5 text-xs font-mono text-cyan-300">
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          Synthesizing...
                        </span>
                      )}
                      {task.status === 'completed' && (
                        <span className="inline-flex items-center gap-1 text-xs font-mono text-emerald-400">
                          <CheckCircle2 className="w-3.5 h-3.5" />
                          Completed
                        </span>
                      )}
                      {task.status === 'failed' && (
                        <span className="inline-flex items-center gap-1 text-xs font-mono text-rose-400">
                          <AlertCircle className="w-3.5 h-3.5" />
                          Failed
                        </span>
                      )}

                      {linkedTake && (
                        <button
                          onClick={() => playTakeAudio(linkedTake)}
                          className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold text-slate-950 bg-amber-400 hover:bg-amber-300 rounded transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                        >
                          {playingTakeId === linkedTake.id ? (
                            <>
                              <Volume2 className="w-3 h-3 animate-pulse" />
                              Stop
                            </>
                          ) : (
                            <>
                              <Play className="w-3 h-3" />
                              Play Output ({linkedTake.durationSec}s)
                            </>
                          )}
                        </button>
                      )}

                      <button
                        onClick={() => handleRemoveBatchTask(task.id)}
                        disabled={isRunningBatchQueue}
                        className="p-1.5 rounded bg-slate-900 hover:bg-rose-950 text-slate-400 hover:text-rose-300 disabled:opacity-40 transition-colors cursor-pointer"
                        title="Remove task from queue"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>

                  <div className="mt-2.5">
                    <textarea
                      rows={2}
                      value={task.script}
                      disabled={isRunningBatchQueue}
                      onChange={(e) =>
                        handleUpdateBatchTask(task.id, {
                          script: e.target.value,
                          status: task.status === 'completed' ? 'queued' : task.status,
                        })
                      }
                      className="w-full p-2.5 rounded-lg bg-slate-900/90 border border-slate-800 text-xs text-slate-100 leading-relaxed focus:outline-none focus:border-cyan-400"
                    />
                  </div>

                  {task.errorMessage && (
                    <p className="text-xs text-rose-300 mt-1.5">
                      Error: {task.errorMessage}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Unified Generated Takes List, Waveform Trim Editor & Local WAV Export Studio */}
      <div className="bg-[#111827] border border-slate-800 rounded-xl p-6 space-y-5">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 pb-4 border-b border-slate-800">
          <div>
            <div className="flex flex-wrap items-center gap-3">
              <h2 className="text-base font-semibold text-slate-100">
                Unified Generated Takes List & Local WAV Export Studio ({takes.length})
              </h2>
              {takes.length > 0 && (
                <div className="flex items-center gap-1 bg-slate-900 p-1 rounded-lg border border-slate-800">
                  <button
                    onClick={() => setTakeSourceFilter('all')}
                    className={`px-2.5 py-1 text-xs rounded transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                      takeSourceFilter === 'all'
                        ? 'bg-amber-500 text-slate-950 font-semibold'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    All Takes ({takes.length})
                  </button>
                  <button
                    onClick={() => setTakeSourceFilter('batch')}
                    className={`px-2.5 py-1 text-xs rounded transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                      takeSourceFilter === 'batch'
                        ? 'bg-cyan-400 text-slate-950 font-semibold'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    Batch Queue ({takes.filter((t) => Boolean(t.batchTaskLabel)).length})
                  </button>
                  <button
                    onClick={() => setTakeSourceFilter('single')}
                    className={`px-2.5 py-1 text-xs rounded transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                      takeSourceFilter === 'single'
                        ? 'bg-amber-500 text-slate-950 font-semibold'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    Single Runs ({takes.filter((t) => !t.batchTaskLabel).length})
                  </button>
                </div>
              )}
            </div>
            <p className="text-xs text-slate-400 mt-1">
              All single and batch-processed takes appear in this unified list. Audition, trim
              waveforms, stitch into a master WAV, or export individual 16-bit PCM WAV files.
            </p>
          </div>

          {takes.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 shrink-0">
              {takes.length > 1 && (
                <button
                  onClick={handleStitchAndExportMasterWav}
                  disabled={isExportingBatch}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-slate-950 bg-amber-500 hover:bg-amber-400 disabled:opacity-50 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                  title="Concatenate all generated takes into a single continuous WAV file"
                >
                  {isExportingBatch ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Layers className="w-3.5 h-3.5" />
                  )}
                  Stitch All {takes.length} Takes → Master .WAV
                </button>
              )}

              <button
                onClick={handleBatchExportAllIndividualWavs}
                disabled={isExportingBatch}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-slate-100 bg-slate-800 hover:bg-slate-700 disabled:opacity-50 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Download className="w-3.5 h-3.5" />
                Export All Individual .WAVs
              </button>
            </div>
          )}
        </div>

        {/* Local WAV Export Configuration Toolbar */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 p-4 rounded-xl bg-slate-900/80 border border-slate-800">
          <div>
            <label className="block text-xs text-slate-400 mb-1.5">
              WAV Export Sample Rate (16-Bit RIFF PCM)
            </label>
            <select
              value={exportSampleRate}
              onChange={(e) =>
                setExportSampleRate(Number(e.target.value) as 24000 | 44100 | 48000)
              }
              className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-800 text-xs font-mono tabular-nums text-slate-100 focus:outline-none focus:border-amber-500"
            >
              <option value={24000}>24,000 Hz · Native Neural Broadcast Mono</option>
              <option value={44100}>44,100 Hz · CD Master Standard (Recommended)</option>
              <option value={48000}>48,000 Hz · Studio Production / Video Sync</option>
            </select>
          </div>

          <div>
            <label className="block text-xs text-slate-400 mb-1.5">
              Local Filename Prefix
            </label>
            <input
              type="text"
              value={exportFilePrefix}
              onChange={(e) => setExportFilePrefix(e.target.value)}
              placeholder="voxreplica_take"
              className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-800 text-xs font-mono text-slate-100 focus:outline-none focus:border-amber-500"
            />
          </div>

          <div>
            <label className="block text-xs text-slate-400 mb-1.5">
              Multi-Take Stitch Silence Padding
            </label>
            <select
              value={stitchSilenceGapSec}
              onChange={(e) => setStitchSilenceGapSec(Number(e.target.value))}
              className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-800 text-xs font-mono tabular-nums text-slate-100 focus:outline-none focus:border-amber-500"
            >
              <option value={0.3}>0.3s · Tight Conversational Cut</option>
              <option value={0.8}>0.8s · Natural Paragraph Pause</option>
              <option value={1.5}>1.5s · Chapter / Section Separation</option>
            </select>
          </div>
        </div>

        {exportStatusMsg && (
          <div className="p-3.5 rounded-lg bg-emerald-950/60 border border-emerald-700/70 text-xs text-emerald-200 flex items-center justify-between gap-4">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
              <span>{exportStatusMsg}</span>
            </div>
            <button
              onClick={() => setExportStatusMsg(null)}
              className="text-xs font-medium text-emerald-300 hover:text-white underline whitespace-nowrap shrink-0 cursor-pointer"
            >
              Dismiss
            </button>
          </div>
        )}

        {filteredTakes.length === 0 ? (
          <div className="py-12 text-center border border-dashed border-slate-800 rounded-lg space-y-2">
            <FileAudio className="w-7 h-7 text-slate-500 mx-auto" />
            <p className="text-sm font-medium text-slate-200">
              No synthesized audio outputs matching this view
            </p>
            <p className="text-xs text-slate-400 max-w-md mx-auto">
              Click “Synthesize Single Take” or “Run Batch Queue” above to generate speech
              replicated to your vocal nuances and view all takes in this unified list.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {filteredTakes.map((take) => {
              const isPlaying = playingTakeId === take.id;
              const isLatest = latestTake?.id === take.id;
              const chronologicalIndex = takes.findIndex((t) => t.id === take.id);
              const takeNumber = takes.length - (chronologicalIndex >= 0 ? chronologicalIndex : 0);
              const isExportingCalibrated = exportingTakeId === `${take.id}-calibrated`;
              const isExportingRaw = exportingTakeId === `${take.id}-raw`;
              const isTrimOpen = editingTrimTakeId === take.id;

              return (
                <div
                  key={take.id}
                  className={`p-5 rounded-xl border transition-colors ${
                    isLatest
                      ? 'bg-slate-900/95 border-amber-500/50'
                      : 'bg-slate-950/70 border-slate-800'
                  }`}
                >
                  <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
                    <div className="flex items-start gap-3">
                      <button
                        onClick={() => playTakeAudio(take)}
                        className="p-3 rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 transition-colors cursor-pointer shrink-0"
                        title={isPlaying ? 'Pause playback' : 'Play synthesized output'}
                      >
                        {isPlaying ? (
                          <Volume2 className="w-5 h-5 animate-pulse" />
                        ) : (
                          <Play className="w-5 h-5" />
                        )}
                      </button>

                      <div className="space-y-1">
                        <div className="flex flex-wrap items-center gap-2 text-xs font-mono tabular-nums text-slate-400">
                          <span className="text-amber-400 font-semibold">
                            Take #{takeNumber}
                          </span>
                          {take.batchTaskLabel && (
                            <>
                              <span aria-hidden="true">·</span>
                              <span className="text-cyan-300 font-medium">
                                {take.batchTaskLabel}
                              </span>
                            </>
                          )}
                          <span aria-hidden="true">·</span>
                          <span className="text-slate-200">{take.profileName}</span>
                          <span aria-hidden="true">·</span>
                          <span>{take.nuanceSettings.emotionalTone}</span>
                          <span aria-hidden="true">·</span>
                          <span>{take.nuanceSettings.pacing.toFixed(2)}x tempo</span>
                          <span aria-hidden="true">·</span>
                          <span>
                            {take.nuanceSettings.pitchSemitones >= 0 ? '+' : ''}
                            {take.nuanceSettings.pitchSemitones.toFixed(1)} st
                          </span>
                          <span aria-hidden="true">·</span>
                          <span className="text-cyan-400">
                            {take.durationSec}s · {formatWavSizeKb(take.durationSec, exportSampleRate)}
                          </span>
                          {take.isTrimmed && (
                            <>
                              <span aria-hidden="true">·</span>
                              <span className="text-emerald-400">
                                Cropped ({take.lastTrimStartSec?.toFixed(2)}s–
                                {take.lastTrimEndSec?.toFixed(2)}s)
                              </span>
                            </>
                          )}
                        </div>

                        <p className="text-sm text-slate-100 leading-relaxed">
                          “{take.rawScript}”
                        </p>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-2 shrink-0">
                      <button
                        onClick={() =>
                          setEditingTrimTakeId(isTrimOpen ? null : take.id)
                        }
                        className={`inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                          isTrimOpen
                            ? 'bg-amber-500/20 border-amber-500 text-amber-300'
                            : 'bg-slate-800 hover:bg-slate-700 border-slate-700 text-slate-200'
                        }`}
                        title="Open visual waveform editor to trim or crop beginning and end"
                      >
                        <Scissors className="w-3.5 h-3.5" />
                        {isTrimOpen ? 'Hide Trim Editor' : 'Trim / Crop Waveform'}
                      </button>

                      <button
                        onClick={() => handleExportTakeWav(take, takeNumber, 'calibrated')}
                        disabled={isExportingCalibrated || isExportingRaw}
                        className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-slate-950 bg-cyan-400 hover:bg-cyan-300 disabled:opacity-50 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                        title="Save DSP-calibrated WAV file to your computer"
                      >
                        {isExportingCalibrated ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <Download className="w-3.5 h-3.5" />
                        )}
                        Export Calibrated .WAV ({(exportSampleRate / 1000).toFixed(1)} kHz)
                      </button>

                      <button
                        onClick={() => handleExportTakeWav(take, takeNumber, 'raw')}
                        disabled={isExportingCalibrated || isExportingRaw}
                        className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-200 bg-slate-800 hover:bg-slate-700 disabled:opacity-50 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                        title="Save unprocessed raw neural synthesis WAV file"
                      >
                        {isExportingRaw ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <FileAudio className="w-3.5 h-3.5" />
                        )}
                        Raw .WAV
                      </button>

                      <button
                        onClick={() => onRemoveTake(take.id)}
                        className="p-2 rounded-lg bg-slate-800/80 hover:bg-rose-950 text-slate-400 hover:text-rose-300 transition-colors cursor-pointer"
                        title="Delete take"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>

                  <div className="mt-4">
                    <WaveformBars
                      peaks={take.waveformPeaks}
                      accentColor={isLatest ? '#F59E0B' : '#06B6D4'}
                      height={36}
                      isPlaying={isPlaying}
                    />
                  </div>

                  {isTrimOpen && (
                    <WaveformTrimEditor
                      take={take}
                      takeNumber={takeNumber}
                      exportSampleRate={exportSampleRate}
                      exportFilePrefix={exportFilePrefix}
                      onApplyTrimToTake={onUpdateTake}
                      onClose={() => setEditingTrimTakeId(null)}
                    />
                  )}

                  <div className="mt-3 pt-2.5 border-t border-slate-800/80 text-xs text-slate-400 truncate">
                    <span className="text-slate-500">Compiled Voice Design Style:</span>{' '}
                    {take.compiledStyle}
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
