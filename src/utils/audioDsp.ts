import { AcousticDspMetrics } from '../types/voice';

/**
 * Estimates fundamental frequency (F0 in Hz) of a short mono time-domain frame
 * using normalized autocorrelation within human vocal range (70 Hz - 360 Hz).
 */
export function estimateFramePitchHz(frame: Float32Array, sampleRate: number): number | null {
  let rms = 0;
  for (let i = 0; i < frame.length; i++) {
    rms += frame[i] * frame[i];
  }
  rms = Math.sqrt(rms / frame.length);
  if (rms < 0.018) {
    return null; // Unvoiced or silence frame
  }

  const minLag = Math.floor(sampleRate / 360); // 360 Hz max
  const maxLag = Math.min(frame.length - 2, Math.floor(sampleRate / 70)); // 70 Hz min

  let bestLag = -1;
  let bestCorr = 0;

  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0;
    let normA = 0;
    let normB = 0;
    const len = frame.length - lag;
    for (let i = 0; i < len; i++) {
      const a = frame[i];
      const b = frame[i + lag];
      sum += a * b;
      normA += a * a;
      normB += b * b;
    }
    const denom = Math.sqrt(normA * normB);
    const corr = denom > 0 ? sum / denom : 0;
    if (corr > bestCorr) {
      bestCorr = corr;
      bestLag = lag;
    }
  }

  if (bestCorr >= 0.58 && bestLag > 0) {
    return sampleRate / bestLag;
  }
  return null;
}

/**
 * Computes spectral centroid (in Hz) of a signal buffer using zero-crossing and high-frequency energy differential.
 */
function estimateSpectralCentroidHz(channelData: Float32Array, sampleRate: number): number {
  let zeroCrossings = 0;
  let diffEnergy = 0;
  let totalEnergy = 0;

  for (let i = 1; i < channelData.length; i++) {
    if ((channelData[i] >= 0 && channelData[i - 1] < 0) || (channelData[i] < 0 && channelData[i - 1] >= 0)) {
      zeroCrossings++;
    }
    const diff = channelData[i] - channelData[i - 1];
    diffEnergy += diff * diff;
    totalEnergy += channelData[i] * channelData[i];
  }

  const zcrHz = (zeroCrossings / Math.max(1, channelData.length)) * (sampleRate / 2);
  const hfRatio = totalEnergy > 0 ? Math.sqrt(diffEnergy / totalEnergy) : 0.3;
  const centroid = Math.round(750 + zcrHz * 0.55 + hfRatio * 950);
  return Math.min(3400, Math.max(650, centroid));
}

/**
 * Extracts comprehensive acoustic DSP telemetry from an AudioBuffer.
 */
export function extractAcousticDspMetrics(
  audioBuffer: AudioBuffer,
  wordCountEstimate?: number
): AcousticDspMetrics {
  const channelData = audioBuffer.getChannelData(0);
  const sampleRate = audioBuffer.sampleRate;
  const durationSec = Number(audioBuffer.duration.toFixed(2));

  const frameSize = Math.floor(sampleRate * 0.04); // 40ms analysis window
  const hopSize = Math.floor(sampleRate * 0.025); // 25ms hop
  const pitches: number[] = [];

  let silentFrames = 0;
  let totalFrames = 0;
  let sumSq = 0;

  for (let i = 0; i < channelData.length; i++) {
    sumSq += channelData[i] * channelData[i];
  }
  const globalRms = Math.sqrt(sumSq / Math.max(1, channelData.length));
  const rmsDb = Number(Math.max(-60, 20 * Math.log10(Math.max(1e-5, globalRms))).toFixed(1));

  for (let start = 0; start + frameSize <= channelData.length; start += hopSize) {
    totalFrames++;
    const slice = channelData.subarray(start, start + frameSize);
    let frameRms = 0;
    for (let j = 0; j < slice.length; j++) {
      frameRms += slice[j] * slice[j];
    }
    frameRms = Math.sqrt(frameRms / slice.length);
    if (frameRms < 0.015) {
      silentFrames++;
      continue;
    }

    const f0 = estimateFramePitchHz(slice, sampleRate);
    if (f0 !== null && f0 >= 72 && f0 <= 340) {
      pitches.push(f0);
    }
  }

  pitches.sort((a, b) => a - b);
  const medianF0Hz =
    pitches.length > 0
      ? Math.round(pitches[Math.floor(pitches.length / 2)])
      : 142;

  const meanF0 =
    pitches.length > 0
      ? pitches.reduce((acc, v) => acc + v, 0) / pitches.length
      : medianF0Hz;

  const variance =
    pitches.length > 1
      ? pitches.reduce((acc, v) => acc + Math.pow(v - meanF0, 2), 0) / pitches.length
      : 196;

  const f0StdDevHz = Math.round(Math.sqrt(variance));
  const minF0Hz = pitches.length > 0 ? Math.round(pitches[Math.floor(pitches.length * 0.1)]) : Math.max(80, medianF0Hz - 22);
  const maxF0Hz = pitches.length > 0 ? Math.round(pitches[Math.floor(pitches.length * 0.9)]) : medianF0Hz + 28;

  const pauseRatio = totalFrames > 0 ? Number((silentFrames / totalFrames).toFixed(2)) : 0.18;
  const spectralCentroidHz = estimateSpectralCentroidHz(channelData, sampleRate);

  const activeDurationSec = Math.max(0.5, durationSec * (1 - pauseRatio * 0.6));
  const estimatedWpm = wordCountEstimate && wordCountEstimate > 2
    ? Math.min(220, Math.max(95, Math.round((wordCountEstimate / activeDurationSec) * 60)))
    : Math.round(138 + (1 - pauseRatio) * 28);

  // Extract 64 normalized waveform peaks for visual rendering
  const bucketCount = 64;
  const samplesPerBucket = Math.max(1, Math.floor(channelData.length / bucketCount));
  const waveformPeaks: number[] = [];
  let maxPeak = 0.01;

  for (let b = 0; b < bucketCount; b++) {
    const startIdx = b * samplesPerBucket;
    const endIdx = Math.min(channelData.length, startIdx + samplesPerBucket);
    let peak = 0;
    for (let i = startIdx; i < endIdx; i++) {
      const abs = Math.abs(channelData[i]);
      if (abs > peak) peak = abs;
    }
    if (peak > maxPeak) maxPeak = peak;
    waveformPeaks.push(peak);
  }

  const normalizedPeaks = waveformPeaks.map((p) => Number(Math.max(0.06, p / maxPeak).toFixed(3)));

  return {
    durationSec,
    medianF0Hz,
    f0StdDevHz,
    minF0Hz,
    maxF0Hz,
    rmsDb,
    spectralCentroidHz,
    estimatedWpm,
    pauseRatio,
    waveformPeaks: normalizedPeaks,
  };
}

/**
 * Encodes an AudioBuffer (or sub-range of an AudioBuffer) into a standard 16-bit mono WAV Base64 string.
 */
export function audioBufferSliceToWavBase64(
  buffer: AudioBuffer,
  startSec = 0,
  endSec = buffer.duration,
  targetSampleRate = 24000
): string {
  const srcRate = buffer.sampleRate;
  const startSample = Math.max(0, Math.floor(startSec * srcRate));
  const endSample = Math.min(buffer.length, Math.floor(endSec * srcRate));
  const srcLength = Math.max(1, endSample - startSample);

  const channel0 = buffer.getChannelData(0);
  const channel1 = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : null;

  // Downsample or resample to targetSampleRate (24kHz keeps payloads fast & matches Gemini TTS)
  const outRate = Math.min(srcRate, targetSampleRate);
  const ratio = srcRate / outRate;
  const outLength = Math.max(1, Math.floor(srcLength / ratio));

  const wavBuffer = new ArrayBuffer(44 + outLength * 2);
  const view = new DataView(wavBuffer);

  const writeString = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + outLength * 2, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM format = 1
  view.setUint16(22, 1, true); // Mono = 1 channel
  view.setUint32(24, outRate, true);
  view.setUint32(28, outRate * 2, true); // Byte rate
  view.setUint16(32, 2, true); // Block align
  view.setUint16(34, 16, true); // 16-bit
  writeString(36, 'data');
  view.setUint32(40, outLength * 2, true);

  let offset = 44;
  for (let i = 0; i < outLength; i++) {
    const srcIdx = Math.min(endSample - 1, startSample + Math.floor(i * ratio));
    let sample = channel0[srcIdx];
    if (channel1) {
      sample = 0.5 * (sample + channel1[srcIdx]);
    }
    const clamped = Math.max(-1, Math.min(1, sample));
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    offset += 2;
  }

  const bytes = new Uint8Array(wavBuffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const sub = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...sub);
  }
  return btoa(binary);
}

/**
 * Decodes a Base64 audio string into an AudioBuffer.
 */
export async function base64ToAudioBuffer(base64: string): Promise<AudioBuffer> {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
  const ctx = new AudioCtx();
  try {
    const audioBuffer = await ctx.decodeAudioData(bytes.buffer.slice(0));
    return audioBuffer;
  } finally {
    if (ctx.state !== 'closed') {
      await ctx.close().catch(() => {});
    }
  }
}

/**
 * Computes acoustic similarity score (0-100) between a conversational segment
 * and the user's recorded microphone voice anchors.
 */
export function computeAcousticSimilarityToAnchor(
  segmentDsp: AcousticDspMetrics,
  anchors: AcousticDspMetrics[]
): number {
  if (!anchors || anchors.length === 0) {
    return 75;
  }

  const avgF0 =
    anchors.reduce((sum, a) => sum + a.medianF0Hz, 0) / anchors.length;
  const avgCentroid =
    anchors.reduce((sum, a) => sum + a.spectralCentroidHz, 0) / anchors.length;
  const avgStdDev =
    anchors.reduce((sum, a) => sum + a.f0StdDevHz, 0) / anchors.length;

  const f0Diff = Math.abs(segmentDsp.medianF0Hz - avgF0);
  const centroidDiff = Math.abs(segmentDsp.spectralCentroidHz - avgCentroid);
  const stdDevDiff = Math.abs(segmentDsp.f0StdDevHz - avgStdDev);

  // F0 pitch proximity carries 60% weight, spectral timbre 25%, inflection variance 15%
  const f0Score = Math.max(0, 100 - f0Diff * 1.45);
  const centroidScore = Math.max(0, 100 - (centroidDiff / 16));
  const varianceScore = Math.max(0, 100 - stdDevDiff * 1.5);

  const combined = Math.round(f0Score * 0.6 + centroidScore * 0.25 + varianceScore * 0.15);
  return Math.min(99, Math.max(18, combined));
}

export interface SlicedAudioSegment {
  segmentIndex: number;
  startTimeSec: number;
  endTimeSec: number;
  durationSec: number;
  audioBase64: string;
  dspMetrics: AcousticDspMetrics;
  initialSimilarityScore: number;
}

/**
 * Slices a decoded multi-speaker conversational AudioBuffer into turn-sized segments
 * by searching for low-energy pause boundaries between targetWindowSec (default 14s) and maxWindowSec (22s).
 */
export function sliceAudioBufferIntoConversationalTurns(
  audioBuffer: AudioBuffer,
  anchorMetrics: AcousticDspMetrics[],
  maxSegmentsToExtract = 12,
  startOffsetSec = 0
): SlicedAudioSegment[] {
  const sampleRate = audioBuffer.sampleRate;
  const channelData = audioBuffer.getChannelData(0);
  const totalDuration = audioBuffer.duration;

  const minTurnSec = 7;
  const targetTurnSec = 14;
  const maxTurnSec = 20;

  const segments: SlicedAudioSegment[] = [];
  let cursorSec = Math.max(0, Math.min(startOffsetSec, totalDuration - 1));
  let index = 1;

  while (cursorSec < totalDuration - 1.5 && segments.length < maxSegmentsToExtract) {
    const remaining = totalDuration - cursorSec;
    let nextBoundarySec = cursorSec + Math.min(targetTurnSec, remaining);

    if (remaining > minTurnSec + 2) {
      // Scan between cursorSec + minTurnSec and cursorSec + maxTurnSec for a natural pause (lowest RMS window)
      const searchStartSec = cursorSec + minTurnSec;
      const searchEndSec = Math.min(totalDuration, cursorSec + maxTurnSec);
      const windowSamples = Math.floor(sampleRate * 0.18); // 180ms pause detector
      const stepSamples = Math.floor(sampleRate * 0.12);

      let lowestRms = Infinity;
      let bestCutSample = Math.floor(nextBoundarySec * sampleRate);

      for (
        let s = Math.floor(searchStartSec * sampleRate);
        s + windowSamples < Math.floor(searchEndSec * sampleRate);
        s += stepSamples
      ) {
        let sum = 0;
        for (let i = 0; i < windowSamples; i++) {
          const val = channelData[s + i];
          sum += val * val;
        }
        const rms = Math.sqrt(sum / windowSamples);
        if (rms < lowestRms) {
          lowestRms = rms;
          bestCutSample = s + Math.floor(windowSamples / 2);
        }
      }
      nextBoundarySec = Number((bestCutSample / sampleRate).toFixed(2));
    } else {
      nextBoundarySec = Number(totalDuration.toFixed(2));
    }

    const segDuration = Number((nextBoundarySec - cursorSec).toFixed(2));
    if (segDuration >= 1.2) {
      // Create a sub-buffer to extract exact DSP metrics for this turn
      const startSample = Math.floor(cursorSec * sampleRate);
      const endSample = Math.min(audioBuffer.length, Math.floor(nextBoundarySec * sampleRate));
      const frameLen = Math.max(1, endSample - startSample);

      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      const offlineCtx = new OfflineAudioContext(1, frameLen, sampleRate);
      const subBuffer = offlineCtx.createBuffer(1, frameLen, sampleRate);
      subBuffer.copyToChannel(channelData.subarray(startSample, endSample), 0);

      const dspMetrics = extractAcousticDspMetrics(subBuffer);
      const audioBase64 = audioBufferSliceToWavBase64(audioBuffer, cursorSec, nextBoundarySec, 16000);
      const initialSimilarityScore = computeAcousticSimilarityToAnchor(dspMetrics, anchorMetrics);

      segments.push({
        segmentIndex: index++,
        startTimeSec: Number(cursorSec.toFixed(1)),
        endTimeSec: Number(nextBoundarySec.toFixed(1)),
        durationSec: segDuration,
        audioBase64,
        dspMetrics,
        initialSimilarityScore,
      });
    }

    cursorSec = nextBoundarySec;
  }

  return segments;
}

/**
 * Applies Web Audio DSP post-processing (pitch/formant warmth filtering & fine pitch/tempo calibration)
 * to a synthesized WAV buffer so it locks tightly to the user's measured vocal profile.
 */
export async function applyVocalDspCalibrationToWav(
  rawWavBase64: string,
  options: {
    pitchSemitones: number;
    playbackRate: number;
    formantWarmthDb: number;
  }
): Promise<{ calibratedWavBase64: string; durationSec: number; waveformPeaks: number[] }> {
  const sourceBuffer = await base64ToAudioBuffer(rawWavBase64);

  // Combine pitch offset and pacing into effective playback rate & formant EQ
  const pitchFactor = Math.pow(2, (options.pitchSemitones || 0) / 12);
  const rateFactor = Math.max(0.75, Math.min(1.3, (options.playbackRate || 1.0) * pitchFactor));

  const outLength = Math.max(1, Math.floor(sourceBuffer.length / rateFactor));
  const offlineCtx = new OfflineAudioContext(1, outLength, sourceBuffer.sampleRate);

  const sourceNode = offlineCtx.createBufferSource();
  sourceNode.buffer = sourceBuffer;
  sourceNode.playbackRate.value = rateFactor;

  // Low-mid chest resonance / formant warmth shelf at 240 Hz
  const warmthFilter = offlineCtx.createBiquadFilter();
  warmthFilter.type = 'lowshelf';
  warmthFilter.frequency.value = 240;
  warmthFilter.gain.value = options.formantWarmthDb || 0;

  // Presence clarity peak at 3200 Hz
  const presenceFilter = offlineCtx.createBiquadFilter();
  presenceFilter.type = 'peaking';
  presenceFilter.frequency.value = 3200;
  presenceFilter.Q.value = 1.1;
  presenceFilter.gain.value = 1.5;

  sourceNode.connect(warmthFilter);
  warmthFilter.connect(presenceFilter);
  presenceFilter.connect(offlineCtx.destination);

  sourceNode.start(0);
  const renderedBuffer = await offlineCtx.startRendering();

  const metrics = extractAcousticDspMetrics(renderedBuffer);
  const calibratedWavBase64 = audioBufferSliceToWavBase64(
    renderedBuffer,
    0,
    renderedBuffer.duration,
    renderedBuffer.sampleRate
  );

  return {
    calibratedWavBase64,
    durationSec: metrics.durationSec,
    waveformPeaks: metrics.waveformPeaks,
  };
}

/**
 * Encodes a mono Float32Array PCM buffer at an exact sampleRate into a 16-bit RIFF WAV Base64 string.
 */
export function encodeMonoPcmToWavBase64(samples: Float32Array, sampleRate: number): string {
  const outLength = samples.length;
  const wavBuffer = new ArrayBuffer(44 + outLength * 2);
  const view = new DataView(wavBuffer);

  const writeString = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + outLength * 2, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM = 1
  view.setUint16(22, 1, true); // Mono = 1 channel
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true); // 16-bit
  writeString(36, 'data');
  view.setUint32(40, outLength * 2, true);

  let offset = 44;
  for (let i = 0; i < outLength; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    offset += 2;
  }

  const bytes = new Uint8Array(wavBuffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const sub = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...sub);
  }
  return btoa(binary);
}

/**
 * Converts a Base64 WAV string into a binary audio/wav Blob for local file storage.
 */
export function wavBase64ToBlob(wavBase64: string): Blob {
  const binaryString = atob(wavBase64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return new Blob([bytes.buffer], { type: 'audio/wav' });
}

/**
 * Triggers a reliable browser download of a Base64 WAV buffer as a local .wav file using Object URLs.
 */
export function downloadWavFile(wavBase64: string, filename: string): void {
  const cleanName = filename.endsWith('.wav') ? filename : `${filename}.wav`;
  const blob = wavBase64ToBlob(wavBase64);
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = objectUrl;
  link.download = cleanName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 3000);
}

/**
 * Resamples a WAV buffer to a target sample rate (24000 Hz, 44100 Hz, or 48000 Hz)
 * using Web Audio OfflineAudioContext hardware-quality resampling.
 */
export async function exportWavAtSampleRate(
  wavBase64: string,
  targetSampleRate: 24000 | 44100 | 48000
): Promise<string> {
  const srcBuffer = await base64ToAudioBuffer(wavBase64);
  if (srcBuffer.sampleRate === targetSampleRate) {
    return encodeMonoPcmToWavBase64(srcBuffer.getChannelData(0), targetSampleRate);
  }

  const outLength = Math.max(1, Math.round(srcBuffer.duration * targetSampleRate));
  const offlineCtx = new OfflineAudioContext(1, outLength, targetSampleRate);
  const source = offlineCtx.createBufferSource();
  source.buffer = srcBuffer;
  source.connect(offlineCtx.destination);
  source.start(0);
  const rendered = await offlineCtx.startRendering();
  return encodeMonoPcmToWavBase64(rendered.getChannelData(0), targetSampleRate);
}

/**
 * Concatenates multiple synthesis takes into a single continuous master WAV file
 * with a configurable silence interval between takes.
 */
export async function stitchTakesToMasterWav(
  wavBase64List: string[],
  silenceGapSec = 0.8,
  targetSampleRate: 24000 | 44100 | 48000 = 24000
): Promise<{ wavBase64: string; totalDurationSec: number; fileSizeBytes: number }> {
  const decodedBuffers: Float32Array[] = [];
  for (const b64 of wavBase64List) {
    const resampledB64 = await exportWavAtSampleRate(b64, targetSampleRate);
    const buf = await base64ToAudioBuffer(resampledB64);
    decodedBuffers.push(new Float32Array(buf.getChannelData(0)));
  }

  const gapSamples = Math.max(0, Math.round(silenceGapSec * targetSampleRate));
  const totalSamples =
    decodedBuffers.reduce((acc, arr) => acc + arr.length, 0) +
    Math.max(0, decodedBuffers.length - 1) * gapSamples;

  const masterPcm = new Float32Array(Math.max(1, totalSamples));
  let offset = 0;
  for (let i = 0; i < decodedBuffers.length; i++) {
    masterPcm.set(decodedBuffers[i], offset);
    offset += decodedBuffers[i].length;
    if (i < decodedBuffers.length - 1) {
      offset += gapSamples;
    }
  }

  const wavBase64 = encodeMonoPcmToWavBase64(masterPcm, targetSampleRate);
  const totalDurationSec = Number((masterPcm.length / targetSampleRate).toFixed(2));
  const fileSizeBytes = 44 + masterPcm.length * 2;

  return {
    wavBase64,
    totalDurationSec,
    fileSizeBytes,
  };
}

