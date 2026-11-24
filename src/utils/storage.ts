import {
  ConversationSegment,
  CustomVoiceProfile,
  GuidedPromptCard,
  SynthesisTake,
  VoiceAnchorSample,
} from '../types/voice';

const DB_NAME = 'VoxReplicaStudioDB';
const DB_VERSION = 1;

export const GUIDED_ANCHOR_PROMPTS: GuidedPromptCard[] = [
  {
    id: 'prompt-baseline',
    title: '01. Conversational Baseline & Cadence',
    category: 'Natural Register',
    targetNuance: 'Captures median F0 fundamental pitch, chest resonance, and relaxed clause pausing.',
    script:
      'When I speak in a normal conversation, my voice settles into a natural rhythm. I tend to pause briefly between ideas, letting the tone stay grounded and clear.',
  },
  {
    id: 'prompt-expressive',
    title: '02. Expressive Storytelling & Inflection',
    category: 'Dynamic Prosody',
    targetNuance: 'Captures upward melodic inflection, vocal bursts, and emotional warmth.',
    script:
      'Wait—you seriously heard that entire recording? That is honestly incredible! Sometimes a subtle breath or a quick laugh says way more than the script itself.',
  },
  {
    id: 'prompt-articulate',
    title: '03. Crisp Plosives & Sibilance Calibration',
    category: 'Articulation & Timbre',
    targetNuance: 'Calibrates high-frequency spectral centroid, consonant precision, and pacing.',
    script:
      'Precision acoustic synthesis requires capturing micro-timbre variations, plosive transients, and natural breath intakes across diverse phonetic transitions.',
  },
  {
    id: 'prompt-reflective',
    title: '04. Intimate & Reflective Pacing',
    category: 'Low-Volume Nuance',
    targetNuance: 'Captures soft onset breathiness, lower vocal fry boundary, and unhurried tempo.',
    script:
      'If you listen closely to a long two-person conversation, you start to notice the quiet habits—how someone exhales before answering a thoughtful question.',
  },
];

export const DEFAULT_VOICE_PROFILE: CustomVoiceProfile = {
  id: 'profile-primary-replica',
  name: 'Personal Vocal Replica v1',
  createdAt: '2026-11-23T09:15:00.000Z',
  updatedAt: '2026-11-23T09:15:00.000Z',
  anchorSampleCount: 0,
  isolatedSegmentCount: 0,
  totalVerifiedDurationSec: 0,
  acousticFingerprint: {
    medianF0Hz: 138,
    f0StdDevHz: 21,
    avgWpm: 148,
    pauseFrequencyPer100Words: 6.4,
    spectralWarmthHz: 1420,
  },
  timbreClassification: 'Warm Conversational Mid-Baritone',
  baseFoundationVoice: 'Puck',
  voiceDesignDirective:
    'Warm, articulate conversational voice with grounded chest resonance, natural breath intakes (<breath>) before multi-clause thoughts, subtle downward pitch closure at sentence endings, and expressive mid-phrase emphasis.',
  signatureHabits: [
    'Takes a gentle audible breath (<breath>) before starting longer explanations',
    'Uses natural conversational backchannels (|yeah|, |mhm|) when transitioning topics',
    'Maintains a steady ~148 WPM tempo with micro-pauses after introductory clauses',
    'Slightly lowers fundamental pitch (F0) at declarative sentence boundaries',
  ],
  dspCalibration: {
    pitchShiftSemitones: 0,
    playbackRate: 1.0,
    formantWarmthDb: 1.5,
  },
};

let dbPromise: Promise<IDBDatabase> | null = null;

function openDatabase(): Promise<IDBDatabase> {
  if (dbPromise) {
    return dbPromise;
  }
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('kv')) {
        db.createObjectStore('kv');
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      db.onclose = () => {
        dbPromise = null;
      };
      resolve(db);
    };
    request.onerror = () => {
      dbPromise = null;
      reject(request.error);
    };
  });
  return dbPromise;
}

export async function saveStoreValue<T>(key: string, value: T): Promise<void> {
  try {
    const db = await openDatabase();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    console.warn('IndexedDB write fallback:', err);
  }
}

export async function loadStoreValue<T>(key: string, fallback: T): Promise<T> {
  try {
    const db = await openDatabase();
    return await new Promise<T>((resolve) => {
      const tx = db.transaction('kv', 'readonly');
      const req = tx.objectStore('kv').get(key);
      req.onsuccess = () => {
        resolve(req.result !== undefined ? (req.result as T) : fallback);
      };
      req.onerror = () => resolve(fallback);
    });
  } catch {
    return fallback;
  }
}

export interface PersistedStudioState {
  anchors: VoiceAnchorSample[];
  segments: ConversationSegment[];
  profiles: CustomVoiceProfile[];
  activeProfileId: string;
  takes: SynthesisTake[];
}

export async function loadStudioState(): Promise<PersistedStudioState> {
  const [anchors, segments, profiles, activeProfileId, takes] = await Promise.all([
    loadStoreValue<VoiceAnchorSample[]>('vox_anchors', []),
    loadStoreValue<ConversationSegment[]>('vox_segments', []),
    loadStoreValue<CustomVoiceProfile[]>('vox_profiles', [DEFAULT_VOICE_PROFILE]),
    loadStoreValue<string>('vox_active_profile_id', DEFAULT_VOICE_PROFILE.id),
    loadStoreValue<SynthesisTake[]>('vox_takes', []),
  ]);

  const validProfiles = profiles.length > 0 ? profiles : [DEFAULT_VOICE_PROFILE];
  const validActiveId = validProfiles.some((p) => p.id === activeProfileId)
    ? activeProfileId
    : validProfiles[0].id;

  return {
    anchors,
    segments,
    profiles: validProfiles,
    activeProfileId: validActiveId,
    takes,
  };
}
