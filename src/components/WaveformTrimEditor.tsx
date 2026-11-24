import React, { useEffect, useRef, useState } from 'react';
import {
  Check,
  Download,
  Loader2,
  Play,
  RotateCcw,
  Scissors,
  Sparkles,
  Square,
} from 'lucide-react';
import { SynthesisTake } from '../types/voice';
import {
  cropWavBase64,
  detectSilenceTrimBounds,
  downloadWavFile,
  exportWavAtSampleRate,
  extractHighResWaveformPeaks,
} from '../utils/audioDsp';

interface WaveformTrimEditorProps {
  take: SynthesisTake;
  takeNumber: number;
  exportSampleRate: 24000 | 44100 | 48000;
  exportFilePrefix: string;
  onApplyTrimToTake: (takeId: string, patch: Partial<SynthesisTake>) => void;
  onClose: () => void;
}

export const WaveformTrimEditor: React.FC<WaveformTrimEditorProps> = ({
  take,
  takeNumber,
  exportSampleRate,
  exportFilePrefix,
  onApplyTrimToTake,
  onClose,
}) => {
  // Always edit against the original untrimmed buffer if available so the user can widen or readjust handles non-destructively
  const sourceCalibratedWav =
    take.originalCalibratedWavBase64 || take.calibratedWavBase64;
  const sourceRawWav = take.originalRawWavBase64 || take.rawWavBase64;

  const [highResPeaks, setHighResPeaks] = useState<number[]>(take.waveformPeaks);
  const [sourceDurationSec, setSourceDurationSec] = useState<number>(
    take.originalDurationSec || take.durationSec || 1.0
  );
  const [trimStartSec, setTrimStartSec] = useState<number>(
    take.lastTrimStartSec ?? 0
  );
  const [trimEndSec, setTrimEndSec] = useState<number>(
    take.lastTrimEndSec ?? (take.originalDurationSec || take.durationSec || 1.0)
  );
  const [applyMicroFade, setApplyMicroFade] = useState<boolean>(true);

  const [draggingHandle, setDraggingHandle] = useState<'start' | 'end' | null>(null);
  const [isAuditioning, setIsAuditioning] = useState<boolean>(false);
  const [playheadSec, setPlayheadSec] = useState<number | null>(null);
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [statusBanner, setStatusBanner] = useState<string | null>(null);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const animRef = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    extractHighResWaveformPeaks(sourceCalibratedWav, 160)
      .then((res) => {
        if (cancelled) return;
        setHighResPeaks(res.peaks);
        setSourceDurationSec(res.durationSec);
        setTrimStartSec((prev) =>
          take.lastTrimStartSec !== undefined
            ? Math.min(take.lastTrimStartSec, Math.max(0, res.durationSec - 0.15))
            : Math.min(prev, Math.max(0, res.durationSec - 0.15))
        );
        setTrimEndSec(() =>
          take.lastTrimEndSec !== undefined && take.lastTrimEndSec <= res.durationSec
            ? Math.max(0.15, take.lastTrimEndSec)
            : res.durationSec
        );
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      stopAuditionPlayback();
    };
  }, [sourceCalibratedWav]);

  const stopAuditionPlayback = () => {
    if (animRef.current) {
      cancelAnimationFrame(animRef.current);
      animRef.current = null;
    }
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    setIsAuditioning(false);
    setPlayheadSec(null);
  };

  // Draw the visual waveform editor canvas with shaded trim zones, handles, and playhead
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const width = canvas.width;
    const height = canvas.height;
    ctx.clearRect(0, 0, width, height);

    const safeDuration = Math.max(0.1, sourceDurationSec);
    const startRatio = Math.max(0, Math.min(1, trimStartSec / safeDuration));
    const endRatio = Math.max(startRatio, Math.min(1, trimEndSec / safeDuration));

    const startX = startRatio * width;
    const endX = endRatio * width;

    // Background grid & center zero-crossing line
    ctx.fillStyle = '#090D16';
    ctx.fillRect(0, 0, width, height);

    ctx.strokeStyle = '#1E293B';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, height / 2);
    ctx.lineTo(width, height / 2);
    ctx.stroke();

    // Subtle time grid ticks every 10%
    ctx.strokeStyle = 'rgba(30, 41, 59, 0.55)';
    for (let i = 1; i < 10; i++) {
      const gx = (width / 10) * i;
      ctx.beginPath();
      ctx.moveTo(gx, 0);
      ctx.lineTo(gx, height);
      ctx.stroke();
    }

    // Active cropped window highlight backdrop
    ctx.fillStyle = 'rgba(245, 158, 11, 0.08)';
    ctx.fillRect(startX, 0, Math.max(2, endX - startX), height);

    // Draw high-resolution waveform bars
    const peaks = highResPeaks.length > 0 ? highResPeaks : [0.3, 0.5, 0.4];
    const barSlotWidth = width / peaks.length;
    const barWidth = Math.max(1.5, barSlotWidth * 0.68);

    for (let i = 0; i < peaks.length; i++) {
      const barCenterX = (i + 0.5) * barSlotWidth;
      const barRatio = barCenterX / width;
      const isInsideCrop = barRatio >= startRatio && barRatio <= endRatio;
      const peakVal = Math.max(0.05, Math.min(1, peaks[i]));
      const barHeight = peakVal * (height * 0.78);
      const y = (height - barHeight) / 2;

      if (!isInsideCrop) {
        ctx.fillStyle = 'rgba(100, 116, 139, 0.28)';
      } else if (
        playheadSec !== null &&
        barRatio <= playheadSec / safeDuration
      ) {
        ctx.fillStyle = '#38BDF8';
      } else {
        ctx.fillStyle = '#F59E0B';
      }

      ctx.beginPath();
      ctx.roundRect(barCenterX - barWidth / 2, y, barWidth, barHeight, 1.5);
      ctx.fill();
    }

    // Shaded trimmed-out head & tail overlays
    ctx.fillStyle = 'rgba(2, 6, 23, 0.68)';
    if (startX > 0) {
      ctx.fillRect(0, 0, startX, height);
    }
    if (endX < width) {
      ctx.fillRect(endX, 0, width - endX, height);
    }

    // Top and bottom crop region border lines
    ctx.strokeStyle = 'rgba(245, 158, 11, 0.55)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(startX, 1);
    ctx.lineTo(endX, 1);
    ctx.moveTo(startX, height - 1);
    ctx.lineTo(endX, height - 1);
    ctx.stroke();

    // Left Trim Handle (In-Point)
    ctx.fillStyle = '#06B6D4';
    ctx.fillRect(Math.max(0, startX - 2), 0, 4, height);
    // Top & bottom grip tabs for Left Handle
    ctx.beginPath();
    ctx.roundRect(Math.max(0, startX - 1), 4, 14, 22, 3);
    ctx.fill();
    ctx.fillStyle = '#020617';
    ctx.font = 'bold 9px "JetBrains Mono", monospace';
    ctx.fillText('IN', Math.max(2, startX + 1), 18);

    // Right Trim Handle (Out-Point)
    ctx.fillStyle = '#F59E0B';
    ctx.fillRect(Math.min(width - 4, endX - 2), 0, 4, height);
    // Top grip tab for Right Handle
    ctx.beginPath();
    ctx.roundRect(Math.min(width - 22, endX - 21), 4, 22, 22, 3);
    ctx.fill();
    ctx.fillStyle = '#020617';
    ctx.font = 'bold 9px "JetBrains Mono", monospace';
    ctx.fillText('OUT', Math.min(width - 20, endX - 19), 18);

    // Animated Playhead Cursor during audition
    if (playheadSec !== null) {
      const playX = Math.max(startX, Math.min(endX, (playheadSec / safeDuration) * width));
      ctx.strokeStyle = '#F8FAFC';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(playX, 0);
      ctx.lineTo(playX, height);
      ctx.stroke();
    }
  }, [highResPeaks, sourceDurationSec, trimStartSec, trimEndSec, playheadSec]);

  // Pointer drag interaction on the waveform canvas
  const clientXToSeconds = (clientX: number): number => {
    const el = canvasRef.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width)));
    return Number((ratio * sourceDurationSec).toFixed(2));
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const el = canvasRef.current;
    if (!el) return;
    el.setPointerCapture(e.pointerId);

    const clickedSec = clientXToSeconds(e.clientX);
    const distToStart = Math.abs(clickedSec - trimStartSec);
    const distToEnd = Math.abs(clickedSec - trimEndSec);

    if (distToStart <= distToEnd) {
      setDraggingHandle('start');
      setTrimStartSec(Math.max(0, Math.min(clickedSec, trimEndSec - 0.15)));
    } else {
      setDraggingHandle('end');
      setTrimEndSec(Math.min(sourceDurationSec, Math.max(clickedSec, trimStartSec + 0.15)));
    }
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!draggingHandle) return;
    const sec = clientXToSeconds(e.clientX);
    if (draggingHandle === 'start') {
      setTrimStartSec(
        Number(Math.max(0, Math.min(sec, trimEndSec - 0.15)).toFixed(2))
      );
    } else {
      setTrimEndSec(
        Number(
          Math.min(sourceDurationSec, Math.max(sec, trimStartSec + 0.15)).toFixed(2)
        )
      );
    }
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (draggingHandle) {
      setDraggingHandle(null);
      try {
        canvasRef.current?.releasePointerCapture(e.pointerId);
      } catch {}
    }
  };

  const handleAutoTrimSilence = async () => {
    setIsProcessing(true);
    setStatusBanner(null);
    try {
      const bounds = await detectSilenceTrimBounds(sourceCalibratedWav);
      setTrimStartSec(bounds.trimStartSec);
      setTrimEndSec(bounds.trimEndSec);
      const removedSec = Number(
        Math.max(0, bounds.durationSec - (bounds.trimEndSec - bounds.trimStartSec)).toFixed(2)
      );
      setStatusBanner(
        `Auto-detected speech bounds: ${bounds.trimStartSec.toFixed(2)}s to ${bounds.trimEndSec.toFixed(
          2
        )}s (${removedSec}s leading/trailing silence trimmed).`
      );
    } catch {
      setStatusBanner('Could not auto-detect silence boundaries.');
    } finally {
      setIsProcessing(false);
    }
  };

  const handleAuditionTrimmedRegion = async () => {
    if (isAuditioning) {
      stopAuditionPlayback();
      return;
    }

    setIsProcessing(true);
    try {
      const cropped = await cropWavBase64(
        sourceCalibratedWav,
        trimStartSec,
        trimEndSec,
        applyMicroFade
      );
      const audio = new Audio(`data:audio/wav;base64,${cropped.croppedWavBase64}`);
      audioRef.current = audio;
      setIsAuditioning(true);
      setPlayheadSec(trimStartSec);

      const updatePlayhead = () => {
        if (!audioRef.current || audioRef.current.paused) return;
        setPlayheadSec(
          Math.min(trimEndSec, trimStartSec + audioRef.current.currentTime)
        );
        animRef.current = requestAnimationFrame(updatePlayhead);
      };

      audio.onplay = () => {
        animRef.current = requestAnimationFrame(updatePlayhead);
      };
      audio.onended = () => {
        stopAuditionPlayback();
      };
      audio.onerror = () => {
        stopAuditionPlayback();
      };

      await audio.play();
    } catch {
      stopAuditionPlayback();
    } finally {
      setIsProcessing(false);
    }
  };

  const handleCommitCropToTake = async () => {
    setIsProcessing(true);
    setStatusBanner(null);
    stopAuditionPlayback();

    try {
      const [croppedCalibrated, croppedRaw] = await Promise.all([
        cropWavBase64(sourceCalibratedWav, trimStartSec, trimEndSec, applyMicroFade),
        cropWavBase64(sourceRawWav, trimStartSec, trimEndSec, applyMicroFade),
      ]);

      onApplyTrimToTake(take.id, {
        originalCalibratedWavBase64: sourceCalibratedWav,
        originalRawWavBase64: sourceRawWav,
        originalDurationSec: sourceDurationSec,
        calibratedWavBase64: croppedCalibrated.croppedWavBase64,
        rawWavBase64: croppedRaw.croppedWavBase64,
        durationSec: croppedCalibrated.durationSec,
        waveformPeaks: croppedCalibrated.waveformPeaks,
        lastTrimStartSec: trimStartSec,
        lastTrimEndSec: trimEndSec,
        isTrimmed:
          trimStartSec > 0.01 || trimEndSec < sourceDurationSec - 0.01,
      });

      setStatusBanner(
        `Applied crop (${trimStartSec.toFixed(2)}s – ${trimEndSec.toFixed(
          2
        )}s, new duration ${croppedCalibrated.durationSec}s) to Take #${takeNumber}.`
      );
    } catch {
      setStatusBanner('Failed to apply crop to audio take.');
    } finally {
      setIsProcessing(false);
    }
  };

  const handleRestoreFullUntrimmedTake = async () => {
    setIsProcessing(true);
    stopAuditionPlayback();
    try {
      setTrimStartSec(0);
      setTrimEndSec(sourceDurationSec);
      const restored = await cropWavBase64(
        sourceCalibratedWav,
        0,
        sourceDurationSec,
        false
      );
      onApplyTrimToTake(take.id, {
        calibratedWavBase64: sourceCalibratedWav,
        rawWavBase64: sourceRawWav,
        durationSec: sourceDurationSec,
        waveformPeaks: restored.waveformPeaks,
        lastTrimStartSec: 0,
        lastTrimEndSec: sourceDurationSec,
        isTrimmed: false,
      });
      setStatusBanner(`Restored original untrimmed duration (${sourceDurationSec}s).`);
    } finally {
      setIsProcessing(false);
    }
  };

  const handleDirectExportTrimmedWav = async () => {
    setIsProcessing(true);
    try {
      const cropped = await cropWavBase64(
        sourceCalibratedWav,
        trimStartSec,
        trimEndSec,
        applyMicroFade
      );
      const resampled = await exportWavAtSampleRate(
        cropped.croppedWavBase64,
        exportSampleRate
      );
      const rateLabel =
        exportSampleRate === 48000
          ? '48kHz'
          : exportSampleRate === 44100
          ? '44.1kHz'
          : '24kHz';
      const cleanPrefix =
        (exportFilePrefix || 'voxreplica_take')
          .toLowerCase()
          .replace(/[^a-z0-9_-]+/g, '_') || 'voxreplica_take';
      const filename = `${cleanPrefix}_${String(takeNumber).padStart(
        2,
        '0'
      )}_trimmed_${trimStartSec.toFixed(2)}s-${trimEndSec.toFixed(2)}s_${rateLabel}.wav`;
      downloadWavFile(resampled, filename);
      setStatusBanner(`Exported trimmed WAV "${filename}" (${cropped.durationSec}s) to local disk.`);
    } finally {
      setIsProcessing(false);
    }
  };

  const croppedDurationSec = Number(Math.max(0.1, trimEndSec - trimStartSec).toFixed(2));
  const trimmedOffSec = Number(Math.max(0, sourceDurationSec - croppedDurationSec).toFixed(2));

  return (
    <div
      ref={containerRef}
      className="mt-4 p-4 rounded-xl bg-slate-950/95 border border-amber-500/40 space-y-4"
    >
      {/* Editor Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-slate-800">
        <div className="flex items-center gap-2">
          <Scissors className="w-4 h-4 text-amber-400 shrink-0" />
          <div>
            <h3 className="text-xs font-semibold text-slate-100">
              Visual Waveform Trim & Crop Editor · Take #{takeNumber}
            </h3>
            <p className="text-xs text-slate-400">
              Drag the cyan <span className="font-mono text-cyan-400">IN</span> and amber{' '}
              <span className="font-mono text-amber-400">OUT</span> handles on the waveform or use
              precision timecode controls to crop before export.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={handleAutoTrimSilence}
            disabled={isProcessing}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-cyan-300 bg-cyan-500/10 hover:bg-cyan-500/20 border border-cyan-500/30 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Sparkles className="w-3.5 h-3.5" />
            Auto-Trim Leading/Trailing Silence
          </button>

          <button
            onClick={onClose}
            className="px-2.5 py-1.5 text-xs text-slate-400 hover:text-slate-200 bg-slate-900 hover:bg-slate-800 rounded-lg transition-colors cursor-pointer"
          >
            Close Editor
          </button>
        </div>
      </div>

      {/* Telemetry Readout Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 text-xs font-mono tabular-nums">
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-cyan-400">
            IN (Start): <strong>{trimStartSec.toFixed(2)}s</strong>
          </span>
          <span className="text-slate-600" aria-hidden="true">·</span>
          <span className="text-amber-400">
            OUT (End): <strong>{trimEndSec.toFixed(2)}s</strong>
          </span>
          <span className="text-slate-600" aria-hidden="true">·</span>
          <span className="text-emerald-400">
            Cropped Duration: <strong>{croppedDurationSec.toFixed(2)}s</strong>
          </span>
          <span className="text-slate-600" aria-hidden="true">·</span>
          <span className="text-slate-400">
            Removed: {trimmedOffSec.toFixed(2)}s (of {sourceDurationSec.toFixed(2)}s)
          </span>
        </div>

        <label className="inline-flex items-center gap-1.5 text-xs font-sans text-slate-300 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={applyMicroFade}
            onChange={(e) => setApplyMicroFade(e.target.checked)}
            className="rounded border-slate-700 bg-slate-900 text-amber-500 focus:ring-0"
          />
          <span>15ms De-Click Micro-Fade In/Out</span>
        </label>
      </div>

      {/* Interactive High-Resolution Waveform Canvas */}
      <div className="space-y-1.5">
        <div className="relative w-full h-32 rounded-lg overflow-hidden border border-slate-800 bg-[#090D16] select-none">
          <canvas
            ref={canvasRef}
            width={880}
            height={128}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            className="w-full h-full block cursor-ew-resize touch-none"
          />
        </div>

        {/* Ruler Timecodes */}
        <div className="flex items-center justify-between text-[11px] font-mono tabular-nums text-slate-500 px-1">
          <span>0.00s</span>
          <span>{(sourceDurationSec * 0.25).toFixed(2)}s</span>
          <span>{(sourceDurationSec * 0.5).toFixed(2)}s</span>
          <span>{(sourceDurationSec * 0.75).toFixed(2)}s</span>
          <span>{sourceDurationSec.toFixed(2)}s</span>
        </div>
      </div>

      {/* Precision Start / End Sliders & Nudge Controls */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 p-3.5 rounded-lg bg-slate-900/80 border border-slate-800">
        {/* In-Point Control */}
        <div className="space-y-2">
          <div className="flex items-center justify-between text-xs">
            <span className="text-cyan-400 font-medium">Trim Start (In-Point)</span>
            <div className="flex items-center gap-1 font-mono tabular-nums">
              <button
                onClick={() =>
                  setTrimStartSec((prev) =>
                    Number(Math.max(0, prev - 0.05).toFixed(2))
                  )
                }
                className="px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 cursor-pointer"
              >
                -50ms
              </button>
              <input
                type="number"
                min={0}
                max={Math.max(0, trimEndSec - 0.15)}
                step={0.05}
                value={trimStartSec}
                onChange={(e) => {
                  const val = Number(e.target.value);
                  if (!Number.isNaN(val)) {
                    setTrimStartSec(
                      Number(Math.max(0, Math.min(val, trimEndSec - 0.15)).toFixed(2))
                    );
                  }
                }}
                className="w-20 px-2 py-0.5 rounded bg-slate-950 border border-slate-700 text-center text-cyan-300"
              />
              <button
                onClick={() =>
                  setTrimStartSec((prev) =>
                    Number(Math.min(trimEndSec - 0.15, prev + 0.05).toFixed(2))
                  )
                }
                className="px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 cursor-pointer"
              >
                +50ms
              </button>
            </div>
          </div>
          <input
            type="range"
            min={0}
            max={sourceDurationSec}
            step={0.02}
            value={trimStartSec}
            onChange={(e) =>
              setTrimStartSec(
                Number(
                  Math.min(Number(e.target.value), trimEndSec - 0.15).toFixed(2)
                )
              )
            }
            className="w-full accent-cyan-400 cursor-pointer"
          />
        </div>

        {/* Out-Point Control */}
        <div className="space-y-2">
          <div className="flex items-center justify-between text-xs">
            <span className="text-amber-400 font-medium">Trim End (Out-Point)</span>
            <div className="flex items-center gap-1 font-mono tabular-nums">
              <button
                onClick={() =>
                  setTrimEndSec((prev) =>
                    Number(Math.max(trimStartSec + 0.15, prev - 0.05).toFixed(2))
                  )
                }
                className="px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 cursor-pointer"
              >
                -50ms
              </button>
              <input
                type="number"
                min={Math.min(sourceDurationSec, trimStartSec + 0.15)}
                max={sourceDurationSec}
                step={0.05}
                value={trimEndSec}
                onChange={(e) => {
                  const val = Number(e.target.value);
                  if (!Number.isNaN(val)) {
                    setTrimEndSec(
                      Number(
                        Math.min(
                          sourceDurationSec,
                          Math.max(val, trimStartSec + 0.15)
                        ).toFixed(2)
                      )
                    );
                  }
                }}
                className="w-20 px-2 py-0.5 rounded bg-slate-950 border border-slate-700 text-center text-amber-300"
              />
              <button
                onClick={() =>
                  setTrimEndSec((prev) =>
                    Number(Math.min(sourceDurationSec, prev + 0.05).toFixed(2))
                  )
                }
                className="px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 cursor-pointer"
              >
                +50ms
              </button>
            </div>
          </div>
          <input
            type="range"
            min={0}
            max={sourceDurationSec}
            step={0.02}
            value={trimEndSec}
            onChange={(e) =>
              setTrimEndSec(
                Number(
                  Math.max(Number(e.target.value), trimStartSec + 0.15).toFixed(2)
                )
              )
            }
            className="w-full accent-amber-400 cursor-pointer"
          />
        </div>
      </div>

      {statusBanner && (
        <div className="px-3.5 py-2.5 rounded-lg bg-emerald-950/60 border border-emerald-700/60 text-xs text-emerald-200 flex items-center justify-between gap-2">
          <span>{statusBanner}</span>
          <button
            onClick={() => setStatusBanner(null)}
            className="text-emerald-300 hover:text-white underline cursor-pointer"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Editor Action Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-slate-800">
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={handleAuditionTrimmedRegion}
            disabled={isProcessing}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-slate-100 bg-slate-800 hover:bg-slate-700 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            {isAuditioning ? (
              <>
                <Square className="w-3.5 h-3.5 text-amber-400" />
                Stop Preview
              </>
            ) : (
              <>
                <Play className="w-3.5 h-3.5 text-cyan-400" />
                Preview Cropped Region ({croppedDurationSec.toFixed(2)}s)
              </>
            )}
          </button>

          <button
            onClick={handleRestoreFullUntrimmedTake}
            disabled={isProcessing}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-300 bg-slate-900 hover:bg-slate-800 border border-slate-800 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            Reset Full Bounds (0.00s – {sourceDurationSec.toFixed(2)}s)
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={handleCommitCropToTake}
            disabled={isProcessing}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-slate-950 bg-amber-500 hover:bg-amber-400 disabled:opacity-50 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            {isProcessing ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Check className="w-3.5 h-3.5" />
            )}
            Apply Crop to Take
          </button>

          <button
            onClick={handleDirectExportTrimmedWav}
            disabled={isProcessing}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-slate-950 bg-cyan-400 hover:bg-cyan-300 disabled:opacity-50 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Download className="w-3.5 h-3.5" />
            Export Trimmed .WAV ({(exportSampleRate / 1000).toFixed(1)} kHz)
          </button>
        </div>
      </div>
    </div>
  );
};
