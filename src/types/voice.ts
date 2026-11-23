export type StudioStage = 'anchor' | 'diarizer' | 'profile' | 'studio';

export interface AcousticDspMetrics {
  durationSec: number;
  medianF0Hz: number;
  f0StdDevHz: number;
  minF0Hz: number;
  maxF0Hz: number;
  rmsDb: number;
  spectralCentroidHz: number;
  estimatedWpm: number;
  pauseRatio: number;
  waveformPeaks: number[];
}

export interface GuidedPromptCard {
  id: string;
  title: string;
  category: string;
  targetNuance: string;
  script: string;
}

export interface VoiceAnchorSample {
  id: string;
  promptId: string;
  promptTitle: string;
  promptCategory: string;
  promptScript: string;
  transcript: string;
  audioBase64: string;
  mimeType: string;
  createdAt: string;
  dspMetrics: AcousticDspMetrics;
  timbreSummary: string;
  cadenceSummary: string;
  clarityScore: number;
}

export type SpeakerAssignment = 'target_user' | 'other_speaker' | 'crosstalk';

export interface ConversationSegment {
  id: string;
  sourceFileName: string;
  segmentIndex: number;
  startTimeSec: number;
  endTimeSec: number;
  durationSec: number;
  audioBase64: string;
  mimeType: string;
  transcript: string;
  assignment: SpeakerAssignment;
  detectedSpeakerLabel: string;
  similarityToAnchorScore: number;
  diarizationReason: string;
  detectedNuances: string[];
  dspMetrics: AcousticDspMetrics;
  includedInCorpus: boolean;
  isAnalyzing?: boolean;
}

export interface CustomVoiceProfile {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  anchorSampleCount: number;
  isolatedSegmentCount: number;
  totalVerifiedDurationSec: number;
  acousticFingerprint: {
    medianF0Hz: number;
    f0StdDevHz: number;
    avgWpm: number;
    pauseFrequencyPer100Words: number;
    spectralWarmthHz: number;
  };
  timbreClassification: string;
  baseFoundationVoice: 'Puck' | 'Charon' | 'Kore' | 'Fenrir' | 'Zephyr';
  voiceDesignDirective: string;
  signatureHabits: string[];
  dspCalibration: {
    pitchShiftSemitones: number;
    playbackRate: number;
    formantWarmthDb: number;
  };
}

export type EmotionalTonePreset =
  | 'Natural Baseline'
  | 'Warm & Conversational'
  | 'Authoritative & Crisp'
  | 'Enthusiastic & Bright'
  | 'Reflective & Intimate'
  | 'Urgent & Focused';

export interface NuanceSettings {
  pacing: number; // 0.75 to 1.25
  pitchSemitones: number; // -4.0 to +4.0
  expressiveness: number; // 0 to 100
  emotionalTone: EmotionalTonePreset;
  warmth: number; // 0 to 100
  applyDspCalibration: boolean;
}

export interface SynthesisTake {
  id: string;
  profileId: string;
  profileName: string;
  rawScript: string;
  compiledStyle: string;
  foundationVoiceUsed: string;
  nuanceSettings: NuanceSettings;
  rawWavBase64: string;
  calibratedWavBase64: string;
  durationSec: number;
  waveformPeaks: number[];
  createdAt: string;
}
