import {
  ConversationSegment,
  CustomVoiceProfile,
  VoiceAnchorSample,
} from '../types/voice';

export const VOICE_DATA_FLOOR_SECONDS = 10.0;
export const VOICE_DATA_FLOOR_MIN_CLIPS = 1;

export interface PhonemeCategoryConfidence {
  id: string;
  name: string;
  ipaExamples: string;
  categoryType: 'Phoneme Group' | 'Prosodic Contour' | 'Breathing & Cadence';
  confidencePercent: number;
  status: 'Critical Deficit' | 'Needs More Data' | 'Calibrated';
  observedCount: number;
  targetCount: number;
  diagnosticExplanation: string;
  targetedPracticeScript: string;
}

export interface LearnedCorpusDiagnostic {
  meetsDataFloor: boolean;
  dataFloorSeconds: number;
  currentVerifiedSeconds: number;
  secondsShortfall: number;
  verifiedClipCount: number;
  overallConfidencePercent: number;
  liveLearnedProfile: CustomVoiceProfile;
  elementsByLowestConfidence: PhonemeCategoryConfidence[];
  lowestConfidenceElements: PhonemeCategoryConfidence[];
}

/**
 * Dynamically computes the live learned voice profile and phonetic/prosodic confidence matrix
 * from all currently submitted microphone anchors and verified conversational segments.
 */
export function computeLearnedCorpusDiagnostic(
  anchors: VoiceAnchorSample[],
  segments: ConversationSegment[],
  baseProfile: CustomVoiceProfile
): LearnedCorpusDiagnostic {
  const verifiedSegments = segments.filter(
    (s) => s.assignment === 'target_user' && s.includedInCorpus
  );

  const allMetrics = [
    ...anchors.map((a) => a.dspMetrics),
    ...verifiedSegments.map((s) => s.dspMetrics),
  ];

  const allTranscripts = [
    ...anchors.map((a) => a.transcript || a.promptScript || ''),
    ...verifiedSegments.map((s) => s.transcript || ''),
  ]
    .join(' ')
    .trim();

  const lowerText = allTranscripts.toLowerCase();

  const currentVerifiedSeconds = Number(
    allMetrics.reduce((sum, m) => sum + m.durationSec, 0).toFixed(1)
  );
  const verifiedClipCount = allMetrics.length;

  const meetsDataFloor =
    currentVerifiedSeconds >= VOICE_DATA_FLOOR_SECONDS &&
    verifiedClipCount >= VOICE_DATA_FLOOR_MIN_CLIPS;

  const secondsShortfall = Number(
    Math.max(0, VOICE_DATA_FLOOR_SECONDS - currentVerifiedSeconds).toFixed(1)
  );

  // Dynamically compute acoustic fingerprint from submitted audio
  const medianF0Hz =
    allMetrics.length > 0
      ? Math.round(allMetrics.reduce((s, m) => s + m.medianF0Hz, 0) / allMetrics.length)
      : baseProfile.acousticFingerprint.medianF0Hz;

  const f0StdDevHz =
    allMetrics.length > 0
      ? Math.round(allMetrics.reduce((s, m) => s + m.f0StdDevHz, 0) / allMetrics.length)
      : baseProfile.acousticFingerprint.f0StdDevHz;

  const avgWpm =
    allMetrics.length > 0
      ? Math.round(allMetrics.reduce((s, m) => s + m.estimatedWpm, 0) / allMetrics.length)
      : baseProfile.acousticFingerprint.avgWpm;

  const spectralWarmthHz =
    allMetrics.length > 0
      ? Math.round(
          allMetrics.reduce((s, m) => s + m.spectralCentroidHz, 0) / allMetrics.length
        )
      : baseProfile.acousticFingerprint.spectralWarmthHz;

  const avgPauseRatio =
    allMetrics.length > 0
      ? allMetrics.reduce((s, m) => s + m.pauseRatio, 0) / allMetrics.length
      : 0.18;

  // Count phoneme & prosodic occurrences across all submitted transcripts
  const countRegex = (re: RegExp) => (lowerText.match(re) || []).length;

  // 1. Sibilants & Dental Fricatives (/s/, /z/, /ʃ/, /θ/, /ð/, /f/, /v/)
  const sibilantCount = countRegex(/(sh|th|ch|ph|[szfv])/g);
  const sibilantTarget = 45;
  const sibilantConf = Math.min(
    98,
    Math.round((sibilantCount / sibilantTarget) * 85 + (verifiedClipCount > 0 ? 12 : 0))
  );

  // 2. Plosive Stop Transients (/p/, /b/, /t/, /d/, /k/, /g/)
  const plosiveCount = countRegex(/[pbtdkg]/g);
  const plosiveTarget = 65;
  const plosiveConf = Math.min(
    98,
    Math.round((plosiveCount / plosiveTarget) * 85 + (verifiedClipCount > 0 ? 12 : 0))
  );

  // 3. Nasal & Liquid Formant Resonants (/m/, /n/, /ŋ/, /l/, /r/)
  const nasalCount = countRegex(/(ng|[mnlr])/g);
  const nasalTarget = 70;
  const nasalConf = Math.min(
    98,
    Math.round((nasalCount / nasalTarget) * 85 + (verifiedClipCount > 0 ? 12 : 0))
  );

  // 4. Diphthongs & Open Vowel Glides (/aɪ/, /oʊ/, /aʊ/, /ɔɪ/, /eɪ/)
  const diphthongCount = countRegex(/(ou|ow|oi|oy|ai|ay|ei|ey|igh|oa)/g);
  const diphthongTarget = 18;
  const diphthongConf = Math.min(
    98,
    Math.round((diphthongCount / diphthongTarget) * 88 + (verifiedClipCount > 0 ? 10 : 0))
  );

  // 5. Interrogative & Expressive Pitch Inflection (?, !, dynamic F0 variance)
  const expressiveMarkers =
    countRegex(/[?!—]/g) +
    countRegex(/\b(wait|seriously|honestly|really|why|how|incredible|wow)\b/g);
  const highVarianceClips = allMetrics.filter((m) => m.f0StdDevHz >= 18).length;
  const inflectionObserved = expressiveMarkers + highVarianceClips * 2;
  const inflectionTarget = 8;
  const inflectionConf = Math.min(
    98,
    Math.round((inflectionObserved / inflectionTarget) * 90 + (highVarianceClips > 0 ? 8 : 0))
  );

  // 6. Clause-Boundary Breaths, Backchannels & Prosodic Pauses
  const breathAndPauseMarkers =
    countRegex(/(<breath>|<laugh>|<gasp>|\|yeah\||\|mhm\||[,;:]|\.\.\.)/g) +
    allMetrics.filter((m) => m.pauseRatio >= 0.14).length * 2;
  const breathTarget = 10;
  const breathConf = Math.min(
    98,
    Math.round((breathAndPauseMarkers / breathTarget) * 90 + (verifiedClipCount > 0 ? 8 : 0))
  );

  const classifyStatus = (
    pct: number
  ): 'Critical Deficit' | 'Needs More Data' | 'Calibrated' => {
    if (pct < 45) return 'Critical Deficit';
    if (pct < 75) return 'Needs More Data';
    return 'Calibrated';
  };

  const elements: PhonemeCategoryConfidence[] = [
    {
      id: 'phoneme-diphthongs',
      name: 'Vowel Glides & Diphthongs',
      ipaExamples: '/aɪ/ /aʊ/ /ɔɪ/ /oʊ/ /eɪ/',
      categoryType: 'Phoneme Group',
      confidencePercent: verifiedClipCount === 0 ? 0 : diphthongConf,
      status: classifyStatus(verifiedClipCount === 0 ? 0 : diphthongConf),
      observedCount: diphthongCount,
      targetCount: diphthongTarget,
      diagnosticExplanation:
        diphthongConf < 75
          ? 'Model lacks sufficient sustained vowel glides (/aʊ/, /ɔɪ/, /aɪ/) to lock formant transitions and harmonic vowel color.'
          : 'Formant glide transitions across open diphthongs are well-represented.',
      targetedPracticeScript:
        'Now I know how the bright voice coils join around the loud sound waves outside our studio point.',
    },
    {
      id: 'prosody-inflection',
      name: 'Interrogative & Expressive Pitch Contour',
      ipaExamples: 'Rising F0 (?) · Emphatic Peak (!)',
      categoryType: 'Prosodic Contour',
      confidencePercent: verifiedClipCount === 0 ? 0 : inflectionConf,
      status: classifyStatus(verifiedClipCount === 0 ? 0 : inflectionConf),
      observedCount: inflectionObserved,
      targetCount: inflectionTarget,
      diagnosticExplanation:
        inflectionConf < 75
          ? 'Submitted audio is mostly declarative/flat. Model needs questions (?) and emphatic upper-register pitch swings to replicate natural excitement.'
          : 'Upper and lower pitch excursion boundaries are well-calibrated.',
      targetedPracticeScript:
        'Wait—did you really hear how high that pitch jumped at the end of the question? That inflection is wildly expressive!',
    },
    {
      id: 'phoneme-sibilants',
      name: 'Sibilants & Dental Fricatives',
      ipaExamples: '/s/ /z/ /ʃ/ (sh) /θ/ (th) /f/ /v/',
      categoryType: 'Phoneme Group',
      confidencePercent: verifiedClipCount === 0 ? 0 : sibilantConf,
      status: classifyStatus(verifiedClipCount === 0 ? 0 : sibilantConf),
      observedCount: sibilantCount,
      targetCount: sibilantTarget,
      diagnosticExplanation:
        sibilantConf < 75
          ? 'Insufficient high-frequency fricative energy (2.8–6 kHz). More /sh/, /th/, /s/, and /v/ phonemes are needed to model breathy consonant brightness.'
          : 'High-frequency sibilant and fricative dispersion is accurately modeled.',
      targetedPracticeScript:
        'She softly shifted through seven fresh synthesis phases, verifying every subtle breath and velvet fricative sound.',
    },
    {
      id: 'prosody-breaths',
      name: 'Clause-Boundary Breaths & Micro-Pauses',
      ipaExamples: '<breath> · |yeah| · Clause Pauses',
      categoryType: 'Breathing & Cadence',
      confidencePercent: verifiedClipCount === 0 ? 0 : breathConf,
      status: classifyStatus(verifiedClipCount === 0 ? 0 : breathConf),
      observedCount: breathAndPauseMarkers,
      targetCount: breathTarget,
      diagnosticExplanation:
        breathConf < 75
          ? 'Model needs more multi-clause sentences with natural intake breaths and mid-thought pauses to avoid robotic run-on pacing.'
          : 'Breathing cadence and inter-clause pause timing are well-established.',
      targetedPracticeScript:
        'When I pause in the middle of a longer thought, I take a quiet breath... and then settle right back into my natural rhythm.',
    },
    {
      id: 'phoneme-plosives',
      name: 'Voiced & Unvoiced Plosive Stops',
      ipaExamples: '/p/ /b/ /t/ /d/ /k/ /g/',
      categoryType: 'Phoneme Group',
      confidencePercent: verifiedClipCount === 0 ? 0 : plosiveConf,
      status: classifyStatus(verifiedClipCount === 0 ? 0 : plosiveConf),
      observedCount: plosiveCount,
      targetCount: plosiveTarget,
      diagnosticExplanation:
        plosiveConf < 75
          ? 'More crisp stop-consonant transients (/p/, /t/, /k/, /b/, /d/, /g/) are needed to calibrate consonant burst sharpness.'
          : 'Plosive attack transients and stop boundaries are well-calibrated.',
      targetedPracticeScript:
        'Peter picked a crisp copper pocket cable to connect the studio board back to the digital data deck.',
    },
    {
      id: 'phoneme-nasals',
      name: 'Nasal & Liquid Chest Resonants',
      ipaExamples: '/m/ /n/ /ŋ/ (ng) /l/ /r/',
      categoryType: 'Phoneme Group',
      confidencePercent: verifiedClipCount === 0 ? 0 : nasalConf,
      status: classifyStatus(verifiedClipCount === 0 ? 0 : nasalConf),
      observedCount: nasalCount,
      targetCount: nasalTarget,
      diagnosticExplanation:
        nasalConf < 75
          ? 'Low coverage of sustained nasal and liquid consonants (/m/, /n/, /ng/, /l/, /r/) needed to model low-mid chest resonance.'
          : 'Nasal and liquid chest resonance formants are strongly represented.',
      targetedPracticeScript:
        'Many morning melodies ring clearly along the warm wooden room, humming with calm natural resonance.',
    },
  ];

  const elementsByLowestConfidence = [...elements].sort(
    (a, b) => a.confidencePercent - b.confidencePercent
  );

  const lowestConfidenceElements = elementsByLowestConfidence.filter(
    (e) => e.confidencePercent < 80
  );

  const overallConfidencePercent =
    verifiedClipCount === 0
      ? 0
      : Math.round(
          elements.reduce((sum, el) => sum + el.confidencePercent, 0) / elements.length
        );

  const isExplicitlyTrainedProfile =
    baseProfile.anchorSampleCount > 0 ||
    baseProfile.isolatedSegmentCount > 0 ||
    baseProfile.updatedAt !== '2026-11-23T09:15:00.000Z';

  // Dynamically choose foundation voice & DSP offsets learned from submitted clips
  const learnedFoundationVoice: CustomVoiceProfile['baseFoundationVoice'] =
    allMetrics.length === 0 || isExplicitlyTrainedProfile
      ? baseProfile.baseFoundationVoice
      : medianF0Hz < 122
      ? 'Charon'
      : medianF0Hz < 135
      ? 'Fenrir'
      : medianF0Hz < 172
      ? 'Puck'
      : medianF0Hz < 205
      ? 'Kore'
      : 'Zephyr';

  const baseVoiceCenterF0: Record<CustomVoiceProfile['baseFoundationVoice'], number> = {
    Charon: 112,
    Fenrir: 128,
    Puck: 145,
    Kore: 185,
    Zephyr: 215,
  };

  const learnedPitchShiftSemitones =
    allMetrics.length > 0 && !isExplicitlyTrainedProfile
      ? Number(
          Math.max(
            -3.0,
            Math.min(
              3.0,
              12 * Math.log2(Math.max(75, medianF0Hz) / baseVoiceCenterF0[learnedFoundationVoice])
            )
          ).toFixed(2)
        )
      : baseProfile.dspCalibration.pitchShiftSemitones;

  const learnedPlaybackRate =
    allMetrics.length > 0 && !isExplicitlyTrainedProfile
      ? Number(Math.max(0.88, Math.min(1.15, avgWpm / 148)).toFixed(2))
      : baseProfile.dspCalibration.playbackRate;

  const learnedWarmthDb =
    allMetrics.length > 0 && !isExplicitlyTrainedProfile
      ? Number(
          Math.max(-2.5, Math.min(4.0, (1650 - spectralWarmthHz) / 220)).toFixed(1)
        )
      : baseProfile.dspCalibration.formantWarmthDb;

  const dynamicDirective =
    allMetrics.length > 0 && !isExplicitlyTrainedProfile
      ? `Learned vocal replica (${medianF0Hz} Hz median F0, ±${f0StdDevHz} Hz inflection variance, ${avgWpm} WPM tempo, ${Math.round(
          avgPauseRatio * 100
        )}% pause ratio). ${baseProfile.voiceDesignDirective}`
      : baseProfile.voiceDesignDirective;

  const liveLearnedProfile: CustomVoiceProfile = {
    ...baseProfile,
    anchorSampleCount: anchors.length,
    isolatedSegmentCount: verifiedSegments.length,
    totalVerifiedDurationSec: currentVerifiedSeconds,
    acousticFingerprint: {
      medianF0Hz,
      f0StdDevHz,
      avgWpm,
      pauseFrequencyPer100Words: Number((avgPauseRatio * 35).toFixed(1)),
      spectralWarmthHz,
    },
    baseFoundationVoice: learnedFoundationVoice,
    voiceDesignDirective: dynamicDirective,
    dspCalibration: {
      pitchShiftSemitones: learnedPitchShiftSemitones,
      playbackRate: learnedPlaybackRate,
      formantWarmthDb: learnedWarmthDb,
    },
  };

  return {
    meetsDataFloor,
    dataFloorSeconds: VOICE_DATA_FLOOR_SECONDS,
    currentVerifiedSeconds,
    secondsShortfall,
    verifiedClipCount,
    overallConfidencePercent,
    liveLearnedProfile,
    elementsByLowestConfidence,
    lowestConfidenceElements,
  };
}
