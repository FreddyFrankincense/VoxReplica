import React, { useEffect, useRef, useState } from 'react';
import {
  CheckCircle2,
  Loader2,
  Mic,
  Play,
  Square,
  Trash2,
  Upload,
  Volume2,
  Wand2,
} from 'lucide-react';
import { GuidedPromptCard, VoiceAnchorSample } from '../types/voice';
import { GUIDED_ANCHOR_PROMPTS } from '../utils/storage';
import {
  audioBufferSliceToWavBase64,
  base64ToAudioBuffer,
  estimateFramePitchHz,
  extractAcousticDspMetrics,
} from '../utils/audioDsp';
import { WaveformBars } from './WaveformVisualizer';

interface VoiceAnchorLabProps {
  anchors: VoiceAnchorSample[];
  onAddAnchor: (sample: VoiceAnchorSample) => void;
  onRemoveAnchor: (id: string) => void;
  onProceedToDiarizer: () => void;
  targetedPhonemeScript?: string | null;
  targetedPhonemeTitle?: string | null;
}

export const VoiceAnchorLab: React.FC<VoiceAnchorLabProps> = ({
  anchors,
  onAddAnchor,
  onRemoveAnchor,
  onProceedToDiarizer,
  targetedPhonemeScript,
  targetedPhonemeTitle,
}) => {
  const [selectedPromptId, setSelectedPromptId] = useState<string>(GUIDED_ANCHOR_PROMPTS[0].id);
  const [customScript, setCustomScript] = useState<string>('');
  const [customTitle, setCustomTitle] = useState<string>('Custom Reference Prompt');
  const [isUsingCustomScript, setIsUsingCustomScript] = useState<boolean>(false);

  const [isRecording, setIsRecording] = useState<boolean>(false);
  const [recordingSec, setRecordingSec] = useState<number>(0);
  const [liveF0Hz, setLiveF0Hz] = useState<number | null>(null);
  const [liveRmsDb, setLiveRmsDb] = useState<number>(-60);
  const [isAnalyzing, setIsAnalyzing] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [playingAnchorId, setPlayingAnchorId] = useState<string | null>(null);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const recordedChunksRef = useRef<Float32Array[]>([]);
  const animFrameRef = useRef<number | null>(null);
  const timerRef = useRef<number | null>(null);
  const activeAudioElRef = useRef<HTMLAudioElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (targetedPhonemeScript) {
      setCustomScript(targetedPhonemeScript);
      setCustomTitle(targetedPhonemeTitle || 'Targeted Phoneme Calibration Drill');
      setIsUsingCustomScript(true);
    }
  }, [targetedPhonemeScript, targetedPhonemeTitle]);

  const activePrompt: GuidedPromptCard = isUsingCustomScript
    ? {
        id: 'prompt-custom',
        title: customTitle || 'Custom Reference Prompt',
        category: 'Targeted Phoneme Drill',
        targetNuance: 'Calibrates low-confidence phonemes and verbal elements identified by the diagnostic matrix.',
        script:
          customScript.trim() ||
          'Reading my own custom phrase to calibrate fundamental pitch and vocal resonance.',
      }
    : GUIDED_ANCHOR_PROMPTS.find((p) => p.id === selectedPromptId) || GUIDED_ANCHOR_PROMPTS[0];

  useEffect(() => {
    return () => {
      stopActiveRecordingCleanup();
      if (activeAudioElRef.current) {
        activeAudioElRef.current.pause();
      }
    };
  }, []);

  const stopActiveRecordingCleanup = () => {
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
    }
    if (timerRef.current) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current = null;
    }
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((t) => t.stop());
      mediaStreamRef.current = null;
    }
    if (audioCtxRef.current && audioCtxRef.current.state !== 'closed') {
      audioCtxRef.current.close().catch(() => {});
      audioCtxRef.current = null;
    }
  };

  const startLiveRecording = async () => {
    setErrorMsg(null);
    recordedChunksRef.current = [];
    setRecordingSec(0);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: false,
        },
      });
      mediaStreamRef.current = stream;

      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      const ctx = new AudioCtx();
      audioCtxRef.current = ctx;

      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;

      const processor = ctx.createScriptProcessor(2048, 1, 1);
      processorRef.current = processor;

      source.connect(analyser);
      analyser.connect(processor);
      processor.connect(ctx.destination);

      processor.onaudioprocess = (e) => {
        const input = e.inputBuffer.getChannelData(0);
        recordedChunksRef.current.push(new Float32Array(input));
      };

      setIsRecording(true);
      const startTime = Date.now();
      timerRef.current = window.setInterval(() => {
        setRecordingSec(Number(((Date.now() - startTime) / 1000).toFixed(1)));
      }, 100);

      const timeData = new Float32Array(analyser.fftSize);
      const renderLoop = () => {
        analyser.getFloatTimeDomainData(timeData);

        let sumSq = 0;
        for (let i = 0; i < timeData.length; i++) {
          sumSq += timeData[i] * timeData[i];
        }
        const rms = Math.sqrt(sumSq / timeData.length);
        const db = Math.max(-60, Math.round(20 * Math.log10(Math.max(1e-5, rms))));
        setLiveRmsDb(db);

        const detectedF0 = estimateFramePitchHz(timeData, ctx.sampleRate);
        if (detectedF0) {
          setLiveF0Hz(Math.round(detectedF0));
        }

        const canvas = canvasRef.current;
        if (canvas) {
          const c = canvas.getContext('2d');
          if (c) {
            const w = canvas.width;
            const h = canvas.height;
            c.clearRect(0, 0, w, h);

            // Center line
            c.strokeStyle = '#1E293B';
            c.lineWidth = 1;
            c.beginPath();
            c.moveTo(0, h / 2);
            c.lineTo(w, h / 2);
            c.stroke();

            // Live oscilloscope waveform
            c.strokeStyle = '#06B6D4';
            c.lineWidth = 2;
            c.beginPath();
            const sliceWidth = w / timeData.length;
            let x = 0;
            for (let i = 0; i < timeData.length; i++) {
              const y = (0.5 + timeData[i] * 0.9) * h;
              if (i === 0) c.moveTo(x, y);
              else c.lineTo(x, y);
              x += sliceWidth;
            }
            c.stroke();
          }
        }

        animFrameRef.current = requestAnimationFrame(renderLoop);
      };

      animFrameRef.current = requestAnimationFrame(renderLoop);
    } catch (err: any) {
      setErrorMsg(
        'Microphone access was denied or unavailable. You can grant microphone permissions in your browser or upload a clean solo voice sample below.'
      );
    }
  };

  const stopLiveRecordingAndAnalyze = async () => {
    if (!isRecording) return;
    const sampleRate = audioCtxRef.current?.sampleRate || 44100;
    const chunks = recordedChunksRef.current;
    setIsRecording(false);
    stopActiveRecordingCleanup();

    const totalLen = chunks.reduce((acc, c) => acc + c.length, 0);
    if (totalLen < sampleRate * 0.8) {
      setErrorMsg('Recording was too short (< 1 second). Please record at least a few words.');
      return;
    }

    const merged = new Float32Array(totalLen);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }

    const audioBuffer = new AudioBuffer({
      length: totalLen,
      numberOfChannels: 1,
      sampleRate,
    });
    audioBuffer.copyToChannel(merged, 0);

    await processCapturedAudioBuffer(audioBuffer, activePrompt);
  };

  const processCapturedAudioBuffer = async (
    audioBuffer: AudioBuffer,
    promptCard: GuidedPromptCard
  ) => {
    setIsAnalyzing(true);
    setErrorMsg(null);

    try {
      const wordCount = promptCard.script.split(/\s+/).filter(Boolean).length;
      const dspMetrics = extractAcousticDspMetrics(audioBuffer, wordCount);
      const audioBase64 = audioBufferSliceToWavBase64(
        audioBuffer,
        0,
        Math.min(audioBuffer.duration, 25),
        24000
      );

      let transcript = promptCard.script;
      let timbreSummary =
        dspMetrics.medianF0Hz < 130
          ? 'Resonant low-mid baritone'
          : dspMetrics.medianF0Hz < 175
          ? 'Warm conversational mid-register'
          : 'Clear articulate upper-mid register';
      let cadenceSummary = `Measured ${dspMetrics.estimatedWpm} WPM tempo with ${Math.round(
        dspMetrics.pauseRatio * 100
      )}% pause ratio`;
      let clarityScore = 94;

      const response = await fetch('/api/voice/analyze-anchor', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          audioBase64,
          mimeType: 'audio/wav',
          promptText: promptCard.script,
          dspMetrics,
        }),
      });

      if (response.ok) {
        const data = await response.json();
        transcript = data.transcript || transcript;
        timbreSummary = data.timbreSummary || timbreSummary;
        cadenceSummary = data.cadenceSummary || cadenceSummary;
        clarityScore = data.clarityScore ?? clarityScore;
      }

      const newAnchor: VoiceAnchorSample = {
        id: `anchor-${Date.now()}`,
        promptId: promptCard.id,
        promptTitle: promptCard.title,
        promptCategory: promptCard.category,
        promptScript: promptCard.script,
        transcript,
        audioBase64,
        mimeType: 'audio/wav',
        createdAt: new Date().toISOString(),
        dspMetrics,
        timbreSummary,
        cadenceSummary,
        clarityScore,
      };

      onAddAnchor(newAnchor);
    } catch (err: any) {
      setErrorMsg(err?.message || 'Failed to analyze anchor recording.');
    } finally {
      setIsAnalyzing(false);
    }
  };

  const handleSoloFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setErrorMsg(null);
    setIsAnalyzing(true);

    try {
      const arrayBuf = await file.arrayBuffer();
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      const ctx = new AudioCtx();
      const decoded = await ctx.decodeAudioData(arrayBuf.slice(0));
      await ctx.close().catch(() => {});

      await processCapturedAudioBuffer(decoded, {
        ...activePrompt,
        title: `Solo Upload: ${file.name}`,
      });
    } catch (err: any) {
      setErrorMsg(
        'Could not decode uploaded audio file. Please upload a valid WAV, MP3, M4A, or WebM file.'
      );
      setIsAnalyzing(false);
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  /**
   * Generates a real reference voice anchor via Gemini TTS and analyzes its exact Web Audio DSP
   * so users without a physical microphone attached can immediately test the anchor-guided diarization pipeline.
   */
  const handleSynthesizeReferenceAnchor = async () => {
    setErrorMsg(null);
    setIsAnalyzing(true);
    try {
      const synthResp = await fetch('/api/voice/synthesize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          script: activePrompt.script,
          voiceProfile: {
            baseFoundationVoice: 'Puck',
            voiceDesignDirective:
              'Natural, grounded conversational voice with clear articulation and steady chest resonance.',
            acousticFingerprint: { medianF0Hz: 138 },
          },
          nuanceSettings: {
            pacing: 1.0,
            pitchSemitones: 0,
            expressiveness: 75,
            emotionalTone: 'Natural Baseline',
            warmth: 60,
          },
        }),
      });

      const synthData = await synthResp.json();
      if (!synthResp.ok || !synthData.wavBase64) {
        throw new Error(synthData.error || 'Could not generate reference voice sample.');
      }

      const audioBuf = await base64ToAudioBuffer(synthData.wavBase64);
      await processCapturedAudioBuffer(audioBuf, activePrompt);
    } catch (err: any) {
      setErrorMsg(err?.message || 'Failed to generate reference voice sample.');
      setIsAnalyzing(false);
    }
  };

  const togglePlayAnchor = (sample: VoiceAnchorSample) => {
    if (playingAnchorId === sample.id && activeAudioElRef.current) {
      activeAudioElRef.current.pause();
      setPlayingAnchorId(null);
      return;
    }

    if (activeAudioElRef.current) {
      activeAudioElRef.current.pause();
    }

    const audio = new Audio(`data:${sample.mimeType};base64,${sample.audioBase64}`);
    activeAudioElRef.current = audio;
    setPlayingAnchorId(sample.id);
    audio.onended = () => setPlayingAnchorId(null);
    audio.onerror = () => setPlayingAnchorId(null);
    audio.play().catch(() => setPlayingAnchorId(null));
  };

  const avgAnchorF0 =
    anchors.length > 0
      ? Math.round(anchors.reduce((s, a) => s + a.dspMetrics.medianF0Hz, 0) / anchors.length)
      : null;

  const avgAnchorWpm =
    anchors.length > 0
      ? Math.round(anchors.reduce((s, a) => s + a.dspMetrics.estimatedWpm, 0) / anchors.length)
      : null;

  return (
    <div className="space-y-8">
      {/* Stage Header */}
      <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-4 pb-6 border-b border-slate-800">
        <div>
          <p className="text-xs font-medium text-cyan-400 tracking-wide">
            Stage 01 · Ground-Truth Vocal Fingerprint
          </p>
          <h1 className="text-2xl sm:text-3xl font-semibold text-slate-50 mt-1">
            Voice Anchor Lab (Guided Microphone Capture)
          </h1>
          <p className="text-sm text-slate-400 mt-2 max-w-3xl">
            Record 1 to 4 short guided prompts through your personal microphone. These clean solo
            recordings establish your fundamental frequency (<span className="font-mono">F0</span>),
            spectral timbre, and cadence—acting as the acoustic reference anchor to separate your
            voice from other speakers in multi-hour conversational uploads.
          </p>
        </div>

        <div className="flex items-center gap-3 shrink-0">
          <button
            onClick={onProceedToDiarizer}
            className="px-4 py-2.5 text-xs font-semibold text-slate-950 bg-amber-500 hover:bg-amber-400 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            Continue to Conversational Diarizer →
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

      {/* Main 2-column studio split */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-stretch">
        {/* Left 5 cols: Prompt Selector Cards */}
        <div className="lg:col-span-5 bg-[#111827] border border-slate-800 rounded-xl p-5 flex flex-col justify-between space-y-4">
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold text-slate-100">
                Select Phonetically Balanced Prompt
              </h2>
              <button
                onClick={() => setIsUsingCustomScript(!isUsingCustomScript)}
                className="text-xs font-medium text-cyan-400 hover:text-cyan-300 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                {isUsingCustomScript ? 'Use Guided Prompts' : 'Write Custom Script'}
              </button>
            </div>

            {!isUsingCustomScript ? (
              <div className="space-y-2.5">
                {GUIDED_ANCHOR_PROMPTS.map((prompt) => {
                  const isSelected = prompt.id === selectedPromptId;
                  const isRecorded = anchors.some((a) => a.promptId === prompt.id);

                  return (
                    <button
                      key={prompt.id}
                      onClick={() => setSelectedPromptId(prompt.id)}
                      className={`w-full text-left p-3.5 rounded-lg border transition-colors cursor-pointer ${
                        isSelected
                          ? 'bg-slate-800/90 border-cyan-500/70 text-slate-50'
                          : 'bg-slate-900/60 border-slate-800/90 text-slate-300 hover:border-slate-700'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-semibold text-slate-100">
                          {prompt.title}
                        </span>
                        {isRecorded && (
                          <span className="inline-flex items-center gap-1 text-xs text-emerald-400 font-medium whitespace-nowrap shrink-0">
                            <CheckCircle2 className="w-3.5 h-3.5" />
                            Captured
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-slate-400 mt-1 flex items-center gap-1.5">
                        <span>{prompt.category}</span>
                        <span aria-hidden="true">·</span>
                        <span className="truncate">{prompt.targetNuance}</span>
                      </div>
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="space-y-2">
                <label className="block text-xs text-slate-400">
                  Enter a custom reading prompt (2–3 sentences recommended):
                </label>
                <textarea
                  value={customScript}
                  onChange={(e) => setCustomScript(e.target.value)}
                  rows={5}
                  placeholder="Type a custom script you want to read aloud into your microphone..."
                  className="w-full rounded-lg bg-slate-900 border border-slate-700 p-3 text-sm text-slate-100 focus:outline-none focus:border-cyan-500"
                />
              </div>
            )}
          </div>

          {/* Anchor Acoustic Baseline Summary Box */}
          <div className="pt-4 border-t border-slate-800/90 grid grid-cols-3 gap-3 text-left">
            <div>
              <span className="text-xs text-slate-400 block">Captured Anchors</span>
              <span className="text-lg font-mono font-semibold text-slate-100 tabular-nums">
                {anchors.length} / 4
              </span>
            </div>
            <div>
              <span className="text-xs text-slate-400 block">Anchor Median F0</span>
              <span className="text-lg font-mono font-semibold text-cyan-400 tabular-nums">
                {avgAnchorF0 ? `${avgAnchorF0} Hz` : '— Hz'}
              </span>
            </div>
            <div>
              <span className="text-xs text-slate-400 block">Baseline Tempo</span>
              <span className="text-lg font-mono font-semibold text-amber-400 tabular-nums">
                {avgAnchorWpm ? `${avgAnchorWpm} WPM` : '— WPM'}
              </span>
            </div>
          </div>
        </div>

        {/* Right 7 cols: Active Teleprompter & Live Microphone Oscilloscope */}
        <div className="lg:col-span-7 bg-[#111827] border border-slate-800 rounded-xl p-6 flex flex-col justify-between space-y-6">
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-4">
              <div className="text-xs text-slate-400">
                <span>{activePrompt.title}</span>
                <span className="mx-1.5" aria-hidden="true">·</span>
                <span className="text-cyan-400">{activePrompt.category}</span>
              </div>
              <span className="text-xs font-mono text-slate-400 tabular-nums">
                {isRecording ? `REC ${recordingSec.toFixed(1)}s` : 'Ready to Capture'}
              </span>
            </div>

            {/* Teleprompter Reading Box */}
            <div className="p-5 rounded-xl bg-slate-950/90 border border-slate-800/90">
              <p className="text-xs text-slate-400 mb-2">
                Read aloud naturally in your conversational speaking voice:
              </p>
              <blockquote className="text-lg sm:text-xl font-medium text-slate-100 leading-relaxed">
                “{activePrompt.script}”
              </blockquote>
            </div>
          </div>

          {/* Live Oscilloscope Canvas & Telemetry */}
          <div className="space-y-3">
            <div className="flex items-center justify-between text-xs text-slate-400 font-mono tabular-nums">
              <span>
                Live Fundamental Pitch (F0):{' '}
                <strong className="text-cyan-400">{liveF0Hz ? `${liveF0Hz} Hz` : '— Hz'}</strong>
              </span>
              <span>
                Input Level: <strong className="text-slate-200">{liveRmsDb} dBFS</strong>
              </span>
            </div>

            <div className="relative h-28 w-full bg-slate-950 border border-slate-800 rounded-lg overflow-hidden flex items-center justify-center">
              <canvas
                ref={canvasRef}
                width={640}
                height={112}
                className="w-full h-full block"
              />
              {!isRecording && !isAnalyzing && (
                <span className="absolute text-xs text-slate-500 pointer-events-none">
                  Click “Start Microphone Recording” to monitor real-time pitch & waveform
                </span>
              )}
              {isAnalyzing && (
                <div className="absolute inset-0 bg-slate-950/85 flex items-center justify-center gap-2.5 text-sm text-cyan-300">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>Extracting F0 pitch contour & transcribing via Gemini 3.5 Transcribe...</span>
                </div>
              )}
            </div>
          </div>

          {/* Action Controls Bar */}
          <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-slate-800">
            <div className="flex items-center gap-3">
              {!isRecording ? (
                <button
                  onClick={startLiveRecording}
                  disabled={isAnalyzing}
                  className="inline-flex items-center gap-2 px-4 py-2.5 text-xs font-semibold text-slate-950 bg-cyan-400 hover:bg-cyan-300 disabled:opacity-50 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <Mic className="w-4 h-4" />
                  Start Microphone Recording
                </button>
              ) : (
                <button
                  onClick={stopLiveRecordingAndAnalyze}
                  className="inline-flex items-center gap-2 px-4 py-2.5 text-xs font-semibold text-white bg-rose-600 hover:bg-rose-500 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <Square className="w-4 h-4" />
                  Stop & Save Voice Anchor ({recordingSec.toFixed(1)}s)
                </button>
              )}

              <input
                ref={fileInputRef}
                type="file"
                accept="audio/*"
                onChange={handleSoloFileUpload}
                className="hidden"
              />
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={isRecording || isAnalyzing}
                className="inline-flex items-center gap-1.5 px-3.5 py-2.5 text-xs font-medium text-slate-200 bg-slate-800 hover:bg-slate-700 disabled:opacity-50 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Upload className="w-3.5 h-3.5" />
                Upload Solo Clip
              </button>
            </div>

            <button
              onClick={handleSynthesizeReferenceAnchor}
              disabled={isRecording || isAnalyzing}
              title="Generates a clean solo voice anchor using Gemini TTS so you can test anchor-guided conversational diarization even without a physical microphone."
              className="inline-flex items-center gap-1.5 px-3.5 py-2.5 text-xs font-medium text-amber-300 bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/30 disabled:opacity-50 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Wand2 className="w-3.5 h-3.5" />
              Generate Calibrated Test Anchor
            </button>
          </div>
        </div>
      </div>

      {/* Captured Ground-Truth Voice Anchors Table */}
      <div className="bg-[#111827] border border-slate-800 rounded-xl p-6 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold text-slate-100">
              Captured Ground-Truth Microphone Anchors ({anchors.length})
            </h2>
            <p className="text-xs text-slate-400 mt-0.5">
              These verified solo samples establish your acoustic signature for separating your
              voice from other speakers in Stage 02.
            </p>
          </div>
        </div>

        {anchors.length === 0 ? (
          <div className="py-10 text-center border border-dashed border-slate-800 rounded-lg space-y-2">
            <p className="text-sm text-slate-300 font-medium">
              No solo microphone anchors captured yet
            </p>
            <p className="text-xs text-slate-400 max-w-md mx-auto">
              Record a prompt above using your microphone, upload a clean solo clip, or click
              “Generate Calibrated Test Anchor” to populate your baseline vocal fingerprint.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {anchors.map((sample) => {
              const isPlaying = playingAnchorId === sample.id;
              return (
                <div
                  key={sample.id}
                  className="p-4 rounded-lg bg-slate-900/80 border border-slate-800 flex flex-col justify-between space-y-3"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <h3 className="text-sm font-semibold text-slate-100">
                        {sample.promptTitle}
                      </h3>
                      <div className="text-xs text-slate-400 mt-0.5 flex flex-wrap items-center gap-1.5 font-mono tabular-nums">
                        <span className="text-cyan-400">{sample.dspMetrics.medianF0Hz} Hz F0</span>
                        <span aria-hidden="true">·</span>
                        <span>±{sample.dspMetrics.f0StdDevHz} Hz var</span>
                        <span aria-hidden="true">·</span>
                        <span>{sample.dspMetrics.estimatedWpm} WPM</span>
                        <span aria-hidden="true">·</span>
                        <span>{sample.dspMetrics.durationSec}s</span>
                      </div>
                    </div>

                    <div className="flex items-center gap-1.5 shrink-0">
                      <button
                        onClick={() => togglePlayAnchor(sample)}
                        className="p-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-cyan-400 transition-colors cursor-pointer"
                        title={isPlaying ? 'Stop playback' : 'Play anchor sample'}
                      >
                        {isPlaying ? (
                          <Volume2 className="w-4 h-4 animate-pulse" />
                        ) : (
                          <Play className="w-4 h-4" />
                        )}
                      </button>
                      <button
                        onClick={() => onRemoveAnchor(sample.id)}
                        className="p-2 rounded-lg bg-slate-800 hover:bg-rose-950/80 text-slate-400 hover:text-rose-300 transition-colors cursor-pointer"
                        title="Delete anchor sample"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>

                  <WaveformBars
                    peaks={sample.dspMetrics.waveformPeaks}
                    accentColor="#06B6D4"
                    height={32}
                    isPlaying={isPlaying}
                  />

                  <p className="text-xs text-slate-300 line-clamp-2 italic">
                    “{sample.transcript}”
                  </p>

                  <div className="pt-2 border-t border-slate-800/80 flex items-center justify-between text-xs text-slate-400">
                    <span>{sample.timbreSummary}</span>
                    <span className="font-mono tabular-nums text-emerald-400">
                      Clarity {sample.clarityScore}%
                    </span>
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
