// ============================================================
// Audio System - Web Audio API with silent keepalive for iOS
// ============================================================
const Audio = {
  ctx: null,
  silentEl: null,
  initialized: false,
  sounds: {},  // pre-decoded AudioBuffers for MP3 files

  init() {
    if (this.initialized) return;
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.ctx.resume();

    // Play a silent buffer to unlock audio on iOS
    const buf = this.ctx.createBuffer(1, 1, 22050);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.ctx.destination);
    src.start(0);

    // Create silent audio element for background keepalive
    this._createSilentAudio();

    // Pre-load and decode MP3 files into Web Audio API buffers
    this._loadSound('work', 'sounds/work.mp3');
    this._loadSound('rest', 'sounds/Rest.mp3');
    this._loadSound('done', 'sounds/AllDone.mp3');

    // Re-resume on state change (e.g. after phone call interruption)
    this.ctx.addEventListener('statechange', () => {
      if (this.ctx.state === 'suspended' || this.ctx.state === 'interrupted') {
        this.ctx.resume();
      }
    });

    this.initialized = true;
  },

  _loadSound(name, url) {
    fetch(url)
      .then(r => r.arrayBuffer())
      .then(buf => this.ctx.decodeAudioData(buf))
      .then(decoded => { this.sounds[name] = decoded; })
      .catch(() => {});
  },

  _createSilentAudio() {
    const rate = 8000;
    const samples = rate; // 1 second
    const buf = new ArrayBuffer(44 + samples);
    const v = new DataView(buf);
    const w = (off, s) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };

    w(0, 'RIFF');
    v.setUint32(4, 36 + samples, true);
    w(8, 'WAVE');
    w(12, 'fmt ');
    v.setUint32(16, 16, true);
    v.setUint16(20, 1, true);   // PCM
    v.setUint16(22, 1, true);   // mono
    v.setUint32(24, rate, true);
    v.setUint32(28, rate, true);
    v.setUint16(32, 1, true);   // block align
    v.setUint16(34, 8, true);   // 8-bit
    w(36, 'data');
    v.setUint32(40, samples, true);
    for (let i = 0; i < samples; i++) v.setUint8(44 + i, 128); // silence

    const blob = new Blob([buf], { type: 'audio/wav' });
    this.silentEl = document.createElement('audio');
    this.silentEl.src = URL.createObjectURL(blob);
    this.silentEl.loop = true;
    this.silentEl.volume = 0.01;
  },

  startKeepAlive() {
    if (this.silentEl) this.silentEl.play().catch(() => {});
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
  },

  stopKeepAlive() {
    if (this.silentEl) this.silentEl.pause();
  },

  // Core beep using Web Audio API scheduling (precise, works when throttled)
  beep(freq, duration, delay, volume) {
    if (!this.ctx) return;
    delay = delay || 0;
    volume = volume || 0.5;
    const t = this.ctx.currentTime + delay;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.connect(gain);
    gain.connect(this.ctx.destination);
    osc.frequency.value = freq;
    osc.type = 'sine';
    gain.gain.setValueAtTime(volume, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + duration);
    osc.start(t);
    osc.stop(t + duration + 0.05);
  },

  playSound(name) {
    if (!this.ctx || !this.sounds[name]) return;
    const src = this.ctx.createBufferSource();
    const gain = this.ctx.createGain();
    src.buffer = this.sounds[name];
    src.connect(gain);
    gain.connect(this.ctx.destination);
    gain.gain.value = 1.0;
    src.start(this.ctx.currentTime);
  },

  countdown()  { this.beep(660, 0.15, 0, 0.5); },
  workStart()  { this.beep(880, 0.15, 0, 0.6); this.beep(880, 0.15, 0.2, 0.6); this.beep(1100, 0.3, 0.4, 0.7); setTimeout(() => this.playSound('work'), 800); },
  restStart()  { this.beep(440, 0.5, 0, 0.5); setTimeout(() => this.playSound('rest'), 600); },
  complete()   { this.beep(880, 0.2, 0, 0.5); this.beep(1100, 0.2, 0.25, 0.5); this.beep(1320, 0.2, 0.5, 0.5); this.beep(1760, 0.5, 0.75, 0.7); setTimeout(() => this.playSound('done'), 1400); }
};


// ============================================================
// Timer State Machine
// ============================================================
const Timer = {
  config: { work: 20, rest: 10, rounds: 8, prepare: 10 },
  state: 'idle',          // idle | prepare | work | rest | paused | complete
  pausedState: null,
  currentRound: 0,
  secondsLeft: 0,
  phaseDuration: 0,       // total seconds for current phase (for ring progress)
  targetTime: 0,          // Date.now() when phase ends
  pauseRemaining: 0,
  intervalId: null,
  lastSecond: -1,

  getTotalSeconds() {
    return this.config.prepare + this.config.rounds * (this.config.work + this.config.rest);
  },

  getElapsedSeconds() {
    const st = this.state === 'paused' ? this.pausedState : this.state;
    const left = this.state === 'paused' ? Math.ceil(this.pauseRemaining) : this.secondsLeft;
    if (st === 'idle') return 0;
    if (st === 'complete') return this.getTotalSeconds();
    let e = 0;
    if (st === 'prepare') {
      e = this.config.prepare - left;
    } else {
      e = this.config.prepare;
      e += (this.currentRound - 1) * (this.config.work + this.config.rest);
      if (st === 'work') {
        e += this.config.work - left;
      } else {
        e += this.config.work + (this.config.rest - left);
      }
    }
    return e;
  },

  start() {
    Audio.init();
    Audio.startKeepAlive();
    this.currentRound = 0;
    this.lastSecond = -1;

    if (this.config.prepare > 0) {
      this._beginPhase('prepare', this.config.prepare);
    } else {
      this.currentRound = 1;
      Audio.workStart();
      this._beginPhase('work', this.config.work);
    }
  },

  _beginPhase(phase, duration) {
    this.state = phase;
    this.phaseDuration = duration;
    this.secondsLeft = duration;
    this.targetTime = Date.now() + duration * 1000;
    this.lastSecond = duration;

    App.onPhaseChange(phase, this.currentRound);
    App.onTick(this.secondsLeft, this.phaseDuration);

    if (!this.intervalId) {
      this.intervalId = setInterval(() => this._tick(), 200);
    }
  },

  _tick() {
    const remaining = (this.targetTime - Date.now()) / 1000;
    this.secondsLeft = Math.max(0, Math.ceil(remaining));

    if (this.secondsLeft !== this.lastSecond) {
      this.lastSecond = this.secondsLeft;
      // Countdown beeps at 3, 2, 1
      if (this.secondsLeft <= 3 && this.secondsLeft > 0) {
        Audio.countdown();
      }
      App.onTick(this.secondsLeft, this.phaseDuration);
    }

    if (remaining <= 0) {
      this._nextPhase();
    }
  },

  _nextPhase() {
    if (this.state === 'prepare') {
      this.currentRound = 1;
      Audio.workStart();
      this._beginPhase('work', this.config.work);
    } else if (this.state === 'work') {
      Audio.restStart();
      this._beginPhase('rest', this.config.rest);
    } else if (this.state === 'rest') {
      if (this.currentRound >= this.config.rounds) {
        this._finish();
      } else {
        this.currentRound++;
        Audio.workStart();
        this._beginPhase('work', this.config.work);
      }
    }
  },

  pause() {
    if (this.state === 'idle' || this.state === 'complete' || this.state === 'paused') return;
    this.pausedState = this.state;
    this.pauseRemaining = Math.max(0, (this.targetTime - Date.now()) / 1000);
    this.state = 'paused';
    clearInterval(this.intervalId);
    this.intervalId = null;
    App.onPause();
  },

  resume() {
    if (this.state !== 'paused') return;
    this.state = this.pausedState;
    this.targetTime = Date.now() + this.pauseRemaining * 1000;
    this.lastSecond = -1;
    this.intervalId = setInterval(() => this._tick(), 200);
    App.onResume(this.pausedState);
  },

  stop() {
    clearInterval(this.intervalId);
    this.intervalId = null;
    this.state = 'idle';
    this.currentRound = 0;
    this.secondsLeft = 0;
    Audio.stopKeepAlive();
    App.onStop();
  },

  _finish() {
    clearInterval(this.intervalId);
    this.intervalId = null;
    this.state = 'complete';
    Audio.complete();
    // Keep audio session alive briefly for the completion sound
    setTimeout(() => Audio.stopKeepAlive(), 3000);
    App.onComplete();
  }
};


// ============================================================
// Presets (localStorage)
// ============================================================
const Presets = {
  KEY: 'tabata_presets',

  defaults: [
    { name: 'Classic Tabata', work: 20, rest: 10, rounds: 8, prepare: 10 },
    { name: 'HIIT 30/30', work: 30, rest: 30, rounds: 10, prepare: 10 },
    { name: 'Quick Burn', work: 40, rest: 20, rounds: 5, prepare: 10 }
  ],

  getAll() {
    try {
      const stored = localStorage.getItem(this.KEY);
      if (stored) return JSON.parse(stored);
    } catch (e) {}
    localStorage.setItem(this.KEY, JSON.stringify(this.defaults));
    return [...this.defaults];
  },

  save(preset) {
    const all = this.getAll().filter(p => p.name !== preset.name);
    all.push(preset);
    localStorage.setItem(this.KEY, JSON.stringify(all));
  },

  remove(name) {
    const all = this.getAll().filter(p => p.name !== name);
    localStorage.setItem(this.KEY, JSON.stringify(all));
  }
};


// ============================================================
// App Controller
// ============================================================
const App = {
  wakeLock: null,
  RING_CIRCUMFERENCE: 2 * Math.PI * 90, // ~565.49

  init() {
    this._setupSteppers();
    this._setupButtons();
    this.updateConfigDisplay();
    this.renderPresets();
    this._registerSW();
    this._generateIcon();
    this._setupVisibilityHandler();
  },

  // ----- Setup View -----

  _setupSteppers() {
    document.querySelectorAll('.step-btn').forEach(btn => {
      const handle = () => {
        this.adjustConfig(btn.dataset.target, parseInt(btn.dataset.delta));
      };

      let repeatId = null;
      let delayId = null;

      const startRepeat = () => {
        handle();
        delayId = setTimeout(() => {
          repeatId = setInterval(handle, 100);
        }, 400);
      };

      const stopRepeat = () => {
        clearTimeout(delayId);
        clearInterval(repeatId);
        delayId = null;
        repeatId = null;
      };

      // Touch (mobile)
      btn.addEventListener('touchstart', (e) => { e.preventDefault(); startRepeat(); });
      btn.addEventListener('touchend', stopRepeat);
      btn.addEventListener('touchcancel', stopRepeat);
      // Mouse (desktop)
      btn.addEventListener('mousedown', (e) => { if (e.button === 0) startRepeat(); });
      btn.addEventListener('mouseup', stopRepeat);
      btn.addEventListener('mouseleave', stopRepeat);
    });
  },

  _setupButtons() {
    document.getElementById('start-btn').addEventListener('click', () => {
      this.showTimer();
      Timer.start();
    });

    document.getElementById('pause-btn').addEventListener('click', () => {
      if (Timer.state === 'paused') {
        Timer.resume();
      } else {
        Timer.pause();
      }
    });

    document.getElementById('stop-btn').addEventListener('click', () => {
      if (Timer.state !== 'complete') {
        if (confirm('Stop the workout?')) Timer.stop();
      } else {
        Timer.stop();
      }
    });

    document.getElementById('save-preset-btn').addEventListener('click', () => {
      const name = prompt('Preset name:');
      if (name && name.trim()) {
        Presets.save({
          name: name.trim(),
          work: Timer.config.work,
          rest: Timer.config.rest,
          rounds: Timer.config.rounds,
          prepare: Timer.config.prepare
        });
        this.renderPresets();
      }
    });
  },

  adjustConfig(target, delta) {
    const limits = {
      work:    { min: 5, max: 300 },
      rest:    { min: 5, max: 300 },
      rounds:  { min: 1, max: 99 },
      prepare: { min: 0, max: 60 }
    };
    const lim = limits[target];
    Timer.config[target] = Math.max(lim.min, Math.min(lim.max, Timer.config[target] + delta));
    this.updateConfigDisplay();
  },

  updateConfigDisplay() {
    const c = Timer.config;
    document.getElementById('work-display').textContent = c.work + 's';
    document.getElementById('rest-display').textContent = c.rest + 's';
    document.getElementById('rounds-display').textContent = c.rounds;
    document.getElementById('prepare-display').textContent = c.prepare + 's';

    const total = c.prepare + c.rounds * (c.work + c.rest);
    const min = Math.floor(total / 60);
    const sec = total % 60;
    document.getElementById('total-time').textContent = min + ':' + String(sec).padStart(2, '0');
  },

  renderPresets() {
    const list = document.getElementById('presets-list');
    const presets = Presets.getAll();
    list.innerHTML = presets.map(p =>
      `<div class="preset-item">
        <div class="preset-info" data-name="${this._esc(p.name)}">
          <span class="preset-name">${this._esc(p.name)}</span>
          <span class="preset-detail">${p.work}s/${p.rest}s &times; ${p.rounds}</span>
        </div>
        <button class="preset-delete" data-name="${this._esc(p.name)}">&times;</button>
      </div>`
    ).join('');

    list.querySelectorAll('.preset-info').forEach(el => {
      el.addEventListener('click', () => {
        const preset = presets.find(p => p.name === el.dataset.name);
        if (preset) {
          Timer.config.work = preset.work;
          Timer.config.rest = preset.rest;
          Timer.config.rounds = preset.rounds;
          Timer.config.prepare = preset.prepare;
          this.updateConfigDisplay();
        }
      });
    });

    list.querySelectorAll('.preset-delete').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        Presets.remove(el.dataset.name);
        this.renderPresets();
      });
    });
  },

  _esc(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  },

  // ----- Timer View -----

  showTimer() {
    document.getElementById('setup-view').classList.remove('active');
    document.getElementById('timer-view').classList.add('active');
    document.getElementById('pause-btn').textContent = 'PAUSE';
    document.getElementById('pause-btn').style.display = '';
    document.getElementById('timer-view').classList.remove('paused');
    this._requestWakeLock();
  },

  showSetup() {
    document.getElementById('timer-view').classList.remove('active');
    document.getElementById('timer-view').className = 'view';
    document.getElementById('setup-view').classList.add('active');
    this._releaseWakeLock();
  },

  formatTime(sec) {
    if (sec >= 60) {
      return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
    }
    return String(sec);
  },

  onTick(secondsLeft, phaseDuration) {
    document.getElementById('timer-countdown').textContent = this.formatTime(secondsLeft);

    // Phase ring progress
    const progress = secondsLeft / phaseDuration;
    const offset = this.RING_CIRCUMFERENCE * (1 - progress);
    document.getElementById('timer-ring-progress').style.strokeDashoffset = offset;

    // Overall progress bar
    const total = Timer.getTotalSeconds();
    const elapsed = Timer.getElapsedSeconds();
    const pct = total > 0 ? Math.min(100, (elapsed / total) * 100) : 0;
    document.getElementById('progress-bar').style.width = pct + '%';
  },

  onPhaseChange(phase, round) {
    const timerView = document.getElementById('timer-view');
    timerView.className = 'view active phase-' + phase;

    document.getElementById('timer-phase').textContent = phase.toUpperCase();

    if (phase === 'prepare') {
      document.getElementById('timer-round').textContent = 'Get ready!';
    } else {
      document.getElementById('timer-round').textContent = 'Round ' + round + ' of ' + Timer.config.rounds;
    }

    this._renderRoundDots(round, Timer.config.rounds, phase);
  },

  _renderRoundDots(current, total, phase) {
    const container = document.getElementById('timer-rounds-dots');
    if (total > 20) {
      container.innerHTML = '';
      return;
    }
    let html = '';
    for (let i = 1; i <= total; i++) {
      let cls = 'round-dot';
      if (i < current) cls += ' done';
      else if (i === current && phase !== 'prepare') cls += ' active';
      html += '<span class="' + cls + '"></span>';
    }
    container.innerHTML = html;
  },

  onPause() {
    document.getElementById('pause-btn').textContent = 'RESUME';
    document.getElementById('timer-view').classList.add('paused');
  },

  onResume(phase) {
    document.getElementById('pause-btn').textContent = 'PAUSE';
    document.getElementById('timer-view').classList.remove('paused');
  },

  onStop() {
    this.showSetup();
  },

  onComplete() {
    document.getElementById('timer-phase').textContent = 'COMPLETE';
    document.getElementById('timer-countdown').textContent = this.formatTime(0);
    document.getElementById('timer-round').textContent = 'Great workout!';
    document.getElementById('timer-view').className = 'view active phase-complete';
    document.getElementById('progress-bar').style.width = '100%';
    document.getElementById('pause-btn').style.display = 'none';

    // Ring full
    document.getElementById('timer-ring-progress').style.strokeDashoffset = this.RING_CIRCUMFERENCE;

    // Mark all dots as done
    document.querySelectorAll('.round-dot').forEach(d => {
      d.className = 'round-dot done';
    });
  },

  // ----- Wake Lock -----

  async _requestWakeLock() {
    try {
      if ('wakeLock' in navigator) {
        this.wakeLock = await navigator.wakeLock.request('screen');
      }
    } catch (e) { /* not supported or denied */ }
  },

  _releaseWakeLock() {
    if (this.wakeLock) {
      this.wakeLock.release();
      this.wakeLock = null;
    }
  },

  _setupVisibilityHandler() {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' &&
          Timer.state !== 'idle' && Timer.state !== 'complete') {
        this._requestWakeLock();
      }
    });
  },

  // ----- Service Worker -----

  _registerSW() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('./sw.js').catch(() => {});
    }
  },

  // ----- Dynamic Icon -----

  _generateIcon() {
    const canvas = document.createElement('canvas');
    canvas.width = 180;
    canvas.height = 180;
    const ctx = canvas.getContext('2d');

    // Rounded rect background
    ctx.fillStyle = '#1a1a2e';
    ctx.beginPath();
    const r = 32;
    ctx.moveTo(r, 0);
    ctx.lineTo(180 - r, 0);
    ctx.quadraticCurveTo(180, 0, 180, r);
    ctx.lineTo(180, 180 - r);
    ctx.quadraticCurveTo(180, 180, 180 - r, 180);
    ctx.lineTo(r, 180);
    ctx.quadraticCurveTo(0, 180, 0, 180 - r);
    ctx.lineTo(0, r);
    ctx.quadraticCurveTo(0, 0, r, 0);
    ctx.fill();

    // Timer arc
    ctx.beginPath();
    ctx.arc(90, 82, 48, -Math.PI * 0.8, Math.PI * 0.8);
    ctx.strokeStyle = '#00e676';
    ctx.lineWidth = 7;
    ctx.lineCap = 'round';
    ctx.stroke();

    // "T" text
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 48px -apple-system, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('T', 90, 85);

    // Subtitle
    ctx.font = 'bold 14px -apple-system, system-ui, sans-serif';
    ctx.fillStyle = '#00e676';
    ctx.fillText('TABATA', 90, 148);

    const link = document.createElement('link');
    link.rel = 'apple-touch-icon';
    link.href = canvas.toDataURL('image/png');
    document.head.appendChild(link);
  }
};


// ============================================================
// Boot
// ============================================================
document.addEventListener('DOMContentLoaded', () => App.init());
