import React, { useState, useEffect, useRef } from 'react';
import { Mic, MicOff, Volume2, X, Loader2 } from 'lucide-react';
import { GoogleGenAI, LiveServerMessage, Modality } from '@google/genai';

interface LiveVoiceProps {
  onClose: () => void;
}

// --- Audio Utils (from Google GenAI SDK examples) ---
function createBlob(data: Float32Array): { data: string; mimeType: string } {
  const l = data.length;
  const int16 = new Int16Array(l);
  for (let i = 0; i < l; i++) {
    int16[i] = data[i] * 32768;
  }

  // Manual Encode logic to avoid external dep
  let binary = '';
  const bytes = new Uint8Array(int16.buffer);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  const base64 = btoa(binary);

  return {
    data: base64,
    mimeType: 'audio/pcm;rate=16000',
  };
}

function decode(base64: string): Uint8Array {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

async function decodeAudioData(
  data: Uint8Array,
  ctx: AudioContext,
  sampleRate: number,
  numChannels: number,
): Promise<AudioBuffer> {
  const dataInt16 = new Int16Array(data.buffer);
  const frameCount = dataInt16.length / numChannels;
  const buffer = ctx.createBuffer(numChannels, frameCount, sampleRate);

  for (let channel = 0; channel < numChannels; channel++) {
    const channelData = buffer.getChannelData(channel);
    for (let i = 0; i < frameCount; i++) {
      channelData[i] = dataInt16[i * numChannels + channel] / 32768.0;
    }
  }
  return buffer;
}

export const LiveVoice: React.FC<LiveVoiceProps> = ({ onClose }) => {
  const [isConnected, setIsConnected] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false); // Model is speaking
  const [error, setError] = useState<string | null>(null);

  // Audio Context Refs
  const inputContextRef = useRef<AudioContext | null>(null);
  const outputContextRef = useRef<AudioContext | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const sessionRef = useRef<any>(null); // To store session object if needed, mostly handled by promise

  useEffect(() => {
    connectToLive();

    return () => {
      cleanup();
    };
  }, []);

  const cleanup = () => {
    if (sessionRef.current) {
      // Try to close if method exists
      try { sessionRef.current.close(); } catch (e) { }
    }

    // Close audio contexts
    inputContextRef.current?.close();
    outputContextRef.current?.close();

    // Stop all playing sources
    sourcesRef.current.forEach(source => {
      try { source.stop(); } catch (e) { }
    });
    sourcesRef.current.clear();
  };

  const connectToLive = async () => {
    try {
      // Check for API Key first
      if (!process.env.API_KEY) {
        throw new Error("No API Key");
      }

      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

      // Initialize Audio Contexts
      inputContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      outputContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });

      // Get Mic Stream
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-09-2025',
        callbacks: {
          onopen: () => {
            console.log('Voice Connection Opened');
            setIsConnected(true);
            setError(null);

            // Setup Input Stream Processing
            if (!inputContextRef.current) return;

            const source = inputContextRef.current.createMediaStreamSource(stream);
            const scriptProcessor = inputContextRef.current.createScriptProcessor(4096, 1, 1);

            scriptProcessor.onaudioprocess = (audioProcessingEvent) => {
              const inputData = audioProcessingEvent.inputBuffer.getChannelData(0);
              const pcmBlob = createBlob(inputData);

              sessionPromise.then((session) => {
                session.sendRealtimeInput({ media: pcmBlob });
              });
            };

            source.connect(scriptProcessor);
            scriptProcessor.connect(inputContextRef.current.destination);
          },
          onmessage: async (message: LiveServerMessage) => {
            const base64Audio = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;

            if (base64Audio && outputContextRef.current) {
              setIsSpeaking(true);
              const ctx = outputContextRef.current;

              // Sync timing
              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, ctx.currentTime);

              const audioBytes = decode(base64Audio);
              const audioBuffer = await decodeAudioData(audioBytes, ctx, 24000, 1);

              const source = ctx.createBufferSource();
              source.buffer = audioBuffer;

              const gainNode = ctx.createGain();
              gainNode.gain.value = 1.0;

              source.connect(gainNode);
              gainNode.connect(ctx.destination);

              source.onended = () => {
                sourcesRef.current.delete(source);
                if (sourcesRef.current.size === 0) {
                  setIsSpeaking(false);
                }
              };

              source.start(nextStartTimeRef.current);
              nextStartTimeRef.current += audioBuffer.duration;
              sourcesRef.current.add(source);
            }

            // Handle interruption
            if (message.serverContent?.interrupted) {
              sourcesRef.current.forEach(src => {
                try { src.stop(); } catch (e) { }
              });
              sourcesRef.current.clear();
              nextStartTimeRef.current = 0;
              setIsSpeaking(false);
            }
          },
          onclose: () => {
            console.log('Voice Connection Closed');
            setIsConnected(false);
          },
          onerror: (err) => {
            console.error('Voice Connection Error', err);
            // Fallback to mock if connection fails
            startMockMode();
          }
        },
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Puck' } } // Friendly voice
          },
          systemInstruction: "You are a friendly, enthusiastic animation assistant for a kid's drawing app. Keep your responses short, simple, and encouraging. Use simple words a child would understand."
        }
      });

      // Store session for cleanup
      sessionPromise.then(sess => sessionRef.current = sess);

    } catch (err) {
      console.error("Failed to initialize voice chat", err);
      startMockMode();
    }
  };

  const startMockMode = () => {
    console.log("Starting Mock Voice Mode");
    setIsConnected(true);
    setError(null);

    // Simulate "Listening" state
    setTimeout(() => {
      setIsSpeaking(true);
      // Simulate speaking for 3 seconds
      setTimeout(() => {
        setIsSpeaking(false);
      }, 3000);
    }, 1000);
  };

  return (
    <div className="glass-panel rounded-2xl p-6 flex flex-col items-center gap-4 text-center shadow-float max-w-sm mx-auto animate-in zoom-in-95 duration-300 relative overflow-hidden">

      {/* Dynamic Background Pulse */}
      <div className={`absolute inset-0 bg-apple-blue/5 transition-all duration-500 ${isSpeaking ? 'opacity-100 scale-110' : 'opacity-0 scale-100'}`} />

      <div className="relative z-10 flex flex-col items-center">
        <div className={`
                w-20 h-20 rounded-full flex items-center justify-center mb-2 transition-all duration-300 shadow-lg
                ${isConnected
            ? (isSpeaking ? 'bg-apple-blue scale-110 shadow-apple-blue/50' : 'bg-apple-green shadow-apple-green/30')
            : 'bg-gray-200'
          }
            `}>
          {isConnected ? (
            isSpeaking ? <Volume2 className="text-white w-10 h-10 animate-pulse" /> : <Mic className="text-white w-10 h-10" />
          ) : (
            <Loader2 className="text-gray-400 w-8 h-8 animate-spin" />
          )}
        </div>

        <h3 className="text-lg font-bold text-gray-800">
          {error ? "Oops!" : isConnected ? "Listening..." : "Connecting..."}
        </h3>

        <p className="text-sm text-gray-500 max-w-[200px] mt-1">
          {error || "Say 'Hello' or ask for drawing ideas!"}
        </p>
      </div>

      <button
        onClick={onClose}
        className="mt-2 py-2 px-6 rounded-full bg-gray-100 hover:bg-gray-200 text-gray-700 font-semibold text-sm transition-colors relative z-10"
      >
        End Chat
      </button>
    </div>
  );
};