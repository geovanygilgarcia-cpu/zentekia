// Cliente de voz (ElevenLabs Agents). Se carga solo cuando el visitante toca "Llamar" (pesa ~400 kB),
// así el widget de chat sigue cargando rápido. Expone window.ZentekiaVoice.start(opciones).
import { Conversation } from '@elevenlabs/client'

window.ZentekiaVoice = {
  /**
   * @param {{ token: string, onStatus, onMode, onMessage, onEnd, onError }} o
   * @returns {Promise<{ id: string, end(): Promise<void>, mute(b: boolean): void, levels(): { input: number, output: number } }>}
   */
  async start(o) {
    const conv = await Conversation.startSession({
      conversationToken: o.token,
      connectionType: 'webrtc',
      onStatusChange: ({ status }) => o.onStatus?.(status),
      onModeChange: ({ mode }) => o.onMode?.(mode),
      onMessage: (m) => o.onMessage?.({ role: m.source === 'user' || m.role === 'user' ? 'user' : 'agent', text: m.message }),
      onDisconnect: (d) => o.onEnd?.(d?.reason || 'user'),
      onError: (msg) => o.onError?.(String(msg || 'error')),
    })
    return {
      id: conv.getId(),
      end: () => conv.endSession(),
      mute: (b) => conv.setMicMuted(b),
      levels: () => ({ input: conv.getInputVolume?.() || 0, output: conv.getOutputVolume?.() || 0 }),
    }
  },
}
