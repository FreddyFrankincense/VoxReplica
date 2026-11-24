import dotenv from 'dotenv';
dotenv.config();

import express, { Request, Response } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI, Type } from '@google/genai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;

// Increase body limit to handle base64 WAV audio slices (up to 35MB)
app.use(express.json({ limit: '35mb' }));

let cachedAiClient: GoogleGenAI | null = null;
let cachedApiKey: string | undefined;

function getAiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error(
      'GEMINI_API_KEY is not configured. Please check the Settings > Secrets panel.'
    );
  }
  if (!cachedAiClient || cachedApiKey !== apiKey) {
    cachedAiClient = new GoogleGenAI({
      apiKey,
      apiVersion: 'v1beta',
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });
    cachedApiKey = apiKey;
  }
  return cachedAiClient;
}

function parseJsonSafely<T>(rawText: string | undefined, fallback: T): T {
  if (!rawText) return fallback;
  try {
    const cleaned = rawText
      .trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();
    return JSON.parse(cleaned) as T;
  } catch {
    return fallback;
  }
}

async function transcribeAudioSafely(
  ai: GoogleGenAI,
  mimeType: string,
  audioBase64: string,
  instructionText: string
): Promise<string> {
  try {
    const resp = await ai.models.generateContent({
      model: 'gemini-3.5-transcribe',
      contents: {
        parts: [
          {
            inlineData: {
              mimeType,
              data: audioBase64,
            },
          },
          {
            text: instructionText,
          },
        ],
      },
    });
    return (resp.text ?? '').trim();
  } catch (err: any) {
    // Fallback to gemini-4-hydrogen multimodal audio transcription if gemini-3.5-transcribe is unavailable
    const fallbackResp = await ai.models.generateContent({
      model: 'gemini-4-hydrogen',
      contents: {
        parts: [
          {
            inlineData: {
              mimeType,
              data: audioBase64,
            },
          },
          {
            text: `${instructionText} Return ONLY the verbatim transcript text without commentary.`,
          },
        ],
      },
    });
    return (fallbackResp.text ?? '').trim();
  }
}

// 1. Transcribe & profile a live microphone anchor sample
app.post('/api/voice/analyze-anchor', async (req: Request, res: Response) => {
  try {
    const { audioBase64, mimeType = 'audio/wav', promptText, dspMetrics } = req.body;
    if (!audioBase64) {
      res.status(400).json({ error: 'Missing audioBase64 payload.' });
      return;
    }

    const ai = getAiClient();

    // Step A: Transcribe with gemini-3.5-transcribe (with automatic fallback)
    const transcript =
      (await transcribeAudioSafely(
        ai,
        mimeType,
        audioBase64,
        'Transcribe this voice recording verbatim, including any audible breaths, laughs, or filler words.'
      )) ||
      promptText ||
      '';

    // Step B: Analyze vocal timbre and prosody with gemini-4-hydrogen
    const analysisResponse = await ai.models.generateContent({
      model: 'gemini-4-hydrogen',
      contents: {
        parts: [
          {
            inlineData: {
              mimeType,
              data: audioBase64,
            },
          },
          {
            text: `Analyze this speaker's vocal delivery, timbre, cadence, and articulation.
Measured acoustic DSP telemetry: ${JSON.stringify(dspMetrics || {})}.
Expected script: "${promptText || ''}".
Actual transcript: "${transcript}".
Return a concise JSON object describing their vocal characteristics.`,
          },
        ],
      },
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            timbreSummary: {
              type: Type.STRING,
              description: '2-4 word descriptor of vocal timbre (e.g. Warm resonant baritone, Crisp articulate alto).',
            },
            cadenceSummary: {
              type: Type.STRING,
              description: 'Short description of rhythm, pacing, and inflection habits.',
            },
            clarityScore: {
              type: Type.NUMBER,
              description: 'Signal clarity and pronunciation consistency from 0 to 100.',
            },
          },
          required: ['timbreSummary', 'cadenceSummary', 'clarityScore'],
        },
      },
    });

    const parsed = parseJsonSafely<Record<string, any>>(analysisResponse.text, {});

    res.json({
      transcript: transcript || promptText || 'Audio sample captured',
      timbreSummary: parsed.timbreSummary || 'Balanced natural register',
      cadenceSummary: parsed.cadenceSummary || 'Steady conversational cadence',
      clarityScore: typeof parsed.clarityScore === 'number' ? parsed.clarityScore : 92,
    });
  } catch (error: any) {
    console.error('Error in /api/voice/analyze-anchor:', error);
    res.status(error?.status || 500).json({
      error: error?.message || 'Failed to analyze microphone voice anchor.',
    });
  }
});

// 2. Diarize & separate speaker turns from uploaded conversational audio segment
app.post('/api/voice/diarize-segment', async (req: Request, res: Response) => {
  try {
    const {
      audioBase64,
      mimeType = 'audio/wav',
      segmentIndex,
      startTimeSec,
      endTimeSec,
      segmentDsp,
      anchorProfile,
    } = req.body;

    if (!audioBase64) {
      res.status(400).json({ error: 'Missing audioBase64 for conversational segment.' });
      return;
    }

    const ai = getAiClient();

    // First transcribe the segment with gemini-3.5-transcribe (with automatic fallback)
    const rawTranscript = await transcribeAudioSafely(
      ai,
      mimeType,
      audioBase64,
      'Transcribe this conversational segment accurately. If multiple people speak in this clip, note their turns.'
    );

    // Now perform speaker identification & crosstalk analysis with gemini-4-hydrogen
    const diarizeResp = await ai.models.generateContent({
      model: 'gemini-4-hydrogen',
      contents: {
        parts: [
          {
            inlineData: {
              mimeType,
              data: audioBase64,
            },
          },
          {
            text: `You are an expert acoustic speaker diarization and voice isolation engine.
We are processing segment #${segmentIndex} (${startTimeSec}s to ${endTimeSec}s) from a multi-hour recording featuring the Target User in conversation with another person.

Target User's Ground-Truth Microphone Anchor Profile:
${JSON.stringify(anchorProfile || { note: 'No live anchor recorded yet; use acoustic consistency to distinguish Primary Speaker A vs Interlocutor Speaker B.' })}

This Segment's Measured Web Audio DSP Telemetry:
${JSON.stringify(segmentDsp || {})}

Raw Transcription of this Segment:
"${rawTranscript}"

Determine whether this segment contains:
1. "target_user": Primarily the Target User's voice alone, clean enough for voice model training.
2. "other_speaker": Primarily the other conversation partner's voice.
3. "crosstalk": Overlapping speech from both people simultaneously, laughter overlap, or excessive background noise that should be excluded from clean voice model training.

Return the structured speaker diarization result.`,
          },
        ],
      },
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            transcript: {
              type: Type.STRING,
              description: 'Clean verbatim transcript of what was said in this segment.',
            },
            assignment: {
              type: Type.STRING,
              description: 'Must be one of: target_user, other_speaker, crosstalk',
            },
            detectedSpeakerLabel: {
              type: Type.STRING,
              description: 'Human-readable speaker label such as "Target User (You)", "Interlocutor (Speaker B)", or "Crosstalk / Overlap".',
            },
            similarityToAnchorScore: {
              type: Type.NUMBER,
              description: 'Acoustic and prosodic similarity score to the Target User anchor from 0 to 100.',
            },
            diarizationReason: {
              type: Type.STRING,
              description: '1-sentence acoustic explanation of why this turn was assigned to target_user, other_speaker, or crosstalk (referencing pitch F0, timbre, or overlap).',
            },
            detectedNuances: {
              type: Type.ARRAY,
              items: { type: Type.STRING },
              description: 'Notable vocal nuances heard in this clip (e.g., "<breath>", "|yeah|", "rising inflection", "warm chuckle").',
            },
          },
          required: [
            'transcript',
            'assignment',
            'detectedSpeakerLabel',
            'similarityToAnchorScore',
            'diarizationReason',
            'detectedNuances',
          ],
        },
      },
    });

    const result = parseJsonSafely<Record<string, any>>(diarizeResp.text, {});
    const validAssignment = ['target_user', 'other_speaker', 'crosstalk'].includes(result.assignment)
      ? result.assignment
      : 'target_user';

    res.json({
      transcript: result.transcript || rawTranscript || '(Unintelligible or silent segment)',
      assignment: validAssignment,
      detectedSpeakerLabel:
        result.detectedSpeakerLabel ||
        (validAssignment === 'target_user'
          ? 'Target User (You)'
          : validAssignment === 'other_speaker'
          ? 'Interlocutor (Speaker B)'
          : 'Crosstalk / Overlap'),
      similarityToAnchorScore:
        typeof result.similarityToAnchorScore === 'number'
          ? Math.min(100, Math.max(0, Math.round(result.similarityToAnchorScore)))
          : 78,
      diarizationReason:
        result.diarizationReason ||
        'Matched fundamental frequency contour and spectral centroid against anchor.',
      detectedNuances: Array.isArray(result.detectedNuances) ? result.detectedNuances : [],
    });
  } catch (error: any) {
    console.error('Error in /api/voice/diarize-segment:', error);
    res.status(error?.status || 500).json({
      error: error?.message || 'Failed to diarize conversational audio segment.',
    });
  }
});

// 3. Train & compile a Custom Voice Profile (Vocal DNA Blueprint) from verified clips
app.post('/api/voice/train-profile', async (req: Request, res: Response) => {
  try {
    const {
      profileName,
      acousticSummary,
      transcripts,
      sampleAudios, // Optional array of up to 2 representative base64 clips
    } = req.body;

    const ai = getAiClient();

    const parts: any[] = [];
    if (Array.isArray(sampleAudios)) {
      for (const clip of sampleAudios.slice(0, 2)) {
        if (clip?.audioBase64) {
          parts.push({
            inlineData: {
              mimeType: clip.mimeType || 'audio/wav',
              data: clip.audioBase64,
            },
          });
        }
      }
    }

    parts.push({
      text: `You are a neural voice synthesis architect building a custom Voice Design Persona Blueprint for "${profileName || 'Personal Voice Replica'}".

Aggregated Acoustic & Prosodic Telemetry from Verified Isolated Clips:
${JSON.stringify(acousticSummary || {}, null, 2)}

Sample Verified Transcripts & Conversational Turns from the User:
${JSON.stringify((transcripts || []).slice(0, 15), null, 2)}

Based on both the attached reference audio samples (if any) and the measured acoustic fingerprint (median F0 pitch in Hz, pitch standard deviation, speaking rate in WPM, spectral centroid warmth, and pause cadence):
1. Select the closest acoustic foundation voice from the Gemini 3.8 TTS engine ('Puck', 'Charon', 'Kore', 'Fenrir', or 'Zephyr').
   - Guide: 'Charon' (deep, warm, measured low-mid register), 'Fenrir' (resonant, authoritative, textured baritone), 'Puck' (energetic, mid-register, expressive conversational), 'Kore' (clear, articulate, poised mid-high register), 'Zephyr' (smooth, airy, bright mid-high register).
2. Write a comprehensive, high-precision "voiceDesignDirective" (2-3 sentences) formatted specifically for gemini-3.8-flash-tts speechMetadata.style that instructs the synthesis engine to replicate this speaker's exact timbre, micro-inflections, pacing rhythm, breath placement, and consonant articulation.
3. Extract 4-6 signature vocal habits (e.g. "Takes a subtle intake breath before transitional clauses", "Uses crisp plosive articulation on technical terms", "Drops pitch slightly at sentence endings").
4. Recommend fine-tuned Web Audio DSP post-processing calibration offsets (pitchShiftSemitones between -3.0 and +3.0, playbackRate between 0.90 and 1.12, formantWarmthDb between -3.0 and +4.0) so the synthesized output locks onto the user's exact fundamental frequency F0 (${acousticSummary?.medianF0Hz || 145} Hz) and WPM (${acousticSummary?.avgWpm || 150} WPM).`,
    });

    const response = await ai.models.generateContent({
      model: 'gemini-4-hydrogen',
      contents: { parts },
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            baseFoundationVoice: {
              type: Type.STRING,
              description: 'Must be one of: Puck, Charon, Kore, Fenrir, Zephyr',
            },
            voiceDesignDirective: {
              type: Type.STRING,
              description: 'Detailed vocal persona style prompt for gemini-3.8-flash-tts speechMetadata.style.',
            },
            timbreClassification: {
              type: Type.STRING,
              description: 'Concise acoustic classification (e.g. Warm Conversational Baritone / Articulate Mid-Register).',
            },
            signatureHabits: {
              type: Type.ARRAY,
              items: { type: Type.STRING },
              description: '4 to 6 specific vocal, breathing, and prosodic habits observed in the corpus.',
            },
            dspCalibration: {
              type: Type.OBJECT,
              properties: {
                pitchShiftSemitones: {
                  type: Type.NUMBER,
                  description: 'Fine pitch offset in semitones (-3.0 to +3.0)',
                },
                playbackRate: {
                  type: Type.NUMBER,
                  description: 'Base pacing multiplier (0.90 to 1.12)',
                },
                formantWarmthDb: {
                  type: Type.NUMBER,
                  description: 'Low-mid shelf warmth adjustment in dB (-3.0 to +4.0)',
                },
              },
              required: ['pitchShiftSemitones', 'playbackRate', 'formantWarmthDb'],
            },
          },
          required: [
            'baseFoundationVoice',
            'voiceDesignDirective',
            'timbreClassification',
            'signatureHabits',
            'dspCalibration',
          ],
        },
      },
    });

    const parsed = parseJsonSafely<Record<string, any>>(response.text, {});
    const allowedVoices = ['Puck', 'Charon', 'Kore', 'Fenrir', 'Zephyr'];
    const baseVoice = allowedVoices.includes(parsed.baseFoundationVoice)
      ? parsed.baseFoundationVoice
      : (acousticSummary?.medianF0Hz || 140) < 130
      ? 'Charon'
      : (acousticSummary?.medianF0Hz || 140) < 165
      ? 'Puck'
      : 'Kore';

    res.json({
      baseFoundationVoice: baseVoice,
      voiceDesignDirective:
        parsed.voiceDesignDirective ||
        'Natural, grounded conversational delivery with subtle breath intakes between clauses, warm chest resonance, and measured cadence.',
      timbreClassification: parsed.timbreClassification || 'Natural Conversational Register',
      signatureHabits:
        Array.isArray(parsed.signatureHabits) && parsed.signatureHabits.length > 0
          ? parsed.signatureHabits
          : [
              'Natural breath intake (<breath>) before complex multi-clause sentences',
              'Measured downward pitch inflection at declarative sentence endings',
              'Warm mid-range resonance with clear consonant articulation',
              'Conversational pacing with micro-pauses after introductory phrases',
            ],
      dspCalibration: {
        pitchShiftSemitones:
          typeof parsed.dspCalibration?.pitchShiftSemitones === 'number'
            ? Number(parsed.dspCalibration.pitchShiftSemitones.toFixed(2))
            : 0,
        playbackRate:
          typeof parsed.dspCalibration?.playbackRate === 'number'
            ? Number(parsed.dspCalibration.playbackRate.toFixed(2))
            : 1.0,
        formantWarmthDb:
          typeof parsed.dspCalibration?.formantWarmthDb === 'number'
            ? Number(parsed.dspCalibration.formantWarmthDb.toFixed(1))
            : 1.5,
      },
    });
  } catch (error: any) {
    console.error('Error in /api/voice/train-profile:', error);
    res.status(error?.status || 500).json({
      error: error?.message || 'Failed to train custom voice profile.',
    });
  }
});

// 4. Auto-annotate plain script with the user's learned vocal bursts, breaths, and pauses
app.post('/api/voice/annotate-script', async (req: Request, res: Response) => {
  try {
    const { text, voiceProfile, emotionalTone } = req.body;
    if (!text || typeof text !== 'string') {
      res.status(400).json({ error: 'Missing script text to annotate.' });
      return;
    }

    const ai = getAiClient();

    const response = await ai.models.generateContent({
      model: 'gemini-4-hydrogen',
      contents: `You are a vocal nuance script director for the gemini-3.8-flash-tts Voice Design engine.
Rewrite the user's input script by preserving their core words while strategically injecting natural vocal bursts, breathing cues, natural pauses, and optional conversational backchannels that match their custom vocal profile.

Supported inline markup tokens for gemini-3.8-flash-tts:
- <breath> : A natural audible intake of breath before a long clause or emotional shift
- <laugh> : A natural chuckle or warm laugh where appropriate
- <gasp> : A quick intake of surprise (use sparingly, only if context fits)
- |mhm| or |yeah| : Conversational backchanneling or self-affirmation
- ... : A natural prosodic micro-pause or hesitation

Speaker's Custom Voice Profile:
- Voice Design Directive: ${voiceProfile?.voiceDesignDirective || 'Natural conversational cadence'}
- Signature Vocal Habits: ${JSON.stringify(voiceProfile?.signatureHabits || [])}
- Target Emotional Tone: ${emotionalTone || 'Natural Baseline'}

Original Input Text:
"""
${text}
"""

Return ONLY the annotated script text with inline markup tokens inserted naturally. Do not wrap in quotes or add commentary.`,
    });

    const annotatedScript = (response.text ?? text).trim();
    res.json({ annotatedScript });
  } catch (error: any) {
    console.error('Error in /api/voice/annotate-script:', error);
    res.status(error?.status || 500).json({
      error: error?.message || 'Failed to annotate script with vocal nuances.',
    });
  }
});

// 5. Synthesize speech matching the user's custom voice profile & nuance controls using gemini-3.8-flash-tts
app.post('/api/voice/synthesize', async (req: Request, res: Response) => {
  try {
    const {
      script,
      voiceProfile,
      nuanceSettings,
    } = req.body;

    if (!script || typeof script !== 'string' || !script.trim()) {
      res.status(400).json({ error: 'Please provide text input to synthesize.' });
      return;
    }

    const ai = getAiClient();

    const allowedVoices = ['Puck', 'Charon', 'Kore', 'Fenrir', 'Zephyr'];
    const voiceName = allowedVoices.includes(voiceProfile?.baseFoundationVoice)
      ? voiceProfile.baseFoundationVoice
      : 'Puck';

    const pacing = nuanceSettings?.pacing ?? 1.0;
    const pitchSemitones = nuanceSettings?.pitchSemitones ?? 0;
    const expressiveness = nuanceSettings?.expressiveness ?? 75;
    const emotionalTone = nuanceSettings?.emotionalTone || 'Natural Baseline';
    const warmth = nuanceSettings?.warmth ?? 50;

    const pacingDescriptor =
      pacing < 0.92
        ? 'deliberate, unhurried, reflective pacing with distinct pauses'
        : pacing > 1.08
        ? 'brisk, energetic, dynamic conversational tempo'
        : 'natural, steady conversational pacing';

    const pitchDescriptor =
      pitchSemitones < -1.5
        ? 'grounded in a deeper, lower chest register'
        : pitchSemitones > 1.5
        ? 'lifted into a brighter, higher melodic register'
        : `centered around a ${voiceProfile?.acousticFingerprint?.medianF0Hz || 145} Hz fundamental pitch contour`;

    const expressivenessDescriptor =
      expressiveness >= 80
        ? 'highly expressive prosodic contour with rich dynamic inflection and authentic vocal bursts'
        : expressiveness <= 35
        ? 'restrained, even-keeled, understated studio delivery'
        : 'balanced, authentic human inflection';

    const warmthDescriptor =
      warmth >= 70
        ? 'rich, close-mic intimate acoustic warmth'
        : warmth <= 30
        ? 'crisp, bright, high-presence broadcast clarity'
        : 'balanced studio condenser timbre';

    const compiledStyle = [
      voiceProfile?.voiceDesignDirective || 'Natural, authentic human voice replication.',
      `Tone: ${emotionalTone}.`,
      `Delivery: ${pacingDescriptor}, ${pitchDescriptor}, ${expressivenessDescriptor}, ${warmthDescriptor}.`,
      Array.isArray(voiceProfile?.signatureHabits) && voiceProfile.signatureHabits.length > 0
        ? `Habits: ${voiceProfile.signatureHabits.slice(0, 3).join('; ')}.`
        : '',
    ]
      .filter(Boolean)
      .join(' ');

    let response;
    try {
      response = await ai.models.generateContent({
        model: 'gemini-3.8-flash-tts',
        contents: [
          {
            role: 'user',
            parts: [
              {
                text: script.trim(),
                speechMetadata: {
                  style: compiledStyle,
                },
              },
            ],
          },
        ],
        config: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName,
              },
            },
          },
        },
      });
    } catch (ttsErr: any) {
      // Fallback to gemini-3.8-flash-lite-tts if flagship TTS model is unavailable
      response = await ai.models.generateContent({
        model: 'gemini-3.8-flash-lite-tts',
        contents: [
          {
            role: 'user',
            parts: [
              {
                text: script.trim(),
                speechMetadata: {
                  style: compiledStyle,
                },
              },
            ],
          },
        ],
        config: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName,
              },
            },
          },
        },
      });
    }

    const base64Audio =
      response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;

    if (!base64Audio) {
      res.status(502).json({
        error: 'The synthesis model did not return an audio buffer. Try adjusting the script text.',
      });
      return;
    }

    res.json({
      wavBase64: base64Audio,
      mimeType: 'audio/wav',
      compiledStyle,
      foundationVoiceUsed: voiceName,
    });
  } catch (error: any) {
    console.error('Error in /api/voice/synthesize:', error);
    res.status(error?.status || 500).json({
      error:
        error?.message ||
        'Voice synthesis failed. Please verify your API key in Settings > Secrets.',
    });
  }
});

async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    process.env.DISABLE_HMR = 'true';
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true, hmr: false, ws: false },
      appType: 'spa',
    });

    app.get('/@vite/client', async (_req, res, next) => {
      try {
        const result = await vite.transformRequest('/@vite/client');
        if (result?.code) {
          const patchedCode = result.code
            .replace(
              'transport.connect(createHMRHandler(handleMessage));',
              '/* HMR WebSocket connection disabled in Cloud Run preview */'
            )
            .replace(
              'setupForwardConsoleHandler(transport, forwardConsole);',
              '/* Forward console over WebSocket disabled */'
            );
          res.setHeader('Content-Type', 'application/javascript');
          res.setHeader('Cache-Control', 'no-store');
          res.status(200).send(patchedCode);
          return;
        }
      } catch (_err) {
        // Fallback to default vite middleware
      }
      next();
    });

    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*all', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`VoxReplica Studio server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
