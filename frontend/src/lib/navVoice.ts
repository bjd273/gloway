// In-drive voice loop client. Holds a WebSocket open for the whole drive and
// runs a push-to-talk capture: tap once to record an utterance, tap again to
// send it. The server transcribes, interprets against live nav context, and
// replies with spoken text + an action the caller applies.
//
// STT/TTS themselves are not streamed — one recorded clip per utterance, and
// the reply is spoken client-side. The socket's job is the persistent, stateful
// session (one connection per drive, nav context carried per utterance), which
// also leaves room to later push proactive spoken guidance from the server.
//
// The push-to-talk trigger is deliberately isolated from the framing/socket
// code so a hands-free VAD auto-segmenter can replace `toggle()` later without
// touching the transport.
import { toReplyResult, voiceSocketUrl, type ReplyResult, type RouteOption } from './api'
import { startVoiceRecorder, type VoiceRecorder } from './recorder'

export interface NavContext {
  destLabel: string | null
  progress: number
  minutesRemaining: number | null
  nextManeuver: string | null
  /** Distance to that maneuver. Null before a drive starts tracking steps. */
  metersToManeuver?: number | null
}

export type NavVoiceState = 'connecting' | 'idle' | 'listening' | 'thinking' | 'error' | 'closed'

interface NavVoiceHandlers {
  /** What the server heard (may be empty on silence). */
  onTranscript(text: string): void
  /** A spoken reply + the action to apply (speak + applyReplyResult live here). */
  onReply(result: ReplyResult): void
  onState(state: NavVoiceState): void
  /** Live nav context, read fresh at send time. */
  getNavContext(): NavContext
  /** Current route alternates, read fresh at send time. */
  getRouteOptions(): RouteOption[]
}

interface ServerFrame {
  type?: string
  text?: string
  action?: Record<string, unknown>
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onloadend = () => {
      const result = reader.result as string
      // Strip the "data:<mime>;base64," prefix the DataURL carries.
      resolve(result.slice(result.indexOf(',') + 1))
    }
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

export class NavVoiceController {
  private ws: WebSocket | null = null
  private recorder: VoiceRecorder | null = null
  private listening = false
  private closedByUs = false

  private readonly tripId: string
  private readonly handlers: NavVoiceHandlers

  constructor(tripId: string, handlers: NavVoiceHandlers) {
    this.tripId = tripId
    this.handlers = handlers
  }

  start(): void {
    this.closedByUs = false
    this.handlers.onState('connecting')
    try {
      this.ws = new WebSocket(voiceSocketUrl(this.tripId))
    } catch {
      this.handlers.onState('error')
      return
    }
    this.ws.onopen = () => this.handlers.onState('idle')
    this.ws.onmessage = (ev) => this.onMessage(ev)
    this.ws.onerror = () => {
      if (!this.closedByUs) this.handlers.onState('error')
    }
    this.ws.onclose = () => {
      if (!this.closedByUs) this.handlers.onState('closed')
    }
  }

  stop(): void {
    this.closedByUs = true
    this.recorder?.discard()
    this.recorder = null
    this.listening = false
    this.ws?.close()
    this.ws = null
  }

  isListening(): boolean {
    return this.listening
  }

  /** Push-to-talk toggle: first tap starts recording, second tap sends. */
  async toggle(): Promise<void> {
    if (this.listening) {
      await this.finishAndSend()
      return
    }
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.handlers.onState('error')
      return
    }
    // Mic vs. speaker contention: stop any read-aloud before capturing.
    window.speechSynthesis?.cancel()
    const rec = await startVoiceRecorder()
    if (!rec) {
      this.handlers.onState('error')
      return
    }
    this.recorder = rec
    this.listening = true
    this.handlers.onState('listening')
  }

  private async finishAndSend(): Promise<void> {
    const rec = this.recorder
    this.recorder = null
    this.listening = false
    if (!rec) return
    const blob = await rec.stop()
    if (!blob) {
      this.handlers.onState('idle')
      return
    }
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.handlers.onState('error')
      return
    }
    this.handlers.onState('thinking')
    const audioB64 = await blobToBase64(blob)
    this.ws.send(
      JSON.stringify({
        type: 'utterance',
        mime: blob.type || 'audio/webm',
        audio_b64: audioB64,
        nav: this.handlers.getNavContext(),
        routeOptions: this.handlers.getRouteOptions(),
      }),
    )
  }

  private onMessage(ev: MessageEvent): void {
    let msg: ServerFrame
    try {
      msg = JSON.parse(ev.data as string)
    } catch {
      return
    }
    if (msg.type === 'transcript') {
      this.handlers.onTranscript(msg.text ?? '')
      // Silence: no reply frame follows, so return to ready.
      if (!msg.text) this.handlers.onState('idle')
    } else if (msg.type === 'reply') {
      this.handlers.onReply(toReplyResult(msg.action ?? {}))
      this.handlers.onState('idle')
    } else if (msg.type === 'error') {
      this.handlers.onState('error')
    }
  }
}
