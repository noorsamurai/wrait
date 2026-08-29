/**
 * Alert tones, synthesised rather than shipped as audio files.
 *
 * Two reasons: the bundle stays a few kilobytes instead of carrying decoded
 * audio in memory, and a generated tone is identical on Windows, macOS and
 * iOS where system sounds are not.
 */

let context: AudioContext | null = null;

function audio(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  if (!context) context = new Ctor();
  return context;
}

/**
 * Browsers and both mobile webviews refuse to start audio until the user has
 * interacted with the page, so the context is resumed from the first gesture.
 * Without this the very first incoming alert would be silent.
 */
export function unlockAudio() {
  const ctx = audio();
  if (ctx && ctx.state === "suspended") void ctx.resume();
}

interface ToneSpec {
  frequency: number;
  start: number;
  duration: number;
  gain: number;
  type?: OscillatorType;
}

function play(tones: ToneSpec[], volume: number) {
  const ctx = audio();
  if (!ctx || volume <= 0) return;
  if (ctx.state === "suspended") void ctx.resume();

  const now = ctx.currentTime;
  for (const tone of tones) {
    const osc = ctx.createOscillator();
    const amp = ctx.createGain();
    osc.type = tone.type ?? "sine";
    osc.frequency.setValueAtTime(tone.frequency, now + tone.start);

    // A short attack and an exponential release: a linear fade sounds like a
    // click, an exponential one sounds like a struck bell.
    const peak = Math.max(0.0001, tone.gain * volume);
    amp.gain.setValueAtTime(0.0001, now + tone.start);
    amp.gain.exponentialRampToValueAtTime(peak, now + tone.start + 0.012);
    amp.gain.exponentialRampToValueAtTime(0.0001, now + tone.start + tone.duration);

    osc.connect(amp).connect(ctx.destination);
    osc.start(now + tone.start);
    osc.stop(now + tone.start + tone.duration + 0.05);
  }
}

/**
 * Two sounds, and only two.
 *
 * A set of tones people have to learn is a set of tones they ignore. One says
 * "there is a message", the other says "this one is for you now" - which is
 * the only distinction anyone in a clinic acts on differently.
 */

/** Quiet two-note rise: an ordinary incoming message. */
export function playMessageTone(volume = 0.6) {
  play(
    [
      { frequency: 784, start: 0, duration: 0.16, gain: 0.16 },
      { frequency: 1047, start: 0.09, duration: 0.22, gain: 0.13 },
    ],
    volume,
  );
}

/**
 * Lower, repeated and harder to mistake for the first: an alert, or somebody
 * asking you to come to their room.
 *
 * Deliberately not simply louder. A tone that differs only in volume is the
 * one that gets missed across a corridor, so this differs in pitch, in rhythm
 * and in timbre as well.
 */
export function playUrgentTone(volume = 0.9) {
  play(
    [
      { frequency: 660, start: 0, duration: 0.14, gain: 0.3, type: "triangle" },
      { frequency: 660, start: 0.18, duration: 0.14, gain: 0.3, type: "triangle" },
      { frequency: 880, start: 0.36, duration: 0.4, gain: 0.34, type: "triangle" },
    ],
    volume,
  );
}
