import { useCallback, useEffect, useRef } from 'react';
import { toast } from 'sonner';
import {
  isVoiceSupported,
  startCapture,
  VoiceBusyError,
  type VoiceCaptureHandle,
} from '@/renderer/lib/voice';
import type { OrbState } from './Orb';

export interface UseSigmaVoiceArgs {
  composerRef: React.MutableRefObject<HTMLTextAreaElement | null>;
  sendPromptRef: React.MutableRefObject<(prompt: string) => Promise<void>>;
  setOrbState: React.Dispatch<React.SetStateAction<OrbState>>;
}

export interface UseSigmaVoiceReturn {
  onOrbClick: () => void;
}

/** V3-W15-003 — orb click toggles SigmaVoice capture. STANDBY → kick off
 *  a session and switch to LISTENING; click again to abort. The recognizer's
 *  final transcript is dispatched to `assistant.send` and the orb advances
 *  to THINKING. */
export function useSigmaVoice({
  composerRef,
  sendPromptRef,
  setOrbState,
}: UseSigmaVoiceArgs): UseSigmaVoiceReturn {
  const voiceHandleRef = useRef<VoiceCaptureHandle | null>(null);

  const onOrbClick = useCallback(() => {
    composerRef.current?.focus();
    if (voiceHandleRef.current) {
      voiceHandleRef.current.stop();
      voiceHandleRef.current = null;
      setOrbState('standby');
      return;
    }
    if (!isVoiceSupported()) {
      setOrbState((s) => (s === 'listening' ? 'standby' : 'listening'));
      toast.error('Voice not supported on this platform');
      return;
    }
    setOrbState('listening');
    void (async () => {
      try {
        const handle = await startCapture({
          source: 'assistant',
          onFinal: (text) => {
            voiceHandleRef.current = null;
            const trimmed = text.trim();
            if (!trimmed) {
              setOrbState('standby');
              return;
            }
            void sendPromptRef.current(trimmed);
          },
          onError: () => {
            voiceHandleRef.current = null;
            setOrbState('standby');
          },
        });
        voiceHandleRef.current = handle;
      } catch (err) {
        voiceHandleRef.current = null;
        setOrbState('standby');
        if (err instanceof VoiceBusyError) {
          toast.error('Another voice session is active');
        }
      }
    })();
    // All mutable values are accessed via refs — no re-bind needed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Stop any in-flight capture when the room unmounts.
  useEffect(() => {
    return () => {
      voiceHandleRef.current?.stop();
      voiceHandleRef.current = null;
    };
  }, []);

  return { onOrbClick };
}
