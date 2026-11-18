// Tempo: estimate BPM and the first downbeat from a song (in the browser, Web Audio), tap tempo, and a song
// player whose beat grid the editor preview can lock to.

/** Onset strength envelope (~86 frames/s): positive changes in low-band and full-band energy. */
function onsetEnvelope(samples, sr) {
  const hop = Math.round(sr / 86);
  const frames = Math.floor(samples.length / hop);
  const low = new Float32Array(frames), full = new Float32Array(frames);
  let lp = 0;
  const a = Math.exp(-2 * Math.PI * 150 / sr); // one-pole low-pass ≈150 Hz (kick, bass)
  for (let f = 0; f < frames; f++) {
    let el = 0, ef = 0;
    for (let i = f * hop, end = i + hop; i < end; i++) {
      const x = samples[i];
      lp = a * lp + (1 - a) * x;
      el += lp * lp;
      ef += x * x;
    }
    low[f] = Math.log1p(1000 * el / hop);
    full[f] = Math.log1p(1000 * ef / hop);
  }
  const env = new Float32Array(frames);
  for (let f = 1; f < frames; f++) env[f] = Math.max(0, low[f] - low[f - 1]) * 1.5 + Math.max(0, full[f] - full[f - 1]);
  // Remove the slow trend so loud passages don't dominate.
  const w = 43;
  const out = new Float32Array(frames);
  let sum = 0;
  for (let f = 0; f < frames; f++) {
    sum += env[f];
    if (f >= w) sum -= env[f - w];
    out[f] = Math.max(0, env[f] - sum / Math.min(f + 1, w));
  }
  return { env: out, fps: sr / hop };
}

/** Estimate tempo (60–190 BPM, preferring 90–140) and the first downbeat time from decoded audio. */
export function analyseTempo(audioBuffer) {
  const sr = audioBuffer.sampleRate;
  const ch = audioBuffer.numberOfChannels;
  const len = audioBuffer.length;
  const mono = new Float32Array(len);
  for (let c = 0; c < ch; c++) { const d = audioBuffer.getChannelData(c); for (let i = 0; i < len; i++) mono[i] += d[i] / ch; }
  const { env, fps } = onsetEnvelope(mono, sr);

  // Autocorrelation over the plausible beat-period range, with harmonics reinforcing the true period.
  const ac = (lag) => { let s = 0; for (let i = lag; i < env.length; i++) s += env[i] * env[i - lag]; return s / (env.length - lag); };
  const minLag = Math.floor((60 / 185) * fps), maxLag = Math.ceil((60 / 65) * fps);
  const acs = new Map();
  const A = (lag) => { if (!acs.has(lag)) acs.set(lag, ac(lag)); return acs.get(lag); };
  let best = null;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const bpm = (60 * fps) / lag;
    const prior = Math.exp(-0.5 * (Math.log2(bpm / 118) / 0.55) ** 2); // gentle preference around 118 BPM
    // The beat, the bar-level multiple and the 8th-note subdivision all reinforce the true tempo; this keeps
    // a 140 BPM song with busy 8ths from reading as 93 (a 3:2 confusion).
    const score = (A(lag) + 0.5 * A(lag * 2) + 0.5 * A(Math.round(lag / 2))) * (0.6 + 0.4 * prior);
    if (!best || score > best.score) best = { lag, score };
  }
  // Refine: over a whole song a slightly wrong tempo drifts off the beats, so test tempos within ±4% (0.1 BPM
  // steps) against a beat grid at every phase, and keep the one that lands on the most onset energy.
  const at = (x) => { const i = Math.floor(x), f = x - i; return (env[i] || 0) * (1 - f) + (env[i + 1] || 0) * f; };
  const coarse = (60 * fps) / best.lag;
  let bpm = coarse, bestPhase = 0, bestS = -1;
  for (let b = coarse * 0.96; b <= coarse * 1.04; b += 0.1) {
    const period = (60 / b) * fps;
    for (let p = 0; p < period; p += 0.5) {
      let s = 0;
      for (let x = p; x < env.length - 1; x += period) s += at(x);
      if (s > bestS) { bestS = s; bestPhase = p; bpm = b; }
    }
  }
  bpm = Math.round(bpm * 10) / 10;
  const period = (60 / bpm) * fps;
  const beatEnergy = [0, 0, 0, 0];
  let k = 0;
  for (let x = bestPhase; x < env.length; x += period, k++) beatEnergy[k % 4] += env[Math.round(x)] || 0;
  const bar = beatEnergy.indexOf(Math.max(...beatEnergy));
  const firstBeat = bestPhase / fps;
  const downbeat = firstBeat + bar * (60 / bpm);
  const confidence = Math.min(1, bestS / (env.reduce((a, b) => a + b, 0) / period + 1e-9) / 2.5);
  return { bpm, downbeat, confidence, duration: audioBuffer.duration };
}

/** Tap tempo: average of the last taps (resets after a 2 s pause). */
export class Tapper {
  constructor() { this.taps = []; }
  tap(now = performance.now()) {
    if (this.taps.length && now - this.taps[this.taps.length - 1] > 2000) this.taps = [];
    this.taps.push(now);
    if (this.taps.length > 8) this.taps.shift();
    if (this.taps.length < 3) return null;
    const span = this.taps[this.taps.length - 1] - this.taps[0];
    return Math.round((60000 * (this.taps.length - 1)) / span * 10) / 10;
  }
}

/** Plays a song and maps song time to the beat grid. */
export class SongPlayer {
  constructor() {
    this.ctx = null;
    this.buffer = null;
    this.source = null;
    this.startedAt = 0; // ctx time when song time 0 would have started
    this.offset = 0;    // paused position, seconds
    this.playing = false;
    this.name = '';
  }

  async load(file) {
    this.stop();
    this.ctx ||= new AudioContext();
    const data = await file.arrayBuffer();
    this.buffer = await this.ctx.decodeAudioData(data);
    this.name = file.name;
    this.offset = 0;
    return this.buffer;
  }

  get time() {
    if (!this.buffer) return 0;
    return this.playing ? this.ctx.currentTime - this.startedAt : this.offset;
  }

  play() {
    if (!this.buffer || this.playing) return;
    this.ctx.resume();
    this.source = this.ctx.createBufferSource();
    this.source.buffer = this.buffer;
    this.source.connect(this.ctx.destination);
    this.source.onended = () => { if (this.playing && this.time >= this.buffer.duration - 0.05) { this.playing = false; this.offset = 0; } };
    this.startedAt = this.ctx.currentTime - this.offset;
    this.source.start(0, this.offset);
    this.playing = true;
  }

  pause() {
    if (!this.playing) return;
    this.offset = this.time;
    this.source.onended = null;
    this.source.stop();
    this.playing = false;
  }

  stop() {
    if (this.playing) this.pause();
    this.offset = 0;
  }

  seek(t) {
    const was = this.playing;
    if (was) this.pause();
    this.offset = Math.max(0, Math.min(this.buffer?.duration || 0, t));
    if (was) this.play();
  }

  /** performance.now() timestamp at which song time `t` happens (only meaningful while playing). */
  perfTimeOf(t) {
    return performance.now() - (this.time - t) * 1000;
  }
}
