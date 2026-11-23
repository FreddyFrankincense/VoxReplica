import React, { useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  Loader2,
  Mic,
  Play,
  Volume2,
} from 'lucide-react';
import { LearnedCorpusDiagnostic } from '../utils/phonemeCoverage';
import {
  applyVocalDspCalibrationToWav,
  downloadWavFile,
} from '../utils/audioDsp';

interface LiveProfileAuditionBarProps {
  diagnostic: LearnedCorpusDiagnostic;
  onJumpToAnchorLab: (targetedScript?: string) => void;
}

export const LiveProfileAuditionBar: React.FC<LiveProfileAuditionBarProps> = ({
  diagnostic,
  onJumpToAnchorLab,
}) => {
  const [auditionText, setAuditionText] = useState<string>(
    '<breath> Testing my current learned vocal profile. |yeah| Notice how my pitch contour and pacing reflect the audio submitted so far.'
  );
  const [isSynthesizing, setIsSynthesizing] = useState<boolean>(false);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [lastWavBase64, setLastWavBase64] = useState<string | null>(null);
  const [floorAlertMsg, setFloorAlertMsg] = useState<string | null>(null);
  const [apiErrorMsg, setApiErrorMsg] = useState<string | null>(null);

  const audioRef = useRef<HTMLAudioElement | null>(null);

  const {
    meetsDataFloor,
    dataFloorSeconds,
    currentVerifiedSeconds,
    secondsShortfall,
    verifiedClipCount,
    overallConfidencePercent,
    liveLearnedProfile,
    lowestConfidenceElements,
  } = diagnostic;

  const floorProgressPct = Math.min(
    100,
    Math.round((currentVerifiedSeconds / dataFloorSeconds) * 100)
  );

  const lowestElement = lowestConfidenceElements[0] || null;

  const handleAuditionLearnedProfile = async () => {
    setApiErrorMsg(null);

    if ( isPlaying && audioRef.current ) {
      audioRef.current.pause();
      setIsPlaying(false);
      return;
    }

    // Enforce the acoustic data floor
    if (!meetsDataFloor) {
      const lowestHint = lowestElement
        ? ` The model especially lacks coverage for ${lowestElement.name} (${lowestElement.confidencePercent}% confidence).`
        : '';
      setFloorAlertMsg(
        `Insufficient Voice Profile Data: You have submitted ${currentVerifiedSeconds}s of verified audio across ${verifiedClipCount} clip(s), which is below the ${dataFloorSeconds.toFixed(
          1
        )}s minimum acoustic data floor (need ${secondsShortfall}s more clean audio).${lowestHint}`
      );
      return;
    }

    setFloorAlertMsg(null);
    setIsSynthesizing(true);

    try {
      const resp = await fetch('/api/voice/synthesize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          script:
            auditionText.trim() ||
            'Testing my current learned voice profile from submitted recordings.',
          voiceProfile: liveLearnedProfile,
          nuanceSettings: {
            pacing: 1.0,
            pitchSemitones: 0,
            expressiveness: 80,
            emotionalTone: 'Natural Baseline',
            warmth: 65,
            applyDspCalibration: true,
          },
        }),
      });

      const data = await resp.json();
      if (!resp.ok || !data.wavBase64) {
        throw new Error(data.error || 'Could not synthesize live audition audio.');
      }

      const calibrated = await applyVocalDspCalibrationToWav(data.wavBase64, {
        pitchSemitones: liveLearnedProfile.dspCalibration.pitchShiftSemitones,
        playbackRate: liveLearnedProfile.dspCalibration.playbackRate,
        formantWarmthDb: liveLearnedProfile.dspCalibration.formantWarmthDb,
      });

      setLastWavBase64(calibrated.calibratedWavBase64);

      if (audioRef.current) {
        audioRef.current.pause();
      }
      const audio = new Audio(
        `data:audio/wav;base64,${calibrated.calibratedWavBase64}`
      );
      audioRef.current = audio;
      setIsPlaying(true);
      audio.onended = () => setIsPlaying(false);
      audio.onerror = () => setIsPlaying(false);
      await audio.play();
    } catch (err: any) {
      setApiErrorMsg(err?.message || 'Error playing learned voice profile.');
      setIsPlaying(false);
    } finally {
      setIsSynthesizing(false);
    }
  };

  return (
    <section
      aria-label="Live Learned Voice Profile Audition Monitor"
      className="bg-[#111827] border border-slate-800 rounded-xl p-4 sm:p-5 space-y-4"
    >
      <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-4">
        {/* Left: Learned Profile Status & Data Floor Progress */}
        <div className="space-y-1.5">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="font-semibold text-slate-100">
              Always-On Learned Voice Playback Monitor
            </span>
            <span className="text-slate-600" aria-hidden="true">·</span>
            {meetsDataFloor ? (
              <span className="inline-flex items-center gap-1 text-emerald-400 font-medium">
                <CheckCircle2 className="w-3.5 h-3.5" />
                Data Floor Met ({currentVerifiedSeconds}s / {dataFloorSeconds}s min)
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 text-amber-400 font-medium">
                <AlertTriangle className="w-3.5 h-3.5" />
                Below Data Floor ({currentVerifiedSeconds}s / {dataFloorSeconds}s min required)
              </span>
            )}
            <span className="text-slate-600" aria-hidden="true">·</span>
            <span className="font-mono tabular-nums text-cyan-400">
              Learned F0: {liveLearnedProfile.acousticFingerprint.medianF0Hz} Hz
            </span>
            <span className="text-slate-600" aria-hidden="true">·</span>
            <span className="font-mono tabular-nums text-slate-300">
              {liveLearnedProfile.acousticFingerprint.avgWpm} WPM
            </span>
            <span className="text-slate-600" aria-hidden="true">·</span>
            <span className="font-mono tabular-nums text-amber-400">
              Model Confidence: {overallConfidencePercent}%
            </span>
          </div>

          {/* Data Floor Progress Bar */}
          <div className="flex items-center gap-3">
            <div className="w-48 sm:w-64 h-1.5 bg-slate-900 rounded-full overflow-hidden border border-slate-800">
              <div
                className={`h-full transition-all duration-200 ${
                  meetsDataFloor ? 'bg-emerald-400' : 'bg-amber-400'
                }`}
                style={{ width: `${Math.max(4, floorProgressPct)}%` }}
              />
            </div>
            <span className="text-xs text-slate-400 font-mono tabular-nums">
              {verifiedClipCount} verified clip(s) ·{' '}
              {meetsDataFloor
                ? 'Ready for instant learned playback'
                : `Need ${secondsShortfall}s more audio`}
            </span>
          </div>
        </div>

        {/* Right: Quick Audition Input & Play Anytime Button */}
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2.5 flex-1 max-w-2xl">
          <input
            type="text"
            value={auditionText}
            onChange={(e) => setAuditionText(e.target.value)}
            placeholder="Type any phrase to audition your current learned voice profile..."
            className="flex-1 px-3.5 py-2 rounded-lg bg-slate-950 border border-slate-800 text-xs text-slate-100 focus:outline-none focus:border-cyan-500"
          />

          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={handleAuditionLearnedProfile}
              disabled={isSynthesizing}
              className={`inline-flex items-center justify-center gap-2 px-4 py-2 text-xs font-semibold rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                meetsDataFloor
                  ? 'bg-cyan-400 hover:bg-cyan-300 text-slate-950'
                  : 'bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 border border-amber-500/40'
              }`}
            >
              {isSynthesizing ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  Synthesizing Learned Voice...
                </>
              ) : isPlaying ? (
                <>
                  <Volume2 className="w-3.5 h-3.5 animate-pulse" />
                  Stop Playback
                </>
              ) : (
                <>
                  <Play className="w-3.5 h-3.5" />
                  Play Learned Voice Now
                </>
              )}
            </button>

            {lastWavBase64 && (
              <button
                onClick={() =>
                  downloadWavFile(
                    lastWavBase64,
                    `voxreplica_live_audition_${liveLearnedProfile.acousticFingerprint.medianF0Hz}Hz.wav`
                  )
                }
                title="Download this audition clip as a local WAV file"
                className="p-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 transition-colors cursor-pointer shrink-0"
              >
                <Download className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Insufficient Information Data Floor Alert Banner */}
      {floorAlertMsg && (
        <div className="p-4 rounded-xl bg-amber-950/50 border border-amber-500/50 text-xs text-amber-100 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-start gap-2.5">
            <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
            <div className="space-y-1">
              <p className="font-semibold text-amber-300">
                Acoustic Data Floor Not Reached ({currentVerifiedSeconds}s / {dataFloorSeconds}s)
              </p>
              <p className="text-amber-100/90 leading-relaxed">{floorAlertMsg}</p>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={() => {
                setFloorAlertMsg(null);
                onJumpToAnchorLab(lowestElement?.targetedPracticeScript);
              }}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-slate-950 bg-amber-400 hover:bg-amber-300 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Mic className="w-3.5 h-3.5" />
              Record Missing Audio (+{secondsShortfall}s)
            </button>
            <button
              onClick={() => setFloorAlertMsg(null)}
              className="px-2.5 py-1.5 text-xs text-amber-300 hover:text-white underline whitespace-nowrap shrink-0 cursor-pointer"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {apiErrorMsg && (
        <div className="p-3 rounded-lg bg-rose-950/60 border border-rose-800 text-xs text-rose-200 flex items-center justify-between gap-4">
          <span>{apiErrorMsg}</span>
          <button
            onClick={() => setApiErrorMsg(null)}
            className="text-rose-300 hover:text-white underline cursor-pointer"
          >
            Dismiss
          </button>
        </div>
      )}
    </section>
  );
};
