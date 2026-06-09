// ─── CONSTANTS ───────────────────────────
const NOTE_PCS   = {C:0,D:2,E:4,F:5,G:7,A:9,B:11};
const ACC_OFFSET = {b:-1,n:0,'#':1};
const NOTES_ALL  = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
const QUALITY_INTERVALS = {
  /* 기본 */
  maj:[0,4,7], m:[0,3,7], '5':[0,7],
  /* 7th */
  '7':[0,4,7,10], maj7:[0,4,7,11], m7:[0,3,7,10],
  m7b5:[0,3,6,10], dim7:[0,3,6,9], aug7:[0,4,8,10],
  '7sus4':[0,5,7,10], '7sus2':[0,2,7,10],
  /* 6th */
  '6':[0,4,7,9], m6:[0,3,7,9], '69':[0,4,7,9,14],
  /* 9th */
  '9':[0,4,7,10,14], maj9:[0,4,7,11,14], m9:[0,3,7,10,14],
  add9:[0,4,7,14], madd9:[0,3,7,14],
  /* 11th */
  '11':[0,4,7,10,14,17], maj11:[0,4,7,11,14,17], m11:[0,3,7,10,14,17],
  /* 13th */
  '13':[0,4,7,10,14,17,21], maj13:[0,4,7,11,14,17,21], m13:[0,3,7,10,14,17,21],
  /* sus / dim / aug */
  sus2:[0,2,7], sus4:[0,5,7], dim:[0,3,6], aug:[0,4,8],
};
const QUALITY_COLORS = {
  maj:'#4a90d9', m:'#5a9e6f', '5':'#7a8898',
  '7':'#e8a44a', maj7:'#5a9e9e', m7:'#9e5aae',
  m7b5:'#c04040', dim7:'#b03030', aug7:'#d94a9e',
  '7sus4':'#3aabbb', '7sus2':'#5ab8cc',
  '6':'#c8a440', m6:'#7ab87a', '69':'#c89a30',
  '9':'#e07a20', maj9:'#4ab8b8', m9:'#8840b8',
  add9:'#60b050', madd9:'#50a060',
  '11':'#c86820', maj11:'#3898a8', m11:'#7030a8',
  '13':'#d4a020', maj13:'#30a878', m13:'#6028a0',
  sus2:'#4ab8d9', sus4:'#7ab85a', dim:'#e85a4a', aug:'#d94a9e',
};
const TRACK_COLORS = ['#6c63ff','#e85a4a','#4ecdc4','#e8a44a','#9e5aae','#5a9e6f','#d94a9e','#4a90d9'];

// ─── STATE ───────────────────────────────
let S = {
  bpm:130, numBars:8, globalRepeat:1, barsPerRow:8,
  playStart:0, playEnd:null,  // null = 전체
  builderMode:'chord',
  // chord builder
  root:'C', acc:'n', quality:'maj', chordOct:3,
  // melody builder
  melRoot:'C', melAcc:'n', melOct:4,
  // tracks
  tracks:[], nextTrackId:0,
  activeTrackId:0,
  // repeat section
  repSec:{ start:null, end:null, times:2 },
  repSetStep:0,
  // playback
  isPlaying:false, loopPlay:false, activeBar:-1, expandedLen:0,
  animFr:null,
  // drag-copy
  dragSt:null,
  // selection (per track, keyed by trackId)
  selMap:{},
  // metronome
  metronome: false,
  // playback feel
  humanize: false,
  swing: 0,
  // keyboard note input cursor (per trackId)
  kbCursor: {},
  // chord inversion (0=root position)
  inv: 0,
  // clipboard for copy/paste
  clipboard: null,
};

// ─── UNDO HISTORY ────────────────────────
const history = [];
const redoStack = [];
const MAX_HISTORY = 40;

function getStateSnap() {
  return {
    tracks: S.tracks.map(t => {
      const base = {
        id:t.id, type:t.type, color:t.color, name:t.name,
        bars: t.type==='vocal' ? [] : JSON.parse(JSON.stringify(t.bars)),
        sound:t.sound, pattern:t.pattern, muted:t.muted,
        volume:t.volume??1.0, arpSpeed:t.arpSpeed??1, arpRange:t.arpRange??'standard',
      };
      if (t.type==='vocal') base.clips = (t.clips||[]).map(({_audioBuf,...c})=>c);
      return base;
    }),
    bpm:S.bpm, numBars:S.numBars, globalRepeat:S.globalRepeat,
    barsPerRow:S.barsPerRow,
    repSec:{...S.repSec},
    playStart:S.playStart, playEnd:S.playEnd,
    nextTrackId:S.nextTrackId, activeTrackId:S.activeTrackId,
  };
}
function pushHistory() {
  history.push(getStateSnap());
  if (history.length > MAX_HISTORY) history.shift();
  redoStack.length = 0;
}
function restoreSnap(snap) {
  S.tracks.forEach(t => { try{t.synth?.dispose();}catch(e){} try{t.gain?.dispose();}catch(e){} });
  Object.assign(S, {
    bpm:snap.bpm, numBars:snap.numBars, globalRepeat:snap.globalRepeat,
    barsPerRow:snap.barsPerRow,
    repSec:snap.repSec, playStart:snap.playStart, playEnd:snap.playEnd,
    nextTrackId:snap.nextTrackId, activeTrackId:snap.activeTrackId,
  });
  S.tracks = snap.tracks.map(d => {
    const t = {...d, synth:null, gain:null, drumSynths:null};
    if (t.type === 'drum') initDrumTrack(t);
    else if (t.type === 'vocal') {
      t.clips = (d.clips||[]).map(c => ({...c, _audioBuf:null}));
      initVocalTrack(t);
    }
    else initTrackSynth(t);
    return t;
  });
  syncTopbarUI(); renderAll();
  // undo/redo 후 보컬 파형 복구 (비동기 디코드 → 재렌더)
  const vts = S.tracks.filter(t => t.type === 'vocal' && (t.clips||[]).some(c => c.audioBase64 && !c._audioBuf));
  if (vts.length) Promise.all(vts.map(t => decodeVocalClips(t))).then(() => renderAll());
}
function syncTopbarUI() {
  $('bpmInput').value      = S.bpm;
  $('barsVal').value       = S.numBars;
  $('repVal').textContent  = S.globalRepeat;
  $('bprSel').value        = S.barsPerRow;
  syncRangeInputs(); updateRepUI();
}
function undo() {
  if (!history.length) return;
  if (S.isPlaying) stopPlay();
  redoStack.push(getStateSnap());
  restoreSnap(history.pop());
}
function redo() {
  if (!redoStack.length) return;
  if (S.isPlaying) stopPlay();
  history.push(getStateSnap());
  restoreSnap(redoStack.pop());
}

// ─── HELPERS ─────────────────────────────
const $ = id => document.getElementById(id);
function humanVel(v) {
  return S.humanize ? Math.min(1.2, Math.max(0.08, v + (Math.random()-0.5)*0.14)) : v;
}
function barVel(item, base) {
  const mult = (item?.vel !== undefined) ? VEL_LEVELS[item.vel].v : 1.0;
  return humanVel(mult * base);
}
function swOff(i, step) {
  return (S.swing > 0 && i % 2 === 1) ? step * S.swing : 0;
}
// 초→틱 변환 (Tone.Transport.swing이 틱 단위 스케줄링에 적용됨)
function secToTick(sec) {
  return Math.max(0, Math.round(sec * Tone.Transport.bpm.value / 60 * Tone.Transport.PPQ));
}
// 저음역 보상: 인간 귀는 낮은 음에 덜 민감 (Fletcher-Munson)
function bassLoudComp(toneNote) {
  const m = toneNote?.match(/(\d+)$/);
  if (!m) return 1;
  const oct = parseInt(m[1]);
  if (oct <= 1) return 1.55;
  if (oct === 2) return 1.30;
  if (oct === 3) return 1.10;
  return 1.0;
}

function getRootPc(root, acc) { return ((NOTE_PCS[root]+ACC_OFFSET[acc])+12)%12; }
function noteLabel(root, acc) {
  return root + (acc==='b'?'♭':acc==='#'?'♯':'');
}
const QUALITY_DISPLAY = {
  maj:'', m7b5:'m7♭5', '69':'6/9', add9:'(add9)', madd9:'m(add9)',
};
function chordLabel(root, acc, quality) {
  const disp = quality in QUALITY_DISPLAY ? QUALITY_DISPLAY[quality] : quality;
  return noteLabel(root,acc) + disp;
}
function chordColor(quality) { return QUALITY_COLORS[quality]||'#4a90d9'; }

function chordNotes(root, acc, quality, oct=3) {
  const pc = getRootPc(root, acc);
  const base = oct*12+12+pc;
  return (QUALITY_INTERVALS[quality]||[0,4,7]).map(iv=>{
    const m=base+iv; return NOTES_ALL[m%12]+(Math.floor(m/12)-1);
  });
}

function melodyNoteStr(root, acc, oct) {
  return noteLabel(root,acc)+oct;
}
function melodyToneNote(root, acc, oct) {
  const pc = getRootPc(root,acc);
  return NOTES_ALL[pc]+oct;
}

function invertNotes(notes, inv) {
  if (!inv) return notes;
  const out = [...notes];
  for (let i = 0; i < Math.min(inv, notes.length - 1); i++) {
    const first = out.shift();
    out.push(first.replace(/(\d+)$/, m => String(parseInt(m)+1)));
  }
  return out;
}

function makeArpNoteList(notes, range) {
  const topRoot = notes[0].replace(/\d+/, m => String(parseInt(m)+1));
  if (range === 'full') {
    return notes.length >= 4 ? [...notes] : [...notes, topRoot];
  }
  if (range === 'wide') {
    const up = notes.map(n => n.replace(/\d+/, m => String(parseInt(m)+1)));
    return [...notes, ...up];
  }
  return [...notes.slice(0,3), topRoot];
}

function buildChord() {
  const oct = parseInt(S.chordOct) || 3;
  const baseNotes = chordNotes(S.root, S.acc, S.quality, oct);
  const inv = S.inv || 0;
  return {
    type:'chord',
    root:S.root, acc:S.acc, quality:S.quality, oct, inv,
    label:chordLabel(S.root,S.acc,S.quality),
    color:chordColor(S.quality),
    notes: invertNotes(baseNotes, inv),
  };
}
function buildMelNote() {
  return {
    type:'melody',
    root:S.melRoot, acc:S.melAcc, oct:S.melOct,
    label:melodyNoteStr(S.melRoot,S.melAcc,S.melOct),
    toneNote:melodyToneNote(S.melRoot,S.melAcc,S.melOct),
    color:'#ffe66d',
  };
}

// ─── PIANO SAMPLES (Salamander Grand Piano) ───
const PIANO_URLS = {
  'A0':'A0.mp3','C1':'C1.mp3','D#1':'Ds1.mp3','F#1':'Fs1.mp3',
  'A1':'A1.mp3','C2':'C2.mp3','D#2':'Ds2.mp3','F#2':'Fs2.mp3',
  'A2':'A2.mp3','C3':'C3.mp3','D#3':'Ds3.mp3','F#3':'Fs3.mp3',
  'A3':'A3.mp3','C4':'C4.mp3','D#4':'Ds4.mp3','F#4':'Fs4.mp3',
  'A4':'A4.mp3','C5':'C5.mp3','D#5':'Ds5.mp3','F#5':'Fs5.mp3',
  'A5':'A5.mp3','C6':'C6.mp3','D#6':'Ds6.mp3','F#6':'Fs6.mp3',
  'A7':'A7.mp3','C8':'C8.mp3',
};
const PIANO_BASE  = 'https://tonejs.github.io/audio/salamander/';

const GLEITZ_URLS = {
  'A1':'A1.mp3','C2':'C2.mp3','Eb2':'Ds2.mp3','Gb2':'Fs2.mp3',
  'A2':'A2.mp3','C3':'C3.mp3','Eb3':'Ds3.mp3','Gb3':'Fs3.mp3',
  'A3':'A3.mp3','C4':'C4.mp3','Eb4':'Ds4.mp3','Gb4':'Fs4.mp3',
  'A4':'A4.mp3','C5':'C5.mp3','Eb5':'Ds5.mp3','Gb5':'Fs5.mp3',
  'A5':'A5.mp3','C6':'C6.mp3','Eb6':'Ds6.mp3','Gb6':'Fs6.mp3',
  'A6':'A6.mp3','C7':'C7.mp3',
};
const GLEITZ_BASE = 'https://cdn.jsdelivr.net/gh/gleitz/midi-js-soundfonts@gh-pages/MusyngKite/';

const SAMPLER_SOUNDS = new Set(['piano','rhodes','ngitar','sgitar','vib','choir','sambass']);
const VEL_LEVELS = [
  {label:'pp',v:0.30},{label:'p',v:0.50},{label:'mp',v:0.70},
  {label:'mf',v:1.00},{label:'f',v:1.20},{label:'ff',v:1.40},
];

// ─── REVERB POOL (전역 공유, 사운드별로 하나씩) ───
let _reverbs = {};
function getSharedReverb(key, decay, wet) {
  if (!_reverbs[key]) {
    const rv = new Tone.Reverb({ decay, wet });
    rv.toDestination();
    _reverbs[key] = rv;
  }
  return _reverbs[key];
}
// 앱 로드 시 미리 생성 (IR 빌드 시간 확보)
window.addEventListener('load', () => {
  getSharedReverb('piano',   0.9, 0.10);
  getSharedReverb('mellow',  1.8, 0.15);
  getSharedReverb('bell',    3.5, 0.50);
  getSharedReverb('strings', 2.5, 0.38);
  // 피아노 샘플 미리 로드 (브라우저 캐시 준비)
  new Tone.Sampler({ urls: PIANO_URLS, baseUrl: PIANO_BASE });
});

// ─── SYNTH FACTORY ───────────────────────
function makeSynth(sound, onload) {
  if (sound === 'bell') {
    // FM 합성 → 배음 구조 있는 진짜 벨 소리
    const rv   = getSharedReverb('bell', 3.5, 0.50);
    const gain = new Tone.Gain(0.42);
    gain.connect(rv);
    const poly = new Tone.PolySynth(Tone.FMSynth, {
      harmonicity: 5.1,
      modulationIndex: 3.2,
      oscillator:          { type:'sine' },
      envelope:            { attack:.001, decay:1.8, sustain:.05, release:5.0 },
      modulation:          { type:'sine' },
      modulationEnvelope:  { attack:.001, decay:.9,  sustain:.0,  release:4.0 },
    });
    poly.maxPolyphony = 16;
    poly.connect(gain);
    return { poly, gain };
  }

  if (sound === 'bass') {
    const gain = new Tone.Gain(0.85);
    gain.toDestination();
    const poly = new Tone.PolySynth(Tone.Synth, {
      volume: -4,
      oscillator: { type: 'fatsine2', spread: 6 },
      envelope: { attack: 0.002, decay: 0.08, sustain: 0.78, release: 0.14 },
    });
    poly.maxPolyphony = 2;  // monophonic bass: 1 active + 1 tail
    poly.connect(gain);
    return { poly, gain };
  }

  if (sound === 'ebass') {
    const lim = new Tone.Limiter(-2);
    lim.toDestination();
    const filter = new Tone.Filter(700, 'lowpass', -24);
    filter.connect(lim);
    const gain = new Tone.Gain(1.2);
    gain.connect(filter);
    const poly = new Tone.PolySynth(Tone.Synth, {
      volume: -1,
      oscillator: { type: 'sawtooth' },
      envelope: { attack: 0.004, decay: 0.18, sustain: 0.72, release: 0.08 },
    });
    poly.maxPolyphony = 2;  // monophonic
    poly.connect(gain);
    return { poly, gain };
  }

  if (sound === 'guitar') {
    // Karplus-Strong 현악기 알고리즘 — 실제 현 퉁기는 소리
    const rv   = getSharedReverb('piano', 1.8, 0.14);
    const gain = new Tone.Gain(0.95);
    gain.connect(rv);
    // PluckSynth는 모노포닉이라 6개 생성해 폴리포니 구현
    const voices = Array.from({ length: 6 }, () => {
      const v = new Tone.PluckSynth({ attackNoise:1.5, dampening:4200, resonance:0.97 });
      v.connect(gain);
      return v;
    });
    let vi = 0;
    const poly = {
      triggerAttackRelease(notes, dur, time, vel) {
        const arr = Array.isArray(notes) ? notes : [notes];
        const db = vel != null ? Math.max(-40, 20 * Math.log10(Math.max(0.001, vel))) : 0;
        arr.forEach(note => {
          const v = voices[vi++ % 6];
          v.volume.value = db;
          v.triggerAttackRelease(note, dur, time);
        });
      },
      releaseAll() {},
      dispose() { voices.forEach(v => { try{v.dispose();}catch(e){} }); },
    };
    return { poly, gain };
  }

  if (['rhodes','ngitar','sgitar','vib','choir','sambass'].includes(sound)) {
    const CFG = {
      rhodes:  { inst:'electric_piano_1',      rv:'piano',   rt:1.0, rw:0.12, gv:0.78, rel:1.0, atk:0.01 },
      ngitar:  { inst:'acoustic_guitar_nylon',  rv:'piano',   rt:1.5, rw:0.16, gv:0.85, rel:0.9, atk:0.01 },
      sgitar:  { inst:'acoustic_guitar_steel',  rv:'piano',   rt:1.2, rw:0.13, gv:0.82, rel:0.8, atk:0.01 },
      vib:     { inst:'vibraphone',             rv:'bell',    rt:2.5, rw:0.30, gv:0.70, rel:1.5, atk:0.01 },
      choir:   { inst:'choir_aahs',             rv:'strings', rt:2.0, rw:0.35, gv:0.60, rel:1.5, atk:0.12 },
      sambass: { inst:'acoustic_bass',          rv:'piano',   rt:0.6, rw:0.08, gv:0.90, rel:0.5, atk:0.01 },
    };
    const c   = CFG[sound];
    const rv  = getSharedReverb(c.rv, c.rt, c.rw);
    const gain = new Tone.Gain(c.gv);
    gain.connect(rv);
    const poly = new Tone.Sampler({
      urls: GLEITZ_URLS,
      baseUrl: GLEITZ_BASE + c.inst + '-mp3/',
      attack: c.atk,
      release: c.rel,
      onload: onload || (() => {}),
    });
    poly.connect(gain);
    return { poly, gain };
  }

  if (sound === 'elec') {
    // 기존 전자음 (삼각파 플럭)
    const rv   = getSharedReverb('piano', 0.9, 0.10);
    const gain = new Tone.Gain(0.88);
    gain.connect(rv);
    const poly = new Tone.PolySynth(Tone.Synth, {
      volume: -2,
      oscillator: { type: 'triangle' },
      envelope: { attack: 0.001, decay: 0.55, sustain: 0.05, release: 1.2 },
    });
    poly.maxPolyphony = 8;
    poly.connect(gain);
    return { poly, gain };
  }

  if (sound === 'strings') {
    // fatsawtooth + lowpass filter + limiter — 파열음 방지
    const rv  = getSharedReverb('strings', 2.5, 0.38);
    const lim = new Tone.Limiter(-4);
    lim.connect(rv);
    const flt = new Tone.Filter(2600, 'lowpass');
    flt.connect(lim);
    const gain = new Tone.Gain(0.42);
    gain.connect(flt);
    const poly = new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: 'fatsawtooth', count: 2, spread: 12 },
      volume: -4,
      envelope: { attack: 0.28, decay: 0.08, sustain: 0.88, release: 1.4 },
    });
    poly.maxPolyphony = 6;
    poly.connect(gain);
    return { poly, gain };
  }

  if (sound === 'flute') {
    // 순수 사인파 — 단순하고 깨끗
    const rv   = getSharedReverb('mellow', 1.8, 0.15);
    const gain = new Tone.Gain(0.62);
    gain.connect(rv);
    const poly = new Tone.PolySynth(Tone.Synth, {
      volume: -6,
      oscillator: { type: 'sine' },
      envelope: { attack: 0.09, decay: 0.05, sustain: 0.92, release: 0.55 },
    });
    poly.maxPolyphony = 4;
    poly.connect(gain);
    return { poly, gain };
  }

  if (sound === 'organ') {
    // 배음 5개 custom partials — 파이프 오르간 느낌, limiter로 파열 방지
    const rv   = getSharedReverb('mellow', 1.8, 0.18);
    const lim  = new Tone.Limiter(-4);
    lim.connect(rv);
    const gain = new Tone.Gain(0.38);
    gain.connect(lim);
    const poly = new Tone.PolySynth(Tone.Synth, {
      volume: -10,
      oscillator: { type: 'custom', partials: [1, 0.5, 0.33, 0.17, 0.1] },
      envelope: { attack: 0.012, decay: 0, sustain: 1.0, release: 0.10 },
    });
    poly.maxPolyphony = 6;
    poly.connect(gain);
    return { poly, gain };
  }

  if (sound === 'clean') {
    // soundgo 스타일: 삼각파 + 로우패스 1800Hz, 리버브 없음
    const flt  = new Tone.Filter(1800, 'lowpass');
    flt.toDestination();
    const gain = new Tone.Gain(0.55);
    gain.connect(flt);
    const poly = new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: 'triangle' },
      envelope:   { attack: 0.04, decay: 0.01, sustain: 1.0, release: 0.12 },
    });
    poly.maxPolyphony = 12;
    poly.connect(gain);
    return { poly, gain };
  }

  if (sound === 'mellow') {
    const rv   = getSharedReverb('mellow', 1.8, 0.15);
    const lim  = new Tone.Limiter(-2);
    lim.connect(rv);
    const gain = new Tone.Gain(0.75);
    gain.connect(lim);
    const poly = new Tone.PolySynth(Tone.Synth, {
      volume: -6,
      oscillator: { type:'fatsine2', spread:20 },
      envelope:   { attack:.05, decay:.10, sustain:.78, release:1.2 },
    });
    poly.maxPolyphony = 12;
    poly.connect(gain);
    return { poly, gain };
  }

  // piano (기본) — Salamander Grand Piano 샘플러
  const rv   = getSharedReverb('piano', 0.9, 0.10);
  const gain = new Tone.Gain(0.72);
  gain.connect(rv);
  const poly = new Tone.Sampler({
    urls: PIANO_URLS,
    baseUrl: PIANO_BASE,
    release: 1.2,
    onload: onload || (() => {}),
  });
  poly.connect(gain);
  return { poly, gain };
}

// ─── TRACKS ──────────────────────────────
function createTrack(type='chord') {
  const id = S.nextTrackId++;
  const color = type === 'drum' ? '#e17055' : type === 'vocal' ? '#e84393' : TRACK_COLORS[id % TRACK_COLORS.length];
  const track = {
    id, type, color,
    name: type==='melody'?`멜로디 ${id+1}`:type==='drum'?`드럼 ${id+1}`:type==='vocal'?`보컬 ${id+1}`:`코드 ${id+1}`,
    bars: new Array(S.numBars).fill(null),
    sound: 'piano', pattern: 'chord',
    muted: false, volume: 1.0, arpSpeed: 1, arpRange: 'standard',
    samplerLoaded: true,
    synth: null, gain: null, drumSynths: null,
  };
  if (type === 'vocal') { track.clips = []; initVocalTrack(track); }
  else if (type === 'drum') initDrumTrack(track);
  else initTrackSynth(track);
  S.tracks.push(track);
  return track;
}

function initTrackSynth(track) {
  if (track.synth) { try{track.synth.dispose();}catch(e){} }
  if (track.gain)  { try{track.gain.dispose();}catch(e){} }
  track.samplerLoaded = !SAMPLER_SOUNDS.has(track.sound);
  const {poly,gain} = makeSynth(track.sound, () => {
    track.samplerLoaded = true;
    document.querySelectorAll(`.loading-ind[data-loading="${track.id}"]`).forEach(el => el.classList.add('hidden'));
  });
  gain.gain.value = track.muted ? 0 : (track.volume ?? 1.0) * 0.6;
  track.synth = poly; track.gain = gain;
}

function initDrumTrack(track) {
  if (track.drumSynths) {
    try { Object.values(track.drumSynths).forEach(s => s?.dispose()); } catch(e) {}
  }
  if (track.gain) { try { track.gain.dispose(); } catch(e) {} }
  const dst = new Tone.Gain((track.volume ?? 1.0) * 0.85);
  dst.toDestination();
  track.gain = dst;

  const kick = new Tone.MembraneSynth({
    pitchDecay: 0.05, octaves: 10,
    envelope: { attack: 0.001, decay: 0.32, sustain: 0, release: 0.1 },
  }).connect(dst);

  const snare = new Tone.NoiseSynth({
    noise: { type: 'white' },
    envelope: { attack: 0.001, decay: 0.15, sustain: 0, release: 0.04 },
  }).connect(new Tone.Gain(0.72).connect(dst));

  const hhFilter = new Tone.Filter(8500, 'highpass').connect(new Tone.Gain(0.55).connect(dst));
  const hihat = new Tone.NoiseSynth({
    noise: { type: 'white' },
    envelope: { attack: 0.001, decay: 0.04, sustain: 0, release: 0.01 },
  }).connect(hhFilter);

  const ohFilter = new Tone.Filter(7000, 'highpass').connect(new Tone.Gain(0.48).connect(dst));
  const openhat = new Tone.NoiseSynth({
    noise: { type: 'white' },
    envelope: { attack: 0.001, decay: 0.28, sustain: 0.06, release: 0.18 },
  }).connect(ohFilter);

  track.drumSynths = { k: kick, s: snare, h: hihat, o: openhat };
}

// ── VOCAL TRACK ──────────────────────────────────────────────
const VOCAL_MIME = (() => {
  const types = ['audio/webm;codecs=opus','audio/webm','audio/ogg;codecs=opus','audio/mp4'];
  return types.find(t => { try { return MediaRecorder.isTypeSupported(t); } catch { return false; } }) || '';
})();

let _micStream    = null;  // reused stream — one-time permission
let _vocalRec     = null;  // { trackId, recorder, recStartSec }
let _vocalSources = [];    // active AudioBufferSourceNodes — stopped on stopPlay

async function ensureMicStream() {
  if (_micStream?.active) return _micStream;
  try {
    _micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    return _micStream;
  } catch(e) {
    alert('마이크 권한이 필요해요.\n' + e.message);
    return null;
  }
}

function initVocalTrack(track) {
  if (track.gain) { try { track.gain.dispose(); } catch(e) {} }
  const gain = new Tone.Gain(track.volume ?? 1.0);
  gain.toDestination();
  track.gain = gain;
  if (!track.clips) track.clips = [];
}

async function decodeVocalClips(track) {
  const ctx = Tone.context.rawContext;
  for (const clip of (track.clips || [])) {
    if (clip._audioBuf || !clip.audioBase64) continue;
    try {
      const bin = atob(clip.audioBase64);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      clip._audioBuf = await ctx.decodeAudioData(arr.buffer.slice(0));
      if (!clip.duration) clip.duration = clip._audioBuf.duration;
    } catch(e) { console.warn('vocal decode error', clip.id, e); }
  }
}

async function startVocalRecording(trackId) {
  if (_vocalRec) { stopVocalRecording(); await new Promise(r => setTimeout(r, 60)); }
  const stream = await ensureMicStream();
  if (!stream) return;
  const opts = VOCAL_MIME ? { mimeType: VOCAL_MIME } : {};
  const recorder = new MediaRecorder(stream, opts);
  const chunks = [];
  const recStartSec = S.isPlaying ? Math.max(0, Tone.Transport.seconds - 0.1) : 0;

  recorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
  recorder.onstop = async () => {
    if (_vocalRec?.recorder === recorder) _vocalRec = null;
    if (!chunks.length) { renderAll(); return; }
    const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
    const arrayBuf = await blob.arrayBuffer();
    const bytes = new Uint8Array(arrayBuf);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    const b64 = btoa(bin);
    const ctx = Tone.context.rawContext;
    let audioBuf = null;
    try { audioBuf = await ctx.decodeAudioData(arrayBuf.slice(0)); } catch(e) {}
    pushHistory();
    const track = S.tracks.find(t => t.id === trackId);
    if (track) {
      track.clips.push({
        id: Date.now(), offset: recStartSec,
        duration: audioBuf?.duration ?? 0, gain: 1.0,
        audioBase64: b64, _audioBuf: audioBuf,
      });
    }
    renderAll();
  };

  _vocalRec = { trackId, recorder, recStartSec };
  recorder.start();
  renderAll();
}

async function stopVocalRecording() {
  if (!_vocalRec) return;
  const { recorder } = _vocalRec;
  if (recorder.state !== 'inactive') recorder.stop();
}

function _vocalBarDur() { return 60 / S.bpm * 4; }
const VOCAL_PX_PER_BAR = 68;

function drawVocalWave(canvas, audioBuf) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height, mid = h / 2;
  ctx.clearRect(0, 0, w, h);
  if (!audioBuf) {
    ctx.fillStyle = 'rgba(232,67,147,0.18)'; ctx.fillRect(0, mid-2, w, 4); return;
  }
  const data = audioBuf.getChannelData(0);
  const step = Math.max(1, Math.floor(data.length / w));
  ctx.strokeStyle = '#f07ab8'; ctx.lineWidth = 1; ctx.beginPath();
  for (let x = 0; x < w; x++) {
    let max = 0;
    for (let j = 0; j < step; j++) { const v = Math.abs(data[x*step+j]||0); if(v>max)max=v; }
    const ht = Math.max(2, Math.round(max * mid * 1.7));
    ctx.moveTo(x+.5, mid-ht/2); ctx.lineTo(x+.5, mid+ht/2);
  }
  ctx.stroke();
}

function vocalClipPlayDur(clip) {
  return Math.max(0.05, (clip.duration||1) - (clip.trimStart||0) - (clip.trimEnd||0));
}

function makeVocalClipEl(track, clip, barDurSec, containerRef) {
  const PX = VOCAL_PX_PER_BAR;
  const el = document.createElement('div');
  el.className = 'vocal-clip';
  const leftPx  = clip.offset / barDurSec * PX;
  const widthPx = Math.max(24, vocalClipPlayDur(clip) / barDurSec * PX);
  el.style.cssText = `left:${leftPx}px;width:${widthPx}px`;

  const canvas = document.createElement('canvas');
  canvas.className = 'vocal-wave';
  canvas.width = Math.round(widthPx); canvas.height = 38;
  el.appendChild(canvas);
  requestAnimationFrame(() => drawVocalWave(canvas, clip._audioBuf));

  const badge = document.createElement('div');
  badge.className = 'vocal-gain-badge';
  badge.textContent = Math.round((clip.gain??1)*100)+'%';
  el.appendChild(badge);

  el.addEventListener('contextmenu', e => {
    e.preventDefault(); pushHistory();
    track.clips = track.clips.filter(c => c.id !== clip.id);
    renderAll();
  });
  el.addEventListener('wheel', e => {
    e.preventDefault();
    clip.gain = Math.max(0.1, Math.min(2.0, (clip.gain??1) - e.deltaY*0.004));
    badge.textContent = Math.round(clip.gain*100)+'%';
  }, { passive:false });

  // ── 클립 이동 드래그 (중앙 영역)
  el.addEventListener('pointerdown', e => {
    if (e.button !== 0 || e.target.classList.contains('vocal-trim-handle')) return;
    e.preventDefault(); e.stopPropagation();
    el.setPointerCapture(e.pointerId);
    el.style.touchAction = 'none';
    const startX = e.clientX, origOff = clip.offset;
    const totalSec = S.numBars * _vocalBarDur();
    const onMove = mv => {
      const cw = containerRef.getBoundingClientRect().width || (S.numBars * PX);
      clip.offset = Math.max(0, origOff + (mv.clientX - startX) / cw * totalSec);
      el.style.left = (clip.offset / _vocalBarDur() * PX) + 'px';
    };
    const onUp = () => { document.removeEventListener('pointermove', onMove); document.removeEventListener('pointerup', onUp); };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  });

  // ── 왼쪽 트림 핸들
  const lh = document.createElement('div');
  lh.className = 'vocal-trim-handle vocal-trim-left';
  lh.addEventListener('pointerdown', e => {
    e.preventDefault(); e.stopPropagation();
    lh.setPointerCapture(e.pointerId);
    lh.style.touchAction = 'none';
    const startX = e.clientX, origOff = clip.offset, origTs = clip.trimStart||0;
    const totalSec = S.numBars * _vocalBarDur();
    const onMove = mv => {
      const cw = containerRef.getBoundingClientRect().width || (S.numBars * PX);
      const ds = (mv.clientX - startX) / cw * totalSec;
      const newTs = Math.max(0, Math.min((clip.duration||1)-(clip.trimEnd||0)-0.1, origTs+ds));
      const diff = newTs - origTs;
      clip.trimStart = newTs;
      clip.offset = Math.max(0, origOff + diff);
      const w = Math.max(24, vocalClipPlayDur(clip) / _vocalBarDur() * PX);
      el.style.left  = (clip.offset / _vocalBarDur() * PX) + 'px';
      el.style.width = w + 'px';
      canvas.width = Math.round(w);
      requestAnimationFrame(() => drawVocalWave(canvas, clip._audioBuf));
    };
    const onUp = () => { document.removeEventListener('pointermove', onMove); document.removeEventListener('pointerup', onUp); };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  });
  el.appendChild(lh);

  // ── 오른쪽 트림 핸들
  const rh = document.createElement('div');
  rh.className = 'vocal-trim-handle vocal-trim-right';
  rh.addEventListener('pointerdown', e => {
    e.preventDefault(); e.stopPropagation();
    rh.setPointerCapture(e.pointerId);
    rh.style.touchAction = 'none';
    const startX = e.clientX, origTe = clip.trimEnd||0;
    const totalSec = S.numBars * _vocalBarDur();
    const onMove = mv => {
      const cw = containerRef.getBoundingClientRect().width || (S.numBars * PX);
      const ds = (mv.clientX - startX) / cw * totalSec;
      clip.trimEnd = Math.max(0, Math.min((clip.duration||1)-(clip.trimStart||0)-0.1, origTe-ds));
      const w = Math.max(24, vocalClipPlayDur(clip) / _vocalBarDur() * PX);
      el.style.width = w + 'px';
      canvas.width = Math.round(w);
      requestAnimationFrame(() => drawVocalWave(canvas, clip._audioBuf));
    };
    const onUp = () => { document.removeEventListener('pointermove', onMove); document.removeEventListener('pointerup', onUp); };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  });
  el.appendChild(rh);

  return el;
}

function makeVocalTimeline(track) {
  const barDurSec = _vocalBarDur();
  const PX = VOCAL_PX_PER_BAR;
  const totalPx = S.numBars * PX;

  const inner = document.createElement('div');
  inner.className = 'vocal-timeline-inner';
  inner.style.width = totalPx + 'px';

  for (let bi = 0; bi < S.numBars; bi++) {
    const mk = document.createElement('div');
    mk.className = 'vocal-bar-tick' + (bi % 4 === 0 ? ' vbt4' : '');
    mk.style.left = (bi * PX) + 'px';
    if (bi % 2 === 0 || PX >= 48) {
      const lbl = document.createElement('span');
      lbl.className = 'vbt-lbl'; lbl.textContent = bi+1;
      mk.appendChild(lbl);
    }
    inner.appendChild(mk);
  }

  track.clips.forEach(clip => inner.appendChild(makeVocalClipEl(track, clip, barDurSec, inner)));

  const cursor = document.createElement('div');
  cursor.className = 'vocal-cursor';
  cursor.style.display = 'none';
  inner.appendChild(cursor);
  track._timelineCursor = cursor;
  track._timelineBarDur = barDurSec;

  if (_vocalRec?.trackId === track.id) {
    const ri = document.createElement('div');
    ri.className = 'vocal-rec-indicator';
    ri.style.left = (_vocalRec.recStartSec / barDurSec * PX) + 'px';
    inner.appendChild(ri);
  }

  inner.addEventListener('click', e => {
    if (e.target !== inner && !e.target.classList.contains('vocal-bar-tick') && !e.target.classList.contains('vbt-lbl')) return;
    if (_vocalRec?.trackId === track.id) { stopVocalRecording(); return; }
    startVocalRecording(track.id);
  });
  return inner;
}

function scheduleVocalTrack(track, barDur, offset) {
  if (!track.gain) initVocalTrack(track);
  if (!track.clips?.length) return;
  const rawCtx = Tone.context.rawContext;
  const ps = S.playStart, pe = S.playEnd ?? S.numBars - 1;
  const playStartSec = ps * barDur, playEndSec = (pe+1) * barDur;
  const rangeLen = pe - ps + 1;
  for (let rep = 0; rep < S.globalRepeat; rep++) {
    const repOff = offset + rep * rangeLen * barDur;
    for (const clip of track.clips) {
      if (!clip._audioBuf) continue;
      const clipEnd = clip.offset + (clip.duration||0);
      if (clipEnd <= playStartSec || clip.offset >= playEndSec) continue;
      const inPlay = clip.offset - playStartSec;
      const t = repOff + Math.max(0, inPlay);
      const srcSkip = inPlay < 0 ? -inPlay : 0;
      const vol = track.muted ? 0 : (clip.gain??1) * (track.volume??1);
      const trimStart  = clip.trimStart || 0;
      const trimEnd    = clip.trimEnd   || 0;
      const playableDur = Math.max(0.01, (clip.duration||0) - trimStart - trimEnd);
      const bufOffset   = Math.max(trimStart, srcSkip + trimStart);
      const bufDur      = Math.max(0.01, playableDur - (bufOffset - trimStart));
      if (bufDur <= 0) continue;
      Tone.Transport.schedule(startTime => {
        if (!S.isPlaying) return;
        const src = rawCtx.createBufferSource();
        src.buffer = clip._audioBuf;
        const g = rawCtx.createGain(); g.gain.value = vol;
        src.connect(g); g.connect(rawCtx.destination);
        src.start(startTime, bufOffset, bufDur);
        _vocalSources.push(src);
        src.onended = () => { _vocalSources = _vocalSources.filter(s => s !== src); };
      }, Math.max(0, t));
    }
  }
}

function deleteTrack(id) {
  pushHistory();
  const t = S.tracks.find(t=>t.id===id);
  if (t) {
    try{t.synth?.dispose();}catch(e){}
    try{t.gain?.dispose();}catch(e){}
    if (t.drumSynths) { try { Object.values(t.drumSynths).forEach(s=>s?.dispose()); } catch(e) {} }
    if (t.type === 'vocal' && _vocalRec?.trackId === id) stopVocalRecording();
  }
  S.tracks = S.tracks.filter(t=>t.id!==id);
  if (S.activeTrackId===id) S.activeTrackId = S.tracks[0]?.id ?? 0;
  renderAll();
}

function setActiveTrack(id) {
  S.activeTrackId = id;
  const t = S.tracks.find(t=>t.id===id);
  if (t) {
    // sync builder mode to track type
    switchBuilderMode(t.type==='melody'?'melody':'chord');
  }
  renderAll();
}

// ─── BAR DIVISION ────────────────────────
function divideBar(track, barIdx, count) {
  pushHistory();
  const existing = track.bars[barIdx];
  if (count === 1) {
    // 분할 해제: 첫 슬롯 내용 또는 null
    track.bars[barIdx] = existing?._divided ? (existing.slots[0] || null) : existing;
  } else if (existing?._divided) {
    // 재분할: 기존 슬롯 유지하며 크기 조정
    const slots = Array(count).fill(null);
    existing.slots.slice(0, count).forEach((s, i) => { slots[i] = s; });
    track.bars[barIdx] = { _divided: true, count, slots };
  } else {
    const base = existing ? { ...existing, tie: false, span: 1 } : null;
    const slots = Array(count).fill(null).map(() => base ? { ...base } : null);
    track.bars[barIdx] = { _divided: true, count, slots };
  }
  renderAll();
}

function showDivMenu(track, barIdx, anchor) {
  document.querySelectorAll('.div-menu').forEach(m => m.remove());
  const menu = document.createElement('div');
  menu.className = 'div-menu';
  [2, 3, 4].forEach(n => {
    const btn = document.createElement('button');
    btn.textContent = `÷${n}`;
    btn.addEventListener('click', e => { e.stopPropagation(); divideBar(track, barIdx, n); menu.remove(); });
    menu.appendChild(btn);
  });
  const rect = anchor.getBoundingClientRect();
  menu.style.left = rect.left + 'px';
  menu.style.top  = (rect.bottom + 4) + 'px';
  document.body.appendChild(menu);
  setTimeout(() => document.addEventListener('click', () => menu.remove(), { once: true }), 0);
}

function bulkDivide(track, count) {
  pushHistory();
  track.bars.forEach((bar, i) => {
    if (!bar) return;
    if (count === 1) {
      track.bars[i] = bar._divided ? (bar.slots[0] || null) : bar;
    } else if (bar._divided) {
      const slots = Array(count).fill(null);
      bar.slots.slice(0, count).forEach((s, si) => { slots[si] = s; });
      track.bars[i] = { _divided: true, count, slots };
    } else {
      const base = { ...bar, tie: false, span: 1 };
      track.bars[i] = { _divided: true, count, slots: Array(count).fill(null).map(() => ({ ...base })) };
    }
  });
  renderAll();
}

function showBulkDivMenu(track, anchor) {
  document.querySelectorAll('.div-menu').forEach(m => m.remove());
  const menu = document.createElement('div');
  menu.className = 'div-menu';
  [2, 3, 4].forEach(n => {
    const btn = document.createElement('button');
    btn.textContent = `÷${n}`;
    btn.addEventListener('click', e => { e.stopPropagation(); bulkDivide(track, n); menu.remove(); });
    menu.appendChild(btn);
  });
  const undoBtn = document.createElement('button');
  undoBtn.textContent = '해제';
  undoBtn.addEventListener('click', e => { e.stopPropagation(); bulkDivide(track, 1); menu.remove(); });
  menu.appendChild(undoBtn);
  const rect = anchor.getBoundingClientRect();
  menu.style.left = rect.left + 'px';
  menu.style.top  = (rect.bottom + 4) + 'px';
  document.body.appendChild(menu);
  setTimeout(() => document.addEventListener('click', () => menu.remove(), { once: true }), 0);
}

// ─── RENDERING ───────────────────────────
function renderAll() {
  renderTracks();
  updatePreviews();
  updateRepUI();
  const rpb = $('recPlayBtn');
  if (rpb) rpb.classList.toggle('recording', !!_vocalRec);
}

function renderTracks() {
  const area = $('tracksArea');
  area.innerHTML = '';
  S.tracks.forEach(track => {
    const row = document.createElement('div');
    row.className = 'track-row' + (track.id===S.activeTrackId?' active-track':'');
    row.dataset.tid = track.id;

    // header
    const hdr = document.createElement('div');
    hdr.className = 'track-header';
    hdr.innerHTML = `
      <div class="track-top">
        <span class="track-dot" style="background:${track.color}"></span>
        <input class="track-name-input" value="${track.name}">
        <button class="mute-btn${track.muted?' muted':''}" data-tid="${track.id}">${track.muted?'🔇':'🔊'}</button>
        <button class="del-track-btn" data-tid="${track.id}">✕</button>
      </div>
      <div class="track-selects">
        ${track.type !== 'drum' && track.type !== 'vocal' ? `<select class="track-sound" data-tid="${track.id}">
          <option value="piano"${track.sound==='piano'?' selected':''}>🎹 피아노</option>
          <option value="clean"${track.sound==='clean'?' selected':''}>✨ 클린</option>
          <option value="mellow"${track.sound==='mellow'?' selected':''}>🌊 멜로우</option>
          <option value="bell"${track.sound==='bell'?' selected':''}>🔔 벨</option>
          <option value="guitar"${track.sound==='guitar'?' selected':''}>🎸 기타</option>
          <option value="elec"${track.sound==='elec'?' selected':''}>💫 전자음</option>
          <option value="strings"${track.sound==='strings'?' selected':''}>🎻 스트링</option>
          <option value="flute"${track.sound==='flute'?' selected':''}>🪈 플루트</option>
          <option value="organ"${track.sound==='organ'?' selected':''}>🎵 오르간</option>
          <option value="bass"${track.sound==='bass'?' selected':''}>🎵 베이스</option>
          <option value="ebass"${track.sound==='ebass'?' selected':''}>🎸 일렉베이스</option>
          <option value="rhodes"${track.sound==='rhodes'?' selected':''}>🎹 로즈피아노</option>
          <option value="ngitar"${track.sound==='ngitar'?' selected':''}>🎸 나일론기타</option>
          <option value="sgitar"${track.sound==='sgitar'?' selected':''}>🎸 스틸기타</option>
          <option value="vib"${track.sound==='vib'?' selected':''}>🎵 비브라폰</option>
          <option value="choir"${track.sound==='choir'?' selected':''}>🎤 합창</option>
          <option value="sambass"${track.sound==='sambass'?' selected':''}>🎸 더블베이스</option>
        </select>` : ''}
        ${track.type==='chord'?`
        <select class="track-pattern" data-tid="${track.id}">
          <option value="chord"${track.pattern==='chord'?' selected':''}>코드 (전체)</option>
          <option value="fingerstyle"${track.pattern==='fingerstyle'?' selected':''}>핑거스타일</option>
          <option value="balladpiano"${track.pattern==='balladpiano'?' selected':''}>피아노 발라드</option>
          <option value="popoffbeat"${track.pattern==='popoffbeat'?' selected':''}>팝 오프비트</option>
          <option value="shuffle"${track.pattern==='shuffle'?' selected':''}>셔플</option>
          <option value="bossa"${track.pattern==='bossa'?' selected':''}>보사노바</option>
          <option value="reggae"${track.pattern==='reggae'?' selected':''}>레게</option>
          <option value="funk"${track.pattern==='funk'?' selected':''}>훵크</option>
          <option value="afrocuban"${track.pattern==='afrocuban'?' selected':''}>아프로큐반</option>
          <option value="jazzcomp"${track.pattern==='jazzcomp'?' selected':''}>재즈 콤핑</option>
        </select>
        <button class="tie-all-btn" data-tid="${track.id}" title="연속 동일 코드 일괄 이음">🔗 이음</button>
        <button class="tie-clr-btn" data-tid="${track.id}" title="모든 이음 해제">✂ 해제</button>`
        : track.type==='drum' ? ``
        : track.type==='vocal' ? `<button class="vocal-rec-toggle${_vocalRec?.trackId===track.id?' recording':''}" data-tid="${track.id}">${_vocalRec?.trackId===track.id?'⏹ 녹음 중지':'🔴 녹음'}</button>`
        : `<button class="tie-all-btn" data-tid="${track.id}" title="연속 동일 음 일괄 이음">🔗 이음</button>
           <button class="tie-clr-btn" data-tid="${track.id}" title="모든 이음 해제">✂ 해제</button>`}
        ${track.type !== 'drum' && track.type !== 'vocal' ? `<button class="bulk-div-btn" data-tid="${track.id}" title="모든 마디 일괄 박자 쪼개기">÷ 전체 쪼개기</button>` : ''}
      </div>
      <div class="vol-row">
        <span>볼륨</span>
        <input type="range" class="vol-slider" min="0" max="1.5" step="0.05" value="${track.volume??1}" data-tid="${track.id}">
        <span class="vol-val" data-tid="${track.id}">${Math.round((track.volume??1)*100)}%</span>
      </div>
      ${track.type !== 'drum' && track.type !== 'vocal' ? `<div class="vol-row">
        <span>옥타브</span>
        <button class="oct-shift-btn" data-tid="${track.id}" data-dir="-1" title="옥타브 내리기">↓8</button>
        <button class="oct-shift-btn" data-tid="${track.id}" data-dir="1"  title="옥타브 올리기">↑8</button>
      </div>` : ''}
      ${!track.samplerLoaded?`<span class="loading-ind" data-loading="${track.id}">샘플 로딩 중...</span>`:''}
    `;

    // name edit
    hdr.querySelector('.track-name-input').addEventListener('change', e => {
      track.name = e.target.value;
    });
    hdr.querySelector('.track-name-input').addEventListener('click', () => setActiveTrack(track.id));

    // mute
    hdr.querySelector('.mute-btn').addEventListener('click', e => {
      e.stopPropagation();
      track.muted = !track.muted;
      if (track.gain) track.gain.gain.value = track.muted ? 0 : (track.volume ?? 1.0) * 0.6;
      renderAll();
    });

    // delete
    hdr.querySelector('.del-track-btn').addEventListener('click', e => {
      e.stopPropagation();
      if (S.tracks.length <= 1) return;
      deleteTrack(track.id);
    });

    // vocal record button
    const vRecBtn = hdr.querySelector('.vocal-rec-toggle');
    if (vRecBtn) vRecBtn.addEventListener('click', e => {
      e.stopPropagation();
      if (_vocalRec?.trackId === track.id) stopVocalRecording();
      else startVocalRecording(track.id);
    });

    // sound change
    const soundEl = hdr.querySelector('.track-sound');
    if (soundEl) soundEl.addEventListener('change', e => {
      track.sound = e.target.value;
      initTrackSynth(track);
    });

    // pattern change
    const patEl = hdr.querySelector('.track-pattern');
    if (patEl) patEl.addEventListener('change', e => { track.pattern = e.target.value; renderAll(); });

    // arp speed
    const arpSpEl = hdr.querySelector('.arp-speed');
    if (arpSpEl) arpSpEl.addEventListener('change', e => { track.arpSpeed = parseInt(e.target.value); });

    // arp range
    const arpRngEl = hdr.querySelector('.arp-range');
    if (arpRngEl) arpRngEl.addEventListener('change', e => { track.arpRange = e.target.value; });

    // volume slider
    const volEl = hdr.querySelector('.vol-slider');
    const volValEl = hdr.querySelector('.vol-val');
    if (volEl) volEl.addEventListener('input', e => {
      track.volume = parseFloat(e.target.value);
      if (volValEl) volValEl.textContent = Math.round(track.volume * 100) + '%';
      if (track.gain && !track.muted) track.gain.gain.value = track.volume * 0.6;
    });

    // 일괄 이음 / 해제 버튼
    const tieAllEl = hdr.querySelector('.tie-all-btn');
    if (tieAllEl) tieAllEl.addEventListener('click', e => { e.stopPropagation(); autoTieTrack(track); });
    const tieClrEl = hdr.querySelector('.tie-clr-btn');
    if (tieClrEl) tieClrEl.addEventListener('click', e => { e.stopPropagation(); clearTieTrack(track); });
    const bulkDivEl = hdr.querySelector('.bulk-div-btn');
    if (bulkDivEl) bulkDivEl.addEventListener('click', e => { e.stopPropagation(); showBulkDivMenu(track, e.currentTarget); });
    hdr.querySelectorAll('.oct-shift-btn').forEach(btn => {
      btn.addEventListener('click', e => { e.stopPropagation(); transposeTrack(track, parseInt(btn.dataset.dir) * 12); });
    });

    // bars
    const barsDiv = document.createElement('div');
    barsDiv.dataset.tid = track.id;
    if (S.barsPerRow === 0) {
      barsDiv.className = 'track-bars unlimited';
    } else {
      barsDiv.className = 'track-bars';
      barsDiv.style.gridTemplateColumns = `repeat(${S.barsPerRow}, 1fr)`;
    }

    if (track.type === 'drum') {
      track.bars.forEach((item, bi) => {
        barsDiv.appendChild(makeDrumBarCell(track, item, bi));
      });
    } else if (track.type === 'vocal') {
      barsDiv.className = 'vocal-timeline-outer';
      barsDiv.style.cssText = 'overflow-x:auto;flex:1;';
      barsDiv.appendChild(makeVocalTimeline(track));
    } else {
      // 스팬으로 덮인 마디 계산
      const covered = new Set();
      track.bars.forEach((item, i) => {
        const sp = (item && !item._divided) ? (item.span || 1) : 1;
        for (let s = 1; s < sp && i+s < S.numBars; s++) covered.add(i+s);
      });

      track.bars.forEach((item, bi) => {
        if (covered.has(bi)) return;
        const cell = makeBarCell(track, item, bi);
        // 스팬 적용
        const sp = (item && !item._divided) ? (item.span || 1) : 1;
        if (sp > 1) { cell.style.gridColumn = `span ${sp}`; cell.classList.add('spanning'); }
        barsDiv.appendChild(cell);
      });
    }

    // click track header = activate (select 클릭은 제외 — 드롭다운 닫힘 방지)
    hdr.addEventListener('click', (e) => {
      if (e.target.closest('select') || e.target.closest('button')) return;
      setActiveTrack(track.id);
    });

    row.append(hdr, barsDiv);
    area.appendChild(row);
  });
}

const DRUM_PRESETS = {
  '기본':    { k:[1,0,0,0,0,0,0,0,1,0,0,0,0,0,0,0], s:[0,0,0,0,1,0,0,0,0,0,0,0,1,0,0,0], h:[1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0], o:[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0] },
  '훵크':    { k:[1,0,0,0,0,0,1,0,0,0,1,0,0,0,0,0], s:[0,0,0,0,1,0,0,0,0,0,0,0,1,0,0,1], h:[1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0], o:[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0] },
  '보사노바': { k:[1,0,0,1,0,0,1,0,0,0,1,0,0,0,0,0], s:[0,0,0,0,1,0,0,0,0,0,0,0,0,0,1,0], h:[1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0], o:[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0] },
  '재즈':    { k:[1,0,0,0,0,0,0,1,0,0,0,0,0,0,0,0], s:[0,0,0,0,0,0,1,0,0,0,0,0,1,0,0,0], h:[1,0,1,0,0,0,1,0,1,0,1,0,0,0,1,0], o:[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1] },
  '레게':    { k:[1,0,0,0,0,0,0,0,1,0,0,0,0,0,0,0], s:[0,0,0,0,0,0,0,0,0,0,0,0,1,0,0,0], h:[0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0], o:[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0] },
  '셔플':    { k:[1,0,0,0,0,0,0,0,1,0,0,0,0,0,0,0], s:[0,0,0,0,1,0,0,1,0,0,0,0,1,0,0,1], h:[1,0,0,1,0,0,1,0,0,1,0,0,1,0,0,1], o:[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0] },
};

function makeDrumBarCell(track, item, bi) {
  const cell = document.createElement('div');
  const sel = S.selMap[track.id];
  const isSel = sel && bi >= sel.start && bi <= sel.end;
  cell.className = 'bar-cell drum-bar' + (isSel?' selected':'') + (S.isPlaying&&bi===S.activeBar?' active-bar':'') + (item?' filled':'');
  cell.dataset.bar = bi;

  const numEl = document.createElement('span');
  numEl.className = 'bar-num';
  numEl.textContent = bi + 1;
  numEl.title = '클릭: 여기서부터 재생';
  numEl.addEventListener('click', e => {
    e.stopPropagation();
    S.playStart = bi;
    if (S.playEnd !== null && S.playEnd <= bi) S.playEnd = null;
    syncRangeInputs(); renderAll();
    if (S.isPlaying) { stopPlay(); Tone.start().then(() => startPlay()); }
  });
  cell.appendChild(numEl);

  if (item) {
    cell.appendChild(makeDrumMiniPreview(item));
    cell.addEventListener('click', e => { e.stopPropagation(); openDrumEditor(track, bi); });
    cell.addEventListener('contextmenu', e => { e.preventDefault(); pushHistory(); track.bars[bi]=null; renderAll(); });
  } else {
    const icon = document.createElement('div');
    icon.className = 'bar-empty';
    icon.textContent = '🥁';
    cell.appendChild(icon);
    cell.addEventListener('click', e => { e.stopPropagation(); openDrumEditor(track, bi); });
  }

  cell.addEventListener('pointerdown', e => {
    if (e.shiftKey) {
      e.stopPropagation();
      const s = S.selMap[track.id];
      if (!s) S.selMap[track.id] = {start:bi,end:bi};
      else S.selMap[track.id] = {start:Math.min(s.start,bi),end:Math.max(s.end,bi)};
      renderAll();
    }
  });
  return cell;
}

function makeDrumMiniPreview(item) {
  const COLORS = {k:'#e17055',s:'#fdcb6e',h:'#74b9ff',o:'#a29bfe'};
  const getSV = v => typeof v==='boolean'?(v?3:0):(v||0);
  const wrap = document.createElement('div');
  wrap.className = 'drum-mini-preview';
  ['k','s','h','o'].forEach(key => {
    const row = document.createElement('div');
    row.className = 'drum-mini-row';
    item.steps[key].forEach(v => {
      const val = getSV(v);
      const dot = document.createElement('span');
      dot.className = 'drum-mini-dot' + (val>0?' on':'');
      if (val>0) { dot.style.background=COLORS[key]; dot.style.opacity=val===1?'0.4':val===2?'0.7':'1'; }
      row.appendChild(dot);
    });
    wrap.appendChild(row);
  });
  return wrap;
}

function openDrumEditor(track, bi) {
  S._drumEditTrack = track;
  S._drumEditBi = bi;
  renderDrumEditor();
  $('drumEditorModal').classList.remove('hidden');
}

function renderDrumEditor() {
  const track = S._drumEditTrack, bi = S._drumEditBi;
  if (!track) return;
  $('drumEditBarNum').textContent = bi + 1;
  const presetsEl = $('drumEditorPresets'), gridEl = $('drumEditorGrid');
  presetsEl.innerHTML = ''; gridEl.innerHTML = '';
  let item = track.bars[bi];

  Object.keys(DRUM_PRESETS).forEach(name => {
    const btn = document.createElement('button');
    btn.className = 'drum-preset-btn';
    btn.textContent = name;
    btn.addEventListener('click', () => {
      pushHistory();
      const pat = DRUM_PRESETS[name];
      const steps = {k:pat.k.map(v=>v?3:0),s:pat.s.map(v=>v?3:0),h:pat.h.map(v=>v?3:0),o:pat.o.map(v=>v?3:0)};
      if (!track.bars[bi]) track.bars[bi]={_drum:true,steps};
      else track.bars[bi].steps=steps;
      item=track.bars[bi]; renderDrumEditor(); renderAll();
    });
    presetsEl.appendChild(btn);
  });

  if (item) {
    const clrBtn = document.createElement('button');
    clrBtn.className = 'drum-preset-btn drum-clr-btn';
    clrBtn.textContent = '✕ 지우기';
    clrBtn.addEventListener('click', () => { pushHistory(); track.bars[bi]=null; $('drumEditorModal').classList.add('hidden'); renderAll(); });
    presetsEl.appendChild(clrBtn);
  } else {
    const addBtn = document.createElement('button');
    addBtn.className = 'drum-preset-btn drum-add-btn';
    addBtn.textContent = '+ 빈 패턴';
    addBtn.addEventListener('click', () => {
      pushHistory();
      track.bars[bi]={_drum:true,steps:{k:Array(16).fill(0),s:Array(16).fill(0),h:Array(16).fill(0),o:Array(16).fill(0)}};
      item=track.bars[bi]; renderDrumEditor(); renderAll();
    });
    presetsEl.appendChild(addBtn);
    return;
  }

  const PARTS=[{key:'k',label:'킥',color:'#e17055'},{key:'s',label:'스네어',color:'#fdcb6e'},{key:'h',label:'하이햇',color:'#74b9ff'},{key:'o',label:'오픈햇',color:'#a29bfe'}];
  const getSV = v => typeof v==='boolean'?(v?3:0):(v||0);
  const applyBS = (btn, val, color) => {
    const isOn = val>0;
    btn.classList.toggle('on',isOn);
    btn.style.background = isOn?color:'';
    btn.style.opacity = isOn?(val===1?'0.38':val===2?'0.68':'1'):'';
    btn.title = isOn?['','약','중','강'][val]+' · 우클릭으로 세기 변경':'';
  };
  PARTS.forEach(({key,label,color}) => {
    const partRow = document.createElement('div');
    partRow.className = 'drum-edit-part-row';
    const lbl = document.createElement('span');
    lbl.className = 'drum-edit-label'; lbl.textContent = label;
    partRow.appendChild(lbl);
    const stepsDiv = document.createElement('div');
    stepsDiv.className = 'drum-edit-steps';
    item.steps[key].forEach((rawVal,si) => {
      const btn = document.createElement('button');
      btn.className = 'drum-step'+(si%4===0?' beat-s':'')+(si%8===0?' half-s':'');
      applyBS(btn,getSV(rawVal),color);
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const cur=getSV(item.steps[key][si]);
        item.steps[key][si]=cur>0?0:3;
        applyBS(btn,item.steps[key][si],color);
        updateDrumMiniPreviewCell();
      });
      btn.addEventListener('contextmenu', e => {
        e.preventDefault(); e.stopPropagation();
        const cur=getSV(item.steps[key][si]);
        if(!cur)return;
        item.steps[key][si]=cur===3?2:cur===2?1:3;
        applyBS(btn,item.steps[key][si],color);
        updateDrumMiniPreviewCell();
      });
      stepsDiv.appendChild(btn);
    });
    partRow.appendChild(stepsDiv);
    gridEl.appendChild(partRow);
  });
}

function updateDrumMiniPreviewCell() {
  const track=S._drumEditTrack, bi=S._drumEditBi;
  if(!track||!track.bars[bi])return;
  const cell=document.querySelector(`.drum-bar[data-bar="${bi}"]`);
  if(!cell)return;
  const ex=cell.querySelector('.drum-mini-preview');
  if(ex)ex.remove();
  cell.appendChild(makeDrumMiniPreview(track.bars[bi]));
  cell.classList.add('filled');
}

function makeBarCell(track, item, bi) {
  const cell = document.createElement('div');
  const sel = S.selMap[track.id];
  const isSel = sel && bi>=sel.start && bi<=sel.end;
  cell.className = 'bar-cell' +
    (item?' filled':'') +
    (isSel?' selected':'') +
    (S.isPlaying&&track.id===S.activeTrackId&&bi===S.activeBar?' active-bar':'');
  cell.dataset.bar = bi;

  // repeat section markers
  const rs = S.repSec;
  if (rs.start!==null && bi>=rs.start && bi<=rs.end) {
    if (bi===rs.start) cell.classList.add('rep-start');
    if (bi===rs.end)   cell.classList.add('rep-end');
    if (bi>rs.start&&bi<rs.end) cell.classList.add('rep-inner');
  }

  const numEl = document.createElement('span');
  numEl.className = 'bar-num'; numEl.textContent = bi+1;
  numEl.title = '클릭: 여기서부터 재생';
  numEl.style.cursor = 'pointer';
  numEl.addEventListener('click', e => {
    e.stopPropagation();
    S.playStart = bi;
    if (S.playEnd !== null && S.playEnd <= bi) S.playEnd = null;
    syncRangeInputs(); renderAll();
    if (S.isPlaying) { stopPlay(); Tone.start().then(() => startPlay()); }
  });
  cell.appendChild(numEl);

  if (item?._divided) {
    // ── 분할 마디 ──
    cell.classList.add('divided');
    const sg = document.createElement('div');
    sg.className = 'slot-grid';
    sg.style.gridTemplateColumns = `repeat(${item.count},1fr)`;
    item.slots.forEach((slotItem, si) => {
      const slot = document.createElement('div');
      slot.className = 'slot' + (slotItem ? ' filled' : ' empty');
      if (slotItem) {
        slot.style.background = slotItem.color + 'bb';
        if (slotItem.type === 'melody') {
          const n = document.createElement('span'); n.className='slot-root'; n.textContent=slotItem.label;
          slot.appendChild(n);
        } else {
          const r = document.createElement('span'); r.className='slot-root'; r.textContent=noteLabel(slotItem.root,slotItem.acc);
          const q = document.createElement('span'); q.className='slot-qual'; q.textContent=slotItem.quality==='maj'?'maj':slotItem.quality;
          slot.append(r,q);
        }
        // 슬롯 이음 버튼 (코드 슬롯만, si>0인 경우만 의미 있음)
        if (track.type === 'chord' && si > 0) {
          const stBtn = document.createElement('button');
          stBtn.className = 'slot-tie-btn' + (slotItem.tie ? ' active' : '');
          stBtn.textContent = '~';
          stBtn.title = slotItem.tie ? '이음 해제' : '이음';
          stBtn.addEventListener('click', e => {
            e.stopPropagation(); pushHistory();
            slotItem.tie = !slotItem.tie; renderAll();
          });
          slot.appendChild(stBtn);
          if (slotItem.tie) slot.classList.add('tied');
        }
      } else {
        const p = document.createElement('span'); p.className='slot-empty'; p.textContent='+';
        slot.appendChild(p);
      }
      if (slotItem) {
        const svIdx = slotItem.vel ?? 3;
        const svBtn = document.createElement('button');
        svBtn.className = 'slot-vel-btn' + (svIdx < 3 ? ' soft' : svIdx > 3 ? ' loud' : '');
        svBtn.textContent = VEL_LEVELS[svIdx].label;
        svBtn.addEventListener('click', e => {
          e.stopPropagation();
          slotItem.vel = ((slotItem.vel ?? 3) + 1) % VEL_LEVELS.length;
          renderAll();
        });
        slot.appendChild(svBtn);
        // octave controls per slot
        const octW = document.createElement('div');
        octW.className = 'slot-oct-wrap';
        const octU = document.createElement('button');
        octU.className = 'slot-oct-btn'; octU.textContent = '▲';
        octU.title = '옥타브 올리기';
        octU.addEventListener('click', e => {
          e.stopPropagation(); pushHistory();
          if (slotItem.type === 'melody') {
            const o = Math.min(7, (slotItem.oct ?? 4) + 1);
            slotItem.oct = o;
            slotItem.toneNote = melodyToneNote(slotItem.root, slotItem.acc||'n', o);
            slotItem.label = melodyNoteStr(slotItem.root, slotItem.acc||'n', o);
          } else {
            slotItem.oct = Math.min(6, (slotItem.oct ?? 3) + 1);
            slotItem.notes = invertNotes(chordNotes(slotItem.root, slotItem.acc||'n', slotItem.quality, slotItem.oct), slotItem.inv??0);
          }
          renderAll();
        });
        const octLbl = document.createElement('span');
        octLbl.className = 'slot-oct-lbl';
        octLbl.textContent = slotItem.oct ?? (slotItem.type==='melody' ? 4 : 3);
        const octD = document.createElement('button');
        octD.className = 'slot-oct-btn'; octD.textContent = '▼';
        octD.title = '옥타브 내리기';
        octD.addEventListener('click', e => {
          e.stopPropagation(); pushHistory();
          if (slotItem.type === 'melody') {
            const o = Math.max(1, (slotItem.oct ?? 4) - 1);
            slotItem.oct = o;
            slotItem.toneNote = melodyToneNote(slotItem.root, slotItem.acc||'n', o);
            slotItem.label = melodyNoteStr(slotItem.root, slotItem.acc||'n', o);
          } else {
            slotItem.oct = Math.max(1, (slotItem.oct ?? 3) - 1);
            slotItem.notes = invertNotes(chordNotes(slotItem.root, slotItem.acc||'n', slotItem.quality, slotItem.oct), slotItem.inv??0);
          }
          renderAll();
        });
        octW.append(octU, octLbl, octD);
        slot.appendChild(octW);
      }
      slot.addEventListener('click', e => {
        e.stopPropagation(); setActiveTrack(track.id);
        if (e.shiftKey) return; // Shift+클릭은 마디 선택 전용 (document 캡처 핸들러에서 처리)
        S.selMap = {}; S.selMap[track.id] = { start: bi, end: bi }; // 슬롯 클릭 시 해당 마디 선택
        if (S.repSetStep>0){handleRepClick(bi);return;}
        pushHistory();
        item.slots[si] = track.type==='melody' ? buildMelNote() : buildChord();
        renderAll();
      });
      slot.addEventListener('contextmenu', e => { e.preventDefault(); pushHistory(); item.slots[si]=null; renderAll(); });
      sg.appendChild(slot);
    });
    // 분할 해제 버튼
    const undivBtn = document.createElement('button');
    undivBtn.className='div-btn'; undivBtn.textContent=`÷${item.count}`;
    undivBtn.title='분할 해제 / 재분할';
    undivBtn.addEventListener('click', e => { e.stopPropagation(); showDivMenu(track,bi,undivBtn); });
    cell.append(sg, undivBtn); // numEl은 이미 cell.appendChild로 추가됨

  } else if (item) {
    // ── 일반 채워진 마디 ──
    cell.style.background = item.color + 'bb';
    if (item.type==='melody') {
      const n = document.createElement('div'); n.className='bar-mel-note'; n.textContent=item.label;
      cell.appendChild(n);
      // 멜로디/베이스 트랙: 옥타브 개별 조절 버튼
      if (track.type === 'melody') {
        const octWrap = document.createElement('div');
        octWrap.className = 'bar-oct-wrap';
        const octUp = document.createElement('button');
        octUp.className = 'oct-btn'; octUp.textContent = '▲';
        octUp.addEventListener('click', e => {
          e.stopPropagation(); pushHistory();
          const o = Math.min(7, (item.oct ?? 4) + 1);
          item.oct = o;
          item.toneNote = melodyToneNote(item.root, item.acc || 'n', o);
          item.label    = melodyNoteStr(item.root, item.acc || 'n', o);
          renderAll();
        });
        const octLbl = document.createElement('span');
        octLbl.className = 'oct-label'; octLbl.textContent = item.oct ?? 4;
        const octDn = document.createElement('button');
        octDn.className = 'oct-btn'; octDn.textContent = '▼';
        octDn.addEventListener('click', e => {
          e.stopPropagation(); pushHistory();
          const o = Math.max(1, (item.oct ?? 4) - 1);
          item.oct = o;
          item.toneNote = melodyToneNote(item.root, item.acc || 'n', o);
          item.label    = melodyNoteStr(item.root, item.acc || 'n', o);
          renderAll();
        });
        octWrap.append(octUp, octLbl, octDn);
        cell.appendChild(octWrap);
      }
    } else {
      const r=document.createElement('div'); r.className='bar-root'; r.textContent=noteLabel(item.root,item.acc);
      const q=document.createElement('div'); q.className='bar-qual'; q.textContent=`${item.quality==='maj'?'maj':item.quality} ${item.oct??3}`;
      const d=document.createElement('span'); d.className='del-bar'; d.textContent='✕';
      d.addEventListener('click', e=>{ e.stopPropagation(); pushHistory(); track.bars[bi]=null; renderAll(); });
      cell.append(r,q,d);
    }
    // 분할 버튼
    const divBtn = document.createElement('button');
    divBtn.className='div-btn'; divBtn.textContent='÷';
    divBtn.title='박자 나누기';
    divBtn.addEventListener('click', e=>{ e.stopPropagation(); showDivMenu(track,bi,divBtn); });
    cell.appendChild(divBtn);

    // 마디별 벨로시티 버튼
    const velBtn = document.createElement('button');
    const vIdx = item.vel ?? 3;
    velBtn.className = 'bar-vel-btn' + (vIdx < 3 ? ' soft' : vIdx > 3 ? ' loud' : '');
    velBtn.textContent = VEL_LEVELS[vIdx].label;
    velBtn.title = '음량 조절 (클릭으로 변경)';
    velBtn.addEventListener('click', e => {
      e.stopPropagation();
      item.vel = ((item.vel ?? 3) + 1) % VEL_LEVELS.length;
      renderAll();
    });
    cell.appendChild(velBtn);

    // 이음(타이) 토글 버튼 - 코드 + 멜로디(베이스) 트랙 공통
    {
      const tieTogBtn = document.createElement('button');
      tieTogBtn.className = 'tie-tog' + (item.tie ? ' active' : '');
      tieTogBtn.textContent = '~';
      tieTogBtn.title = item.tie ? '이음 해제 (재어택)' : '이음 (타이)';
      tieTogBtn.addEventListener('click', e => {
        e.stopPropagation();
        pushHistory();
        item.tie = !item.tie;
        renderAll();
      });
      cell.appendChild(tieTogBtn);
      if (item.tie) cell.classList.add('tied');
    }

    // 옥타브 조절 + 자리바꿈 - 코드 트랙만
    if (track.type === 'chord') {
      // 옥타브 조절
      const octWrap = document.createElement('div');
      octWrap.className = 'bar-oct-wrap';
      const curOct = item.oct ?? 3;
      const octUp = document.createElement('button');
      octUp.className = 'oct-btn'; octUp.textContent = '▲';
      octUp.addEventListener('click', e => {
        e.stopPropagation(); pushHistory();
        const o = Math.min(5, (item.oct??3)+1);
        item.oct = o; item.notes = invertNotes(chordNotes(item.root,item.acc,item.quality,o), item.inv ?? 0);
        renderAll();
      });
      const octLbl = document.createElement('span');
      octLbl.className = 'oct-label'; octLbl.textContent = curOct;
      const octDn = document.createElement('button');
      octDn.className = 'oct-btn'; octDn.textContent = '▼';
      octDn.addEventListener('click', e => {
        e.stopPropagation(); pushHistory();
        const o = Math.max(1, (item.oct??3)-1);
        item.oct = o; item.notes = invertNotes(chordNotes(item.root,item.acc,item.quality,o), item.inv ?? 0);
        renderAll();
      });
      octWrap.append(octUp, octLbl, octDn);
      cell.appendChild(octWrap);

      // 자리바꿈 버튼
      const INV_LABELS = ['근위','1전','2전','3전'];
      const invBtn = document.createElement('button');
      const curInv = item.inv ?? 0;
      invBtn.className = 'bar-inv-btn' + (curInv > 0 ? ' active' : '');
      invBtn.textContent = INV_LABELS[Math.min(curInv, 3)];
      invBtn.title = '자리바꿈 순환';
      invBtn.addEventListener('click', e => {
        e.stopPropagation(); pushHistory();
        const maxInv = Math.max(0, item.notes.length - 1);
        const newInv = ((item.inv ?? 0) + 1) % (maxInv + 1);
        item.inv = newInv;
        item.notes = invertNotes(chordNotes(item.root, item.acc, item.quality, item.oct ?? 3), newInv);
        renderAll();
      });
      cell.appendChild(invBtn);
    }

    // 이음음 핸들 (오른쪽 끝 드래그)
    const th = document.createElement('div');
    th.className = 'tie-handle';
    th.addEventListener('pointerdown', e => {
      e.stopPropagation(); e.preventDefault();
      th.setPointerCapture(e.pointerId);
      th.style.touchAction = 'none';
      const barsDiv = cell.closest('.track-bars');
      const colCount = S.barsPerRow > 0 ? S.barsPerRow : S.numBars;
      const cellW = (barsDiv?.clientWidth || 600) / colCount;
      tieDrag = { track, barIdx: bi, startX: e.clientX, cellW, origSpan: item.span || 1 };
    });
    cell.appendChild(th);

  } else {
    // ── 빈 마디 ──
    const p=document.createElement('div'); p.className='bar-empty'; p.textContent='+';
    cell.appendChild(p);
  }

  // 클릭 = 코드/멜로디 배치 (분할마디 제외)
  cell.addEventListener('click', e => {
    if (e.target.closest('.slot')||e.target.closest('.div-btn')||e.target.classList.contains('del-bar')) return;
    setActiveTrack(track.id);
    if (S.repSetStep>0){handleRepClick(bi);return;}
    if (S.dragSt||item?._divided) return;
    pushHistory();
    track.bars[bi] = track.type==='melody' ? buildMelNote() : buildChord();
    renderAll();
  });

  cell.addEventListener('contextmenu', e => {
    if (e.target.closest('.slot')) return;
    e.preventDefault(); pushHistory(); track.bars[bi]=null; renderAll();
  });

  cell.addEventListener('pointerdown', e => {
    if (e.button!==0||!track.bars[bi]) return;
    startDragWatch(e, track, bi);
  });

  return cell;
}

// ─── DRAG-COPY ───────────────────────────
let dragWatch = null;
let tieDrag = null; // { track, barIdx, startX, cellWidth }

function startDragWatch(e, track, barIdx) {
  dragWatch = { track, barIdx, startX:e.clientX, startY:e.clientY, started:false };
}

window.addEventListener('pointermove', e => {
  // 이음음 스팬 드래그
  if (tieDrag) {
    const dx = e.clientX - tieDrag.startX;
    const maxSp = S.barsPerRow > 0
      ? S.barsPerRow - (tieDrag.barIdx % S.barsPerRow)
      : S.numBars - tieDrag.barIdx;
    const newSp = Math.max(1, Math.min(Math.round(1 + dx / tieDrag.cellW), maxSp, S.numBars - tieDrag.barIdx));
    const it = tieDrag.track.bars[tieDrag.barIdx];
    if (it && newSp !== (it.span || 1)) { it.span = newSp; renderAll(); }
    return;
  }
  if (!dragWatch) return;
  const dx=e.clientX-dragWatch.startX, dy=e.clientY-dragWatch.startY;
  if (!dragWatch.started && Math.sqrt(dx*dx+dy*dy)<8) return;

  if (!dragWatch.started) {
    dragWatch.started = true;
    // collect selection or single bar
    const sel = S.selMap[dragWatch.track.id];
    if (sel) {
      dragWatch.bars = dragWatch.track.bars.slice(sel.start, sel.end+1).map(b=>b?JSON.parse(JSON.stringify(b)):null);
      dragWatch.srcStart = sel.start;
    } else {
      dragWatch.bars = [JSON.parse(JSON.stringify(dragWatch.track.bars[dragWatch.barIdx]))];
      dragWatch.srcStart = dragWatch.barIdx;
    }
    S.dragSt = { track:dragWatch.track, bars:dragWatch.bars, targetBar:-1 };
    const ghost=$('dragGhost');
    ghost.textContent=`${dragWatch.bars.filter(Boolean).length}개 복사 중`;
    ghost.classList.remove('hidden');
  }

  if (S.dragSt) {
    const ghost=$('dragGhost');
    ghost.style.left=(e.clientX+14)+'px';
    ghost.style.top=(e.clientY-10)+'px';
    // find target bar under cursor
    const el=document.elementFromPoint(e.clientX,e.clientY);
    const cell=el?.closest('.bar-cell');
    const barsDiv=cell?.closest('.track-bars');
    const tid=barsDiv?parseInt(barsDiv.dataset.tid):-1;
    S.dragSt.targetTrack = tid>=0 ? S.tracks.find(t=>t.id===tid)||null : null;
    S.dragSt.targetBar = cell ? parseInt(cell.dataset.bar) : -1;
  }
});

window.addEventListener('pointerup', e => {
  if (tieDrag) { tieDrag = null; return; }
  if (!dragWatch) return;
  const dst = S.dragSt;
  const dstTrack = dst?.targetTrack || dst?.track;
  if (dst && dst.targetBar>=0 && (dstTrack!==dragWatch.track || dst.targetBar!==dragWatch.srcStart)) {
    pushHistory();
    dst.bars.forEach((item,i)=>{
      const bi=dst.targetBar+i;
      if (!item||bi>=dstTrack.bars.length) return;
      if (item._divided) {
        if (dstTrack.type==='chord') {
          dstTrack.bars[bi] = item;
        } else {
          // 분할 코드슬롯 → 분할 멜로디슬롯 변환
          const slots = item.slots.map(slot => {
            if (!slot) return null;
            if (slot.type==='melody') return { ...slot };
            const oct = dstTrack.sound==='bass' ? 2 : (slot.oct||3);
            return { type:'melody', root:slot.root, acc:slot.acc||'n', oct,
              toneNote:melodyToneNote(slot.root,slot.acc||'n',oct),
              label:melodyNoteStr(slot.root,slot.acc||'n',oct), color:'#ffe66d' };
          });
          dstTrack.bars[bi] = { _divided:true, count:item.count, slots };
        }
      } else if (item.type==='chord' && dstTrack.type==='melody') {
        const oct = dstTrack.sound === 'bass' ? 2 : (item.oct || 3);
        const toneNote = melodyToneNote(item.root, item.acc || 'n', oct);
        const label    = melodyNoteStr(item.root, item.acc || 'n', oct);
        dstTrack.bars[bi] = { type:'melody', root:item.root, acc:item.acc||'n', oct, toneNote, label, color:'#ffe66d', tie:item.tie||false, span:item.span||1 };
      } else if (item.type==='melody' && dstTrack.type==='chord') {
        // 멜로디 → 코드 변환 불가, 건너뜀
      } else {
        dstTrack.bars[bi] = item;
      }
    });
    renderAll();
  }
  $('dragGhost').classList.add('hidden');
  S.dragSt=null; dragWatch=null;
});

// ─── SELECTION (shift+click to range) ────
// ─── BUILDER PREVIEW ─────────────────────
function previewBuilderSound() {
  const activeTrack = S.tracks.find(t => t.id === S.activeTrackId);
  if (!activeTrack?.synth) return;
  Tone.start().then(() => {
    const notes = S.builderMode === 'melody'
      ? [buildMelNote().toneNote]
      : buildChord().notes;
    activeTrack.synth.triggerAttackRelease(notes, '2n', Tone.now() + 0.05, 0.75);
  });
}

window.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
  if (e.code === 'Space') {
    if (e.target.tagName === 'BUTTON' || e.target.tagName === 'SELECT') return;
    e.preventDefault();
    Tone.start().then(() => S.isPlaying ? stopPlay() : startPlay());
  } else if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
    e.preventDefault(); undo();
  } else if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
    e.preventDefault(); redo();
  } else if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
    const entries = Object.entries(S.selMap).filter(([,v]) => v);
    if (!entries.length) return;
    const [tid, sel] = entries[0];
    const srcTrack = S.tracks.find(t => t.id === parseInt(tid));
    if (!srcTrack) return;
    e.preventDefault();
    S.clipboard = {
      bars: JSON.parse(JSON.stringify(srcTrack.bars.slice(sel.start, sel.end+1))),
      srcType: srcTrack.type,
    };
  } else if ((e.ctrlKey || e.metaKey) && e.key === 'v') {
    if (!S.clipboard) return;
    const activeTrack = S.tracks.find(t => t.id === S.activeTrackId);
    if (!activeTrack) return;
    if (activeTrack.type === 'drum') {
      if (S.clipboard.srcType !== 'drum') return;
      const sel = S.selMap[S.activeTrackId];
      const startBar = sel ? sel.start : 0;
      e.preventDefault(); pushHistory();
      S.clipboard.bars.forEach((item, i) => {
        const bi = startBar + i;
        if (bi >= S.numBars) return;
        activeTrack.bars[bi] = item ? JSON.parse(JSON.stringify(item)) : null;
      });
      renderAll(); return;
    }
    if (activeTrack.type === 'vocal') {
      if (S.clipboard.srcType !== 'vocal') return;
      const sel = S.selMap[S.activeTrackId];
      const startBar = sel ? sel.start : 0;
      e.preventDefault(); pushHistory();
      S.clipboard.bars.forEach((item, i) => {
        const bi = startBar + i;
        if (bi >= S.numBars) return;
        activeTrack.bars[bi] = item ? JSON.parse(JSON.stringify(item)) : null;
        // AudioBuffer cache must be re-decoded on next play; clear stale entry
        delete activeTrack._vocalBuffers[bi];
      });
      renderAll(); return;
    }
    if (S.clipboard.srcType === 'vocal') return;
    const sel = S.selMap[S.activeTrackId];
    const startBar = sel ? sel.start : (S.kbCursor[S.activeTrackId] ?? 0);
    e.preventDefault();
    pushHistory();
    S.clipboard.bars.forEach((item, i) => {
      const bi = startBar + i;
      if (bi >= S.numBars || !item) return;
      if (item._divided) {
        if (activeTrack.type === 'chord') {
          activeTrack.bars[bi] = JSON.parse(JSON.stringify(item));
        } else {
          const slots = item.slots.map(slot => {
            if (!slot) return null;
            if (slot.type === 'melody') return { ...slot };
            const oct = activeTrack.sound === 'bass' || activeTrack.sound === 'ebass' ? 2 : (slot.oct||3);
            return { type:'melody', root:slot.root, acc:slot.acc||'n', oct,
              toneNote:melodyToneNote(slot.root,slot.acc||'n',oct),
              label:melodyNoteStr(slot.root,slot.acc||'n',oct), color:'#ffe66d' };
          });
          activeTrack.bars[bi] = { _divided:true, count:item.count, slots };
        }
      } else if (item.type==='chord' && activeTrack.type==='melody') {
        const oct = activeTrack.sound==='bass'||activeTrack.sound==='ebass' ? 2 : (item.oct||3);
        activeTrack.bars[bi] = { type:'melody', root:item.root, acc:item.acc||'n', oct,
          toneNote:melodyToneNote(item.root,item.acc||'n',oct),
          label:melodyNoteStr(item.root,item.acc||'n',oct), color:'#ffe66d',
          tie:item.tie||false, span:item.span||1 };
      } else if (item.type==='melody' && activeTrack.type==='chord') {
        // skip
      } else {
        activeTrack.bars[bi] = JSON.parse(JSON.stringify(item));
      }
    });
    renderAll();
  } else if (e.key === 'Delete' || e.key === 'Backspace') {
    const hasSel = Object.values(S.selMap).some(Boolean);
    if (!hasSel) return;
    e.preventDefault();
    pushHistory();
    S.tracks.forEach(track => {
      const sel = S.selMap[track.id];
      if (!sel) return;
      for (let i = sel.start; i <= sel.end; i++) track.bars[i] = null;
    });
    S.selMap = {};
    renderAll();
  } else if (!e.ctrlKey && !e.metaKey && !e.altKey) {
    const KB_NOTE = {
      a:['C','n'], w:['C','#'], s:['D','n'], e:['D','#'], d:['E','n'],
      f:['F','n'], t:['F','#'], g:['G','n'], y:['G','#'], h:['A','n'],
      u:['A','#'], j:['B','n'],
    };
    const kbn = KB_NOTE[e.key];
    if (!kbn) return;
    const activeTrack = S.tracks.find(t => t.id === S.activeTrackId);
    if (!activeTrack) return;
    e.preventDefault();
    const [root, acc] = kbn;
    let cur = S.kbCursor[activeTrack.id] ?? 0;
    if (cur >= S.numBars) cur = S.kbCursor[activeTrack.id] = 0;
    pushHistory();
    if (activeTrack.type === 'melody') {
      S.melRoot = root; S.melAcc = acc;
      activeTrack.bars[cur] = buildMelNote();
    } else {
      S.root = root; S.acc = acc;
      activeTrack.bars[cur] = buildChord();
    }
    S.kbCursor[activeTrack.id] = cur + 1;
    renderAll();
  }
});
// shift+click = 범위 선택 (note 입력 이벤트보다 먼저 캡처해서 막음)
document.addEventListener('click', e => {
  if (!e.shiftKey) return;
  const cell = e.target.closest('.bar-cell');
  if (!cell) return;
  const barsDiv = cell.closest('.track-bars');
  if (!barsDiv) return;
  e.stopPropagation(); // 하위 click 핸들러(note 입력) 차단
  e.preventDefault();
  const tid = parseInt(barsDiv.dataset.tid);
  const bi  = parseInt(cell.dataset.bar);
  const sel = S.selMap[tid];
  if (!sel) { S.selMap[tid]={start:bi,end:bi}; }
  else { S.selMap[tid]={start:Math.min(sel.start,bi),end:Math.max(sel.end,bi)}; }
  renderAll();
}, true);

// click elsewhere = clear selection
document.addEventListener('click', e => {
  if (e.shiftKey) return;
  if (e.target.closest('.bar-cell')) return;
  S.selMap={};
}, true);

// ─── REPEAT SECTION ──────────────────────
function handleRepClick(bi) {
  if (S.repSetStep===1) {
    S.repSec.start=bi; S.repSetStep=2;
    $('hintText').textContent=`끝 마디 클릭 (시작: ${bi+1}마디)`;
  } else if (S.repSetStep===2) {
    S.repSec.end = Math.max(bi, S.repSec.start);
    S.repSec.start = Math.min(bi, S.repSec.start);
    S.repSetStep=0;
    $('hintBar').classList.add('hidden');
    updateRepUI(); renderAll();
  }
}

function updateRepUI() {
  const has = S.repSec.start!==null && S.repSec.end!==null;
  $('repInfo').classList.toggle('hidden',!has);
  if (has) {
    $('repRange').textContent=`${S.repSec.start+1}~${S.repSec.end+1}마디`;
    $('repCntVal').textContent=S.repSec.times;
  }
}

function expandedBars(trackBars) {
  const rs=S.repSec;
  if (rs.start===null||rs.end===null) return [...trackBars];
  const out=[];
  for(let i=0;i<trackBars.length;i++){
    out.push(trackBars[i]);
    if(i===rs.end){
      for(let r=1;r<rs.times;r++)
        for(let j=rs.start;j<=rs.end;j++) out.push(trackBars[j]);
    }
  }
  return out;
}

// 원본 bar 인덱스 → expanded 인덱스 변환 (도돌이표 구간 이후 오프셋 보정)
function origToExpIdx(origIdx) {
  const rs = S.repSec;
  if (rs.start === null || rs.end === null) return origIdx;
  if (origIdx <= rs.end) return origIdx;
  return origIdx + (rs.times - 1) * (rs.end - rs.start + 1);
}

// ─── TRANSPOSE ───────────────────────────
const PC_SHARP = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];

function transposeItem(item, st) {
  if (!item) return null;
  // root/acc/oct 없는 멜로디 (코드→멜로디 드래그 변환): toneNote 직접 파싱
  if (item.type === 'melody' && !item.root) {
    const m = (item.toneNote||'').match(/^([A-G]#?)(\d+)$/);
    if (!m) return item;
    const pc = NOTES_ALL.indexOf(m[1]), oct = parseInt(m[2]);
    const abs = oct * 12 + pc + st;
    const newPc = ((abs % 12) + 12) % 12, newOct = Math.floor(abs / 12);
    const nn = NOTES_ALL[newPc];
    return { ...item, toneNote: nn + newOct, label: nn + newOct };
  }
  // 공통: 절대 피치 기반 → 옥타브 포함 정확히 이동
  const oldPc = getRootPc(item.root, item.acc);
  const baseOct = item.type === 'melody' ? (item.oct ?? 4) : (item.oct ?? 3);
  const absNew = baseOct * 12 + oldPc + st;
  const newOct = Math.floor(absNew / 12);
  const newPc  = ((absNew % 12) + 12) % 12;
  const nn = PC_SHARP[newPc];
  const nr = nn.length > 1 ? nn[0] : nn, na = nn.length > 1 ? '#' : 'n';
  if (item.type === 'melody') {
    return { ...item, root:nr, acc:na, oct:newOct,
      label:melodyNoteStr(nr,na,newOct), toneNote:melodyToneNote(nr,na,newOct) };
  }
  return { ...item, root:nr, acc:na, oct:newOct,
    label:chordLabel(nr,na,item.quality), color:chordColor(item.quality),
    notes:chordNotes(nr,na,item.quality,newOct) };
}

function transposeTrack(track, st) {
  if (track.type === 'drum' || track.type === 'vocal') return;
  pushHistory();
  track.bars = track.bars.map(item => {
    if (!item) return null;
    if (item._divided) return { ...item, slots: item.slots.map(s => transposeItem(s, st)) };
    return transposeItem(item, st);
  });
  renderAll();
}

function transposeAll(st) {
  pushHistory();
  S.tracks.forEach(track => {
    if (track.type === 'drum' || track.type === 'vocal') return;
    track.bars = track.bars.map(item => {
      if (!item) return null;
      if (item._divided) return { ...item, slots: item.slots.map(s => transposeItem(s, st)) };
      return transposeItem(item, st);
    });
  });
  renderAll();
}

// ─── SAVE / LOAD ─────────────────────────
function saveState() {
  const snap = {
    tracks: S.tracks.map(t => ({
      id:t.id, type:t.type, color:t.color, name:t.name,
      bars:t.bars, sound:t.sound, pattern:t.pattern, muted:t.muted,
    })),
    bpm:S.bpm, numBars:S.numBars, globalRepeat:S.globalRepeat,
    barsPerRow:S.barsPerRow,
    repSec:S.repSec, playStart:S.playStart, playEnd:S.playEnd,
    nextTrackId:S.nextTrackId, activeTrackId:S.activeTrackId,
  };
  localStorage.setItem('chordSeq_v1', JSON.stringify(snap));
  const btn=$('saveBtn'); btn.textContent='✓ 저장됨';
  setTimeout(()=>{ btn.textContent='💾 저장'; }, 1400);
}

function loadState() {
  const raw = localStorage.getItem('chordSeq_v1');
  if (!raw) { alert('저장된 데이터가 없어요.'); return; }
  if (S.isPlaying) stopPlay();
  pushHistory();
  const snap = JSON.parse(raw);
  S.tracks.forEach(t => { try{t.synth?.dispose();}catch(e){} try{t.gain?.dispose();}catch(e){} });
  S.bpm          = snap.bpm          ?? 80;
  S.numBars      = snap.numBars      ?? 8;
  S.globalRepeat = snap.globalRepeat ?? 1;
  S.barsPerRow   = snap.barsPerRow   ?? 8;
  S.repSec       = snap.repSec       ?? {start:null,end:null,times:2};
  S.playStart    = snap.playStart    ?? 0;
  S.playEnd      = snap.playEnd      ?? null;
  S.nextTrackId  = snap.nextTrackId  ?? 0;
  S.activeTrackId= snap.activeTrackId ?? 0;
  S.tracks = (snap.tracks||[]).map(d => { const t={...d,synth:null,gain:null}; initTrackSynth(t); return t; });
  syncTopbarUI(); renderAll();
}

// 연속 동일 코드를 모두 이음(tie)으로 일괄 설정
function autoTieTrack(track) {
  pushHistory();
  const bars = track.bars;
  for (let i = 1; i < bars.length; i++) {
    const cur = bars[i], prev = bars[i-1];
    if (!cur || !prev) continue;
    const same = cur.root===prev.root && cur.acc===prev.acc && cur.quality===prev.quality && (cur.oct||3)===(prev.oct||3);
    bars[i].tie = same;
  }
  renderAll();
}

// 모든 이음(tie) 해제
function clearTieTrack(track) {
  pushHistory();
  track.bars.forEach(b => { if (b && !b._divided) b.tie = false; });
  renderAll();
}

// ─── PLAYBACK ────────────────────────────
// 이음(tie) 플래그가 있는 마디만 이전 블록에 병합, 기본은 마디마다 재어택
function tieBlocks(bars) {
  const out = []; let i = 0;
  while (i < bars.length) {
    if (!bars[i]) { i++; continue; }
    const item = bars[i];
    if (item.tie && out.length > 0) {
      const prev = out[out.length - 1];
      const pi = prev.item;
      const same = pi.type === item.type &&
        (item.type === 'melody'
          ? pi.label === item.label
          : pi.root === item.root && pi.acc === item.acc && pi.quality === item.quality);
      if (same) { prev.numBars++; i++; continue; }
    }
    out.push({ item, startBar: i, numBars: 1 });
    i++;
  }
  return out;
}

// 분할 슬롯 이음 병합 (tieBlocks의 슬롯 버전)
function tieSlots(slots) {
  const out = [];
  let i = 0;
  while (i < slots.length) {
    const slot = slots[i];
    if (!slot) { out.push({ slot: null, startIdx: i, count: 1 }); i++; continue; }
    if (slot.tie && out.length > 0) {
      const prev = out[out.length - 1];
      if (prev.slot) {
        const same = prev.slot.type === slot.type && (
          slot.type === 'melody' ? prev.slot.label === slot.label
            : prev.slot.root === slot.root && prev.slot.acc === slot.acc && prev.slot.quality === slot.quality
        );
        if (same) { prev.count++; i++; continue; }
      }
    }
    out.push({ slot, startIdx: i, count: 1 });
    i++;
  }
  return out;
}

function scheduleDrumBar(track, bar, t, barDur) {
  if (!track.drumSynths || !bar?._drum) return;
  const stepDur = barDur / 16;
  const ds = track.drumSynths;
  const vol = track.muted ? 0 : (track.volume ?? 1);
  const vm = v => {
    const n = typeof v === 'boolean' ? (v ? 3 : 0) : (v || 0);
    return n === 0 ? 0 : n === 1 ? 0.35 : n === 2 ? 0.65 : 1.0;
  };
  bar.steps.k.forEach((on, i) => {
    const m = vm(on); if (!m) return;
    Tone.Transport.schedule(time => { if(!S.isPlaying)return; ds.k.triggerAttackRelease('C1','8n',time, vol*0.9*m); }, Math.max(0, t+i*stepDur));
  });
  bar.steps.s.forEach((on, i) => {
    const m = vm(on); if (!m) return;
    Tone.Transport.schedule(time => { if(!S.isPlaying)return; ds.s.triggerAttackRelease('8n',time, vol*0.75*m); }, Math.max(0, t+i*stepDur));
  });
  bar.steps.h.forEach((on, i) => {
    const m = vm(on); if (!m) return;
    Tone.Transport.schedule(time => { if(!S.isPlaying)return; ds.h.triggerAttackRelease('32n',time, vol*0.5*m); }, Math.max(0, t+i*stepDur));
  });
  bar.steps.o.forEach((on, i) => {
    const m = vm(on); if (!m) return;
    Tone.Transport.schedule(time => { if(!S.isPlaying)return; ds.o.triggerAttackRelease('8n',time, vol*0.45*m); }, Math.max(0, t+i*stepDur));
  });
}

function scheduleTrack(track, barDur, offset) {
  if (track.type === 'vocal') {
    scheduleVocalTrack(track, barDur, offset);
    return;
  }
  if (track.type === 'drum') {
    if (!track.drumSynths) initDrumTrack(track);
    const expanded = expandedBars(track.bars);
    const ps = origToExpIdx(S.playStart);
    const pe = S.playEnd !== null ? origToExpIdx(S.playEnd) : (expanded.length - 1);
    const rangeLen = pe - ps + 1;
    const barT = (rep, bi) => offset + (rep * rangeLen + (bi - ps)) * barDur;
    for (let rep = 0; rep < S.globalRepeat; rep++) {
      for (let bi = ps; bi <= pe; bi++) {
        const bar = expanded[bi];
        if (bar?._drum) scheduleDrumBar(track, bar, barT(rep, bi), barDur);
      }
    }
    return;
  }

  const expanded = expandedBars(track.bars);
  const isBell    = track.sound === 'bell';
  const isMelody  = track.type === 'melody';
  const hasDivided = expanded.some(b => b?._divided);

  const hasSpan  = expanded.some(b => b && !b._divided && (b.span||1) > 1);
  const ps = origToExpIdx(S.playStart);
  const pe = S.playEnd !== null ? origToExpIdx(S.playEnd) : (expanded.length - 1);
  const rangeLen = pe - ps + 1;

  // 재생구간 내 bar → transport 상 시간 (구간 첫 bar = t=0 기준)
  function barT(rep, bi) { return offset + (rep * rangeLen + (bi - ps)) * barDur; }

  if (hasDivided || isBell || isMelody || hasSpan) {
    for (let rep = 0; rep < S.globalRepeat; rep++) {
      let bi = ps;
      while (bi <= pe) {
        const barItem = expanded[bi];
        if (!barItem) { bi++; continue; }
        const t = barT(rep, bi);
        if (barItem._divided) {
          const slotDur = barDur / barItem.count;
          tieSlots(barItem.slots).forEach(({ slot, startIdx, count }) => {
            if (slot) scheduleBlock(track, slot, t + startIdx * slotDur, count * slotDur, barDur);
          });
          bi++;
        } else {
          const sp = Math.min(barItem.span || 1, pe - bi + 1);
          let totalBars = sp, nextBi = bi + sp;
          // 이음(tie) 병합: 연속 동일 코드 타이 마디를 하나의 긴 음으로
          while (nextBi <= pe) {
            const nx = expanded[nextBi];
            if (!nx || nx._divided || !nx.tie) break;
            const same = nx.type === barItem.type && (
              barItem.type === 'melody' ? barItem.label === nx.label
                : barItem.root === nx.root && barItem.acc === nx.acc && barItem.quality === nx.quality
            );
            if (!same) break;
            const nsp = Math.min(nx.span || 1, pe - nextBi + 1);
            totalBars += nsp; nextBi += nsp;
          }
          scheduleBlock(track, barItem, t, totalBars * barDur, barDur);
          bi = nextBi;
        }
      }
    }
  } else {
    const blocks = tieBlocks(expanded.slice(ps, pe + 1));
    blocks.forEach(block => {
      for (let rep = 0; rep < S.globalRepeat; rep++) {
        const t = barT(rep, ps + block.startBar);
        scheduleBlock(track, block.item, t, block.numBars * barDur, barDur);
      }
    });
  }
}

function scheduleBlock(track, item, t, dur, barDur) {
  if (item.type==='melody') {
    Tone.Transport.schedule(time=>{
      if(!S.isPlaying) return;
      // 베이스 분할 슬롯: release 시간을 고려해 다음 음과 겹치지 않도록 계산
      const _rel = track.sound === 'bass' ? 0.16 : track.sound === 'ebass' ? 0.10 : 0;
      const noteDur = (track.sound === 'bass' || track.sound === 'ebass') && dur < barDur * 0.75
        ? Math.max(0.05, dur - _rel - 0.04)
        : Math.max(0.1, dur - 0.05);
      const mVel = (track.sound === 'bass' || track.sound === 'ebass')
        ? barVel(item, 0.7) * bassLoudComp(item.toneNote)
        : barVel(item, 0.7);
      track.synth.triggerAttackRelease(item.toneNote, noteDur, time, Math.min(1.0, mVel));
    }, Math.max(0.01, t));
    return;
  }

  const notes = item.notes;
  switch(track.pattern) {
    case 'chord':
      Tone.Transport.schedule(time=>{
        if(!S.isPlaying)return;
        const noteDur = (track.sound === 'mellow' && dur < barDur * 1.5)
          ? Math.max(0.1, dur - 0.15)
          : Math.max(0.1, dur - 0.05);
        track.synth.triggerAttackRelease(notes, noteDur, time, barVel(item, 0.75));
      }, Math.max(0.01, t));
      break;

    case 'arp': {
      const sp = track.arpSpeed || 1;
      const arpNotes = makeArpNoteList(notes, track.arpRange || 'standard');
      const numN = arpNotes.length;
      const step = barDur / (numN * sp);
      const total = Math.round(dur / barDur) * numN * sp;
      const vel = barVel(item, 0.65);
      for (let i = 0; i < total; i++) {
        const n = arpNotes[i % numN];
        Tone.Transport.schedule(time => { if(!S.isPlaying)return; track.synth.triggerAttackRelease(n, step*.88, time, vel); }, `${secToTick(t + i*step)}i`);
      }
      break;
    }

    case 'arpdn': {
      const sp = track.arpSpeed || 1;
      const arpNotes = makeArpNoteList(notes, track.arpRange || 'standard').slice().reverse();
      const numN = arpNotes.length;
      const step = barDur / (numN * sp);
      const total = Math.round(dur / barDur) * numN * sp;
      const vel = barVel(item, 0.65);
      for (let i = 0; i < total; i++) {
        const n = arpNotes[i % numN];
        Tone.Transport.schedule(time => { if(!S.isPlaying)return; track.synth.triggerAttackRelease(n, step*.88, time, vel); }, `${secToTick(t + i*step)}i`);
      }
      break;
    }

    case 'arpud': {
      const sp = track.arpSpeed || 1;
      const arpNotes = makeArpNoteList(notes, track.arpRange || 'standard');
      const bounce = [...arpNotes, ...arpNotes.slice(1,-1).reverse()];
      const step = barDur / (bounce.length * sp);
      const total = Math.round(dur / barDur) * bounce.length * sp;
      const vel = barVel(item, 0.65);
      for (let i = 0; i < total; i++) {
        const n = bounce[i % bounce.length];
        Tone.Transport.schedule(time => { if(!S.isPlaying)return; track.synth.triggerAttackRelease(n, step*.88, time, vel); }, `${secToTick(t + i*step)}i`);
      }
      break;
    }

    case 'arp1324': {
      const sp = track.arpSpeed || 1;
      const step = barDur / (4 * sp);
      const arpNotes = makeArpNoteList(notes, track.arpRange || 'standard').slice(0, 4);
      while (arpNotes.length < 4) arpNotes.push(arpNotes[arpNotes.length-1]);
      const ORDER = [0,2,1,3];
      const total = Math.round(dur / barDur) * 4 * sp;
      const vel = barVel(item, 0.65);
      for (let i = 0; i < total; i++) {
        const n = arpNotes[ORDER[i % 4]];
        Tone.Transport.schedule(time => { if(!S.isPlaying)return; track.synth.triggerAttackRelease(n, step*.88, time, vel); }, `${secToTick(t + i*step)}i`);
      }
      break;
    }

    case 'arpinch': {
      const sp = track.arpSpeed || 1;
      const step = barDur / (4 * sp);
      const arpNotes = makeArpNoteList(notes, track.arpRange || 'standard').slice(0, 4);
      while (arpNotes.length < 4) arpNotes.push(arpNotes[arpNotes.length-1]);
      const ORDER = [0,3,1,2];
      const total = Math.round(dur / barDur) * 4 * sp;
      const vel = barVel(item, 0.65);
      for (let i = 0; i < total; i++) {
        const n = arpNotes[ORDER[i % 4]];
        Tone.Transport.schedule(time => { if(!S.isPlaying)return; track.synth.triggerAttackRelease(n, step*.88, time, vel); }, `${secToTick(t + i*step)}i`);
      }
      break;
    }

    case 'arprnd': {
      const sp = track.arpSpeed || 1;
      const arpNotes = makeArpNoteList(notes, track.arpRange || 'standard');
      const numN = arpNotes.length;
      const step = barDur / (numN * sp);
      const barsCount = Math.round(dur / barDur);
      const vel = barVel(item, 0.65);
      for (let bar = 0; bar < barsCount; bar++) {
        const shuffled = [...arpNotes].sort(() => Math.random() - 0.5);
        for (let s = 0; s < numN * sp; s++) {
          const n = shuffled[s % numN];
          const i = bar * numN * sp + s;
          Tone.Transport.schedule(time => { if(!S.isPlaying)return; track.synth.triggerAttackRelease(n, step*.88, time, vel); }, `${secToTick(t + i*step)}i`);
        }
      }
      break;
    }

    case 'bass': {
      const beat=barDur/4;
      const bassNote=notes[0].replace(/\d+/,m=>String(Math.max(1,parseInt(m)-1)));
      const chordUpper=notes.slice(1);
      for(let b=0;b<Math.round(dur/barDur)*4;b++){
        const bt=t+b*beat+swOff(b,beat);
        if(b%2===0){
          Tone.Transport.schedule(time=>{ if(!S.isPlaying)return; track.synth.triggerAttackRelease(bassNote,beat*.85,time,Math.min(1.2,barVel(item,0.7)*bassLoudComp(bassNote))); }, Math.max(0,bt));
        } else {
          Tone.Transport.schedule(time=>{ if(!S.isPlaying)return; track.synth.triggerAttackRelease(chordUpper,beat*.85,time,barVel(item,0.55)); }, Math.max(0,bt));
        }
      }
      break;
    }

    case 'waltz': {
      // oom-pah-pah: root on 1, chord on 2&3
      const beat=barDur/3;
      const bassNote=notes[0].replace(/\d+/,m=>String(Math.max(1,parseInt(m)-1)));
      const chordUpper=notes.slice(1);
      for(let b=0;b<Math.round(dur/barDur)*3;b++){
        const bt=t+b*beat;
        if(b%3===0){
          Tone.Transport.schedule(time=>{ if(!S.isPlaying)return; track.synth.triggerAttackRelease(bassNote,beat*.8,time,barVel(item,0.7)); }, Math.max(0,bt));
        } else {
          Tone.Transport.schedule(time=>{ if(!S.isPlaying)return; track.synth.triggerAttackRelease(chordUpper,beat*.8,time,barVel(item,0.5)); }, Math.max(0,bt));
        }
      }
      break;
    }

    case 'bossa': {
      // 보사노바 리듬: B..CC B.C.  (8분음표 기준)
      // 8th 포지션: 0(베이스+코드), 2(코드), 3(코드), 4(베이스+코드), 5(코드), 7(코드)
      const half = barDur / 8;
      const bassNote = notes[0].replace(/\d+/, m => String(Math.max(1, parseInt(m)-1)));
      const upper = notes.length > 1 ? notes.slice(1) : notes;
      const barsCount = Math.round(dur / barDur);
      const vel = barVel(item, 0.65);
      const bv = vel * bassLoudComp(bassNote);
      // [8th위치, 베이스여부, 코드벨로시티배율]
      const PAT = [[0,true,0.90],[2,false,0.68],[3,false,0.78],[4,true,0.82],[5,false,0.62],[7,false,0.72]];
      for (let bar = 0; bar < barsCount; bar++) {
        const bt = t + bar * barDur;
        PAT.forEach(([pos, bass, vm]) => {
          const nt = `${secToTick(bt + pos * half)}i`;
          if (bass) {
            Tone.Transport.schedule(time => { if(!S.isPlaying)return; track.synth.triggerAttackRelease(bassNote, half*0.88, time, Math.min(1.2, bv*vm)); }, nt);
          }
          Tone.Transport.schedule(time => { if(!S.isPlaying)return; track.synth.triggerAttackRelease(upper, half*0.88, time, Math.min(1.0, vel*vm)); }, nt);
        });
      }
      break;
    }

    case 'reggae': {
      // 레게: 베이스 박1, 코드는 오프비트(and)에만
      const half = barDur / 8;
      const bassNote = notes[0].replace(/\d+/, m => String(Math.max(1, parseInt(m)-1)));
      const upper = notes.length > 1 ? notes.slice(1) : notes;
      const barsCount = Math.round(dur / barDur);
      const vel = barVel(item, 0.68);
      const bv = vel * bassLoudComp(bassNote);
      for (let bar = 0; bar < barsCount; bar++) {
        const bt = t + bar * barDur;
        Tone.Transport.schedule(time => { if(!S.isPlaying)return; track.synth.triggerAttackRelease(bassNote, half*0.55, time, Math.min(1.2, bv*0.90)); }, `${secToTick(bt)}i`);
        [1,3,5,7].forEach(pos => {
          Tone.Transport.schedule(time => { if(!S.isPlaying)return; track.synth.triggerAttackRelease(upper, half*0.82, time, vel*0.72); }, `${secToTick(bt + pos*half)}i`);
        });
      }
      break;
    }

    case 'funk': {
      // 훵크: 16분음표 베이스라인 + 싱코페이션 코드
      const s16 = barDur / 16;
      const bassNote = notes[0].replace(/\d+/, m => String(Math.max(1, parseInt(m)-1)));
      const upper = notes.length > 1 ? notes.slice(1) : notes;
      const barsCount = Math.round(dur / barDur);
      const vel = barVel(item, 0.70);
      const bv = vel * bassLoudComp(bassNote);
      // [16th위치, bass여부, velMult]
      const PAT = [[0,true,0.95],[3,false,0.55],[5,false,0.82],[7,false,0.50],[8,true,0.88],[11,false,0.55],[13,false,0.82],[15,false,0.48]];
      for (let bar = 0; bar < barsCount; bar++) {
        const bt = t + bar * barDur;
        PAT.forEach(([pos, bass, vm]) => {
          const nt = `${secToTick(bt + pos*s16)}i`;
          if (bass) Tone.Transport.schedule(time => { if(!S.isPlaying)return; track.synth.triggerAttackRelease(bassNote, s16*0.75, time, Math.min(1.2, bv*vm)); }, nt);
          Tone.Transport.schedule(time => { if(!S.isPlaying)return; track.synth.triggerAttackRelease(upper, s16*0.75, time, Math.min(1.0, vel*vm)); }, nt);
        });
      }
      break;
    }

    case 'afrocuban': {
      // 아프로큐반: 3-2 son clave (16분음표 포지션 0,3,6,10,12)
      const s16 = barDur / 16;
      const bassNote = notes[0].replace(/\d+/, m => String(Math.max(1, parseInt(m)-1)));
      const upper = notes.length > 1 ? notes.slice(1) : notes;
      const barsCount = Math.round(dur / barDur);
      const vel = barVel(item, 0.70);
      const bv = vel * bassLoudComp(bassNote);
      const CLAVE = [[0,true,0.95],[3,false,0.70],[6,false,0.80],[10,false,0.65],[12,true,0.88]];
      for (let bar = 0; bar < barsCount; bar++) {
        const bt = t + bar * barDur;
        CLAVE.forEach(([pos, bass, vm]) => {
          const nt = `${secToTick(bt + pos*s16)}i`;
          if (bass) Tone.Transport.schedule(time => { if(!S.isPlaying)return; track.synth.triggerAttackRelease(bassNote, s16*2, time, Math.min(1.2, bv*vm)); }, nt);
          Tone.Transport.schedule(time => { if(!S.isPlaying)return; track.synth.triggerAttackRelease(upper, s16*1.8, time, Math.min(1.0, vel*vm)); }, nt);
        });
      }
      break;
    }

    case 'jazzcomp': {
      // 재즈 콤핑: 마디마다 다른 코드 스텝 패턴 (8분음표)
      const half = barDur / 8;
      const upper = notes.length > 1 ? notes.slice(1) : notes;
      const barsCount = Math.round(dur / barDur);
      const vel = barVel(item, 0.60);
      const PATS = [
        [1,4,6], [0,3,5,7], [1,3,6], [2,4,7], [0,5,7], [1,2,5,7],
      ];
      for (let bar = 0; bar < barsCount; bar++) {
        const bt = t + bar * barDur;
        const pat = PATS[bar % PATS.length];
        pat.forEach((pos, i) => {
          const vm = i === 0 ? 0.88 : 0.65 + (i%2)*0.12;
          Tone.Transport.schedule(time => { if(!S.isPlaying)return; track.synth.triggerAttackRelease(upper, half*0.80, time, Math.min(1.0, vel*vm)); }, `${secToTick(bt + pos*half)}i`);
        });
      }
      break;
    }

    case 'balladpiano': {
      // 피아노 발라드: 한 마디 두 번, 베이스 + 코드 롤 → 레가토 오버랩으로 음 끊김 없음
      const half = barDur / 2;
      const bassNote = notes[0].replace(/\d+/, m => String(Math.max(1, parseInt(m)-1)));
      const upper = notes.length > 1 ? notes.slice(1) : [notes[0]];
      const barsCount = Math.round(dur / barDur);
      const baseVel = barVel(item, 0.70);
      const SPREAD = 0.020; // 음표 간 20ms 롤 → 피아니스트 손가락 느낌

      for (let bar = 0; bar < barsCount; bar++) {
        const bt = t + bar * barDur;
        for (let hit = 0; hit < 2; hit++) {
          const ht = bt + hit * half;
          const vs = hit === 0 ? 1.0 : 0.84; // 두 번째 타격 살짝 여리게
          const noteDur = half * 1.10; // 다음 타격과 10% 겹쳐서 레가토
          const bv = Math.min(1.1, baseVel * vs * bassLoudComp(bassNote));
          // 베이스 먼저
          Tone.Transport.schedule(time => {
            if (!S.isPlaying) return;
            track.synth.triggerAttackRelease(bassNote, noteDur, time, bv);
          }, `${secToTick(ht)}i`);
          // 코드 롤 (아래→위, 각 음 20ms 뒤)
          upper.forEach((note, ni) => {
            const cv = Math.min(1.0, baseVel * vs * (1 - ni * 0.05));
            Tone.Transport.schedule(time => {
              if (!S.isPlaying) return;
              track.synth.triggerAttackRelease(note, noteDur * 0.96, time, cv);
            }, `${secToTick(ht + SPREAD * (ni + 1))}i`);
          });
        }
      }
      break;
    }

    case 'popoffbeat': {
      // 베이스 1&3박, 코드 오프비트 스태카토
      const eighth = barDur / 8;
      const bassNote = notes[0].replace(/\d+/, m => String(Math.max(1, parseInt(m)-1)));
      const upper = notes.length > 1 ? notes.slice(1) : notes;
      const barsCount = Math.round(dur / barDur);
      const vel = barVel(item, 0.65);
      const bv = Math.min(1.2, vel * bassLoudComp(bassNote));
      // [8분음표 위치, 베이스여부, 벨로시티배율, 길이배율]
      const PAT = [
        [0, true,  1.00, 0.80],
        [1, false, 0.70, 0.38],
        [3, false, 0.75, 0.38],
        [4, true,  0.90, 0.75],
        [5, false, 0.65, 0.38],
        [7, false, 0.80, 0.38],
      ];
      for (let bar = 0; bar < barsCount; bar++) {
        const bt = t + bar * barDur;
        PAT.forEach(([pos, isBass, vm, dm]) => {
          const nt = `${secToTick(bt + pos * eighth)}i`;
          if (isBass) {
            Tone.Transport.schedule(time => { if(!S.isPlaying)return; track.synth.triggerAttackRelease(bassNote, eighth*dm, time, Math.min(1.2, bv*vm)); }, nt);
          } else {
            Tone.Transport.schedule(time => { if(!S.isPlaying)return; track.synth.triggerAttackRelease(upper, eighth*dm, time, Math.min(1.0, vel*vm)); }, nt);
          }
        });
      }
      break;
    }

    case 'shuffle': {
      // 블루스 셔플: 3연음 장단, 베이스 1&3, 코드 백비트 2&4
      const beat = barDur / 4;
      const triplet = beat / 3;
      const bassNote = notes[0].replace(/\d+/, m => String(Math.max(1, parseInt(m)-1)));
      const bass5 = notes.length > 2
        ? notes[2].replace(/\d+/, m => String(Math.max(1, parseInt(m)-1)))
        : bassNote;
      const upper = notes.length > 1 ? notes.slice(1) : notes;
      const barsCount = Math.round(dur / barDur);
      const vel = barVel(item, 0.65);
      const bv = Math.min(1.2, vel * bassLoudComp(bassNote));
      for (let bar = 0; bar < barsCount; bar++) {
        const bt = t + bar * barDur;
        // beat 1: 베이스 루트
        Tone.Transport.schedule(time => { if(!S.isPlaying)return; track.synth.triggerAttackRelease(bassNote, beat*0.75, time, Math.min(1.2, bv)); }, `${secToTick(bt)}i`);
        // and of 1 (3연음 3번째): 코드 스태카토
        Tone.Transport.schedule(time => { if(!S.isPlaying)return; track.synth.triggerAttackRelease(upper, triplet*0.65, time, Math.min(1.0, vel*0.62)); }, `${secToTick(bt + triplet*2)}i`);
        // beat 2: 코드 백비트
        Tone.Transport.schedule(time => { if(!S.isPlaying)return; track.synth.triggerAttackRelease(upper, beat*0.52, time, Math.min(1.0, vel*0.82)); }, `${secToTick(bt + beat)}i`);
        // beat 3: 베이스 5도
        Tone.Transport.schedule(time => { if(!S.isPlaying)return; track.synth.triggerAttackRelease(bass5, beat*0.75, time, Math.min(1.2, bv*0.88)); }, `${secToTick(bt + beat*2)}i`);
        // and of 3: 코드 스태카토
        Tone.Transport.schedule(time => { if(!S.isPlaying)return; track.synth.triggerAttackRelease(upper, triplet*0.65, time, Math.min(1.0, vel*0.58)); }, `${secToTick(bt + beat*2 + triplet*2)}i`);
        // beat 4: 코드 백비트
        Tone.Transport.schedule(time => { if(!S.isPlaying)return; track.synth.triggerAttackRelease(upper, beat*0.52, time, Math.min(1.0, vel*0.76)); }, `${secToTick(bt + beat*3)}i`);
      }
      break;
    }

    case 'fingerstyle': {
      // 핑거스타일: 엄지(베이스) + 손가락이 화음 음을 교대로 뜯음
      const half = barDur / 8;
      const bassNote = notes[0].replace(/\d+/, m => String(Math.max(1, parseInt(m)-1)));
      const fingers = notes;
      const barsCount = Math.round(dur / barDur);
      const vel = barVel(item, 0.66);
      const bv = vel * bassLoudComp(bassNote);
      for (let bar = 0; bar < barsCount; bar++) {
        const bt = t + bar * barDur;
        let fi = 0;
        for (let pos = 0; pos < 8; pos++) {
          const nt = `${secToTick(bt + pos*half)}i`;
          if (pos === 0 || pos === 4) {
            Tone.Transport.schedule(time => { if(!S.isPlaying)return; track.synth.triggerAttackRelease(bassNote, half*0.92, time, Math.min(1.2, bv*0.90)); }, nt);
          } else {
            const fn = fingers[fi % fingers.length]; fi++;
            const vm = pos % 2 === 0 ? 0.70 : 0.60;
            Tone.Transport.schedule(time => { if(!S.isPlaying)return; track.synth.triggerAttackRelease(fn, half*0.88, time, Math.min(1.0, vel*vm)); }, nt);
          }
        }
      }
      break;
    }
  }
}

$('playBtn').addEventListener('click', async()=>{
  await Tone.start();
  S.isPlaying ? stopPlay() : startPlay();
});

$('recPlayBtn').addEventListener('click', async () => {
  await Tone.start();
  if (S.isPlaying) {
    // 재생 중이면 녹음만 토글
    if (_vocalRec) stopVocalRecording();
    else {
      const vt = S.tracks.find(t => t.type === 'vocal');
      if (vt) startVocalRecording(vt.id);
      else alert('보컬 트랙을 먼저 추가해 주세요.');
    }
    return;
  }
  // 재생+녹음 동시 시작
  const vt = S.tracks.find(t => t.type === 'vocal');
  if (!vt) { alert('보컬 트랙을 먼저 추가해 주세요.'); return; }
  await startPlay();
  await startVocalRecording(vt.id);
});
$('stopBtn').addEventListener('click', stopPlay);
$('loopBtn').addEventListener('click', () => {
  S.loopPlay = !S.loopPlay;
  $('loopBtn').classList.toggle('active', S.loopPlay);
});

let _metronomeSynth = null;

async function startPlay() {
  S.tracks.forEach(t=>{
    if (t.type === 'drum') { if(!t.drumSynths) initDrumTrack(t); }
    else if (t.type === 'vocal') { if(!t.gain) initVocalTrack(t); }
    else { if(!t.synth||!t.gain) initTrackSynth(t); }
  });
  for (const t of S.tracks) {
    if (t.type === 'vocal') await decodeVocalClips(t);
  }

  const OFFSET = 0.1;
  const barDur = 60/S.bpm*4;
  const maxExpanded = Math.max(...S.tracks.map(t=>expandedBars(t.bars).length));
  S.expandedLen = maxExpanded;

  Tone.Transport.cancel(); Tone.Transport.stop(); Tone.Transport.position=0;
  Tone.Transport.bpm.value = S.bpm;
  Tone.Transport.swingSubdivision = '8n';
  Tone.Transport.swing = S.swing;

  S.tracks.forEach(t=>{ if(!t.muted) scheduleTrack(t,barDur,OFFSET); });

  const psExp    = origToExpIdx(S.playStart);
  const peExp    = S.playEnd !== null ? origToExpIdx(S.playEnd) : maxExpanded - 1;
  const rangeLen = peExp - psExp + 1;
  const totalDur = rangeLen * S.globalRepeat * barDur + OFFSET;

  if (S.metronome) {
    if (!_metronomeSynth) {
      _metronomeSynth = new Tone.PolySynth(Tone.Synth, {
        oscillator:{type:'triangle'}, envelope:{attack:.001,decay:.06,sustain:0,release:.05},
      });
      _metronomeSynth.connect(new Tone.Gain(0.28).toDestination());
    }
    const beatDur = barDur / 4;
    for (let rep = 0; rep < S.globalRepeat; rep++) {
      for (let bi = 0; bi < rangeLen; bi++) {
        for (let beat = 0; beat < 4; beat++) {
          const mt = OFFSET + (rep * rangeLen + bi) * barDur + beat * beatDur;
          const note = beat === 0 ? 'A5' : 'E5';
          const vel  = beat === 0 ? 0.7 : 0.35;
          Tone.Transport.schedule(time => {
            if (!S.isPlaying) return;
            _metronomeSynth.triggerAttackRelease(note, '64n', time, vel);
          }, mt);
        }
      }
    }
  }

  Tone.Transport.schedule(()=>setTimeout(()=>{ S.loopPlay ? startPlay() : stopPlay(); },0), totalDur-0.1);
  S.expandedLen = rangeLen;
  Tone.Transport.start('+0.02');

  S.isPlaying=true;
  $('playBtn').textContent='⏸ 일시정지';
  $('playBtn').classList.add('playing');
  animLoop();
}

function stopPlay() {
  if (_vocalRec) stopVocalRecording();
  _vocalSources.forEach(src => { try { src.stop(); } catch(e) {} });
  _vocalSources = [];
  S.isPlaying=false;
  Tone.Transport.stop(); Tone.Transport.cancel();
  S.tracks.forEach(t=>{ try{t.synth&&t.synth.releaseAll&&t.synth.releaseAll('+0.08');}catch(e){} });
  cancelAnimationFrame(S.animFr);
  S.activeBar=-1;
  $('playBtn').textContent='▶ 재생';
  $('playBtn').classList.remove('playing');
  $('nowLabel').textContent='대기 중';
  document.querySelectorAll('.bar-cell.active-bar').forEach(el=>el.classList.remove('active-bar'));
  const pfEl = $('progressFill');
  if (pfEl) pfEl.style.width = '0%';
  S.tracks.forEach(t => { if (t._timelineCursor) t._timelineCursor.style.display = 'none'; });
}

// expanded index → 실제 화면 bar index 매핑 (도돌이표 대응)
function expandedToVisual(idx) {
  const rs = S.repSec;
  if (rs.start === null || rs.end === null) return idx % S.numBars;
  const map = [];
  for (let i = 0; i < S.numBars; i++) {
    map.push(i);
    if (i === rs.end)
      for (let r = 1; r < rs.times; r++)
        for (let j = rs.start; j <= rs.end; j++) map.push(j);
  }
  return map[idx % map.length] ?? (idx % S.numBars);
}

function animLoop() {
  const barDur = 60/S.bpm*4;
  const elapsed = Tone.Transport.seconds;
  const totalTime = (S.expandedLen || 1) * barDur;
  const pct = Math.min(100, (elapsed % totalTime) / totalTime * 100);
  const pfEl = $('progressFill');
  if (pfEl) pfEl.style.width = pct + '%';

  const psExp  = origToExpIdx(S.playStart);
  const cur    = psExp + (Math.floor(elapsed/barDur) % S.expandedLen);
  const visual = expandedToVisual(cur);
  if (cur !== S.activeBar) {
    S.activeBar = cur;
    $('nowLabel').textContent = `마디 ${visual+1}`;
    document.querySelectorAll('.bar-cell.active-bar').forEach(el=>el.classList.remove('active-bar'));
    document.querySelectorAll(`.bar-cell[data-bar="${visual}"]`).forEach(el=>el.classList.add('active-bar'));
    updateCamChord(visual);
  }
  // 보컬 타임라인 재생 커서
  const songSec = Tone.Transport.seconds - 0.1;
  S.tracks.forEach(t => {
    if (t.type !== 'vocal' || !t._timelineCursor) return;
    const barDurV = t._timelineBarDur || (60/S.bpm*4);
    const x = songSec / barDurV * VOCAL_PX_PER_BAR;
    t._timelineCursor.style.display = x >= 0 ? '' : 'none';
    t._timelineCursor.style.left = Math.max(0, x) + 'px';
  });

  if (S.isPlaying) S.animFr = requestAnimationFrame(animLoop);
}

// ─── BUILDER ─────────────────────────────
function updatePreviews() {
  const cl = chordLabel(S.root,S.acc,S.quality);
  const cc = chordColor(S.quality);
  $('chordPreview').textContent=cl; $('chordPreview').style.color=cc;
  $('melPreview').textContent=melodyNoteStr(S.melRoot,S.melAcc,S.melOct);
}

function setupToggle(groupId, stateKey, cb) {
  $(groupId).addEventListener('click', e=>{
    const btn=e.target.closest('.tog'); if(!btn)return;
    $(groupId).querySelectorAll('.tog').forEach(b=>b.classList.remove('sel'));
    btn.classList.add('sel');
    S[stateKey]=btn.dataset.val;
    if(cb)cb();
  });
}
setupToggle('rootGroup','root',updatePreviews);
setupToggle('accGroup','acc',updatePreviews);
setupToggle('qualGroup','quality',updatePreviews);
setupToggle('chordOctGroup','chordOct',updatePreviews);
setupToggle('melRootGroup','melRoot',updatePreviews);
setupToggle('melAccGroup','melAcc',updatePreviews);
setupToggle('melOctGroup','melOct',updatePreviews);

document.querySelectorAll('#invGroup .tog').forEach(b => {
  b.addEventListener('click', () => {
    S.inv = parseInt(b.dataset.val);
    document.querySelectorAll('#invGroup .tog').forEach(x => x.classList.toggle('sel', x===b));
    updatePreviews();
  });
});

function switchBuilderMode(mode) {
  S.builderMode=mode;
  $('chordBuilder').classList.toggle('hidden',mode!=='chord');
  $('melodyBuilder').classList.toggle('hidden',mode!=='melody');
  document.querySelectorAll('.tab-btn').forEach(b=>b.classList.toggle('active',b.dataset.mode===mode));
}
document.querySelectorAll('.tab-btn').forEach(b=>{
  b.addEventListener('click',()=>switchBuilderMode(b.dataset.mode));
});

// ─── CONTROLS ────────────────────────────
const bpmInput=$('bpmInput');
$('bpmMinus').addEventListener('click',()=>{ S.bpm=Math.max(40,S.bpm-1); bpmInput.value=S.bpm; });
$('bpmPlus').addEventListener('click', ()=>{ S.bpm=Math.min(220,S.bpm+1);bpmInput.value=S.bpm; });
bpmInput.addEventListener('change',()=>{ S.bpm=Math.max(40,Math.min(220,parseInt(bpmInput.value)||80)); bpmInput.value=S.bpm; });
$('bpmX2Btn').addEventListener('click',()=>{ S.bpm=Math.min(220,S.bpm*2); bpmInput.value=S.bpm; Tone.Transport.bpm.value=S.bpm; });
$('bpmD2Btn').addEventListener('click',()=>{ S.bpm=Math.max(40,Math.floor(S.bpm/2)); bpmInput.value=S.bpm; Tone.Transport.bpm.value=S.bpm; });

// ─── TAP TEMPO ────────────────────────────
{ let _taps=[], _tapTimer=null;
  $('tapTempoBtn').addEventListener('click', () => {
    const now = Date.now();
    if (_tapTimer) clearTimeout(_tapTimer);
    _tapTimer = setTimeout(() => { _taps = []; }, 2000);
    _taps.push(now);
    if (_taps.length > 8) _taps.shift();
    const btn = $('tapTempoBtn');
    btn.classList.add('tapped');
    setTimeout(() => btn.classList.remove('tapped'), 80);
    if (_taps.length < 2) return;
    const intervals = [];
    for (let i = 1; i < _taps.length; i++) intervals.push(_taps[i] - _taps[i-1]);
    const avg = intervals.reduce((a,b)=>a+b,0) / intervals.length;
    const bpm = Math.round(60000 / avg);
    if (bpm >= 40 && bpm <= 220) {
      S.bpm = bpm; bpmInput.value = bpm;
      Tone.Transport.bpm.value = bpm;
    }
  });
}

function applyNumBars(v) {
  pushHistory();
  v = Math.max(1, Math.min(256, v || 8));
  $('barsVal').value = v;
  if (v > S.numBars) {
    S.tracks.forEach(t=>{ while(t.bars.length<v)t.bars.push(null); });
  } else {
    S.tracks.forEach(t=>{ t.bars.length=v; });
    if (S.playEnd !== null && S.playEnd >= v) S.playEnd = v - 1;
  }
  S.numBars = v;
  syncRangeInputs(); renderAll();
}
$('barsMinus').addEventListener('click',()=>applyNumBars(S.numBars-1));
$('barsPlus').addEventListener('click', ()=>applyNumBars(S.numBars+1));
$('barsVal').addEventListener('change',()=>applyNumBars(parseInt($('barsVal').value)));

$('repMinus').addEventListener('click',()=>{ S.globalRepeat=Math.max(1,S.globalRepeat-1); $('repVal').textContent=S.globalRepeat; });
$('repPlus').addEventListener('click', ()=>{ S.globalRepeat=Math.min(8,S.globalRepeat+1);  $('repVal').textContent=S.globalRepeat; });

$('repSetBtn').addEventListener('click',()=>{
  S.repSetStep=1;
  $('hintBar').classList.remove('hidden');
  $('hintText').textContent='시작 마디를 클릭하세요';
});
$('hintCancelBtn').addEventListener('click',()=>{ S.repSetStep=0; $('hintBar').classList.add('hidden'); });
$('repCntMinus').addEventListener('click',()=>{ S.repSec.times=Math.max(2,S.repSec.times-1); updateRepUI(); });
$('repCntPlus').addEventListener('click', ()=>{ S.repSec.times=Math.min(8,S.repSec.times+1); updateRepUI(); });
$('repClearBtn').addEventListener('click',()=>{ S.repSec={start:null,end:null,times:2}; updateRepUI(); renderAll(); });

$('clearAll').addEventListener('click',()=>{ pushHistory(); S.tracks.forEach(t=>t.bars.fill(null)); renderAll(); });

$('bprSel').addEventListener('change', e => {
  S.barsPerRow = parseInt(e.target.value);
  renderAll();
});

// ─── 재생구간 선택 ────────────────────────
function syncRangeInputs() {
  $('psInput').value = S.playStart + 1;
  $('peInput').value = (S.playEnd ?? S.numBars - 1) + 1;
}
function applyRange() {
  const ps = Math.max(0, parseInt($('psInput').value) - 1) || 0;
  const pe = Math.min(S.numBars - 1, parseInt($('peInput').value) - 1);
  S.playStart = Math.min(ps, pe);
  S.playEnd   = Math.max(ps, pe);
  syncRangeInputs();
}
$('psInput').addEventListener('change', applyRange);
$('peInput').addEventListener('change', applyRange);
$('rangeAllBtn').addEventListener('click', () => {
  S.playStart = 0; S.playEnd = null;
  syncRangeInputs();
});

// ─── 코드 진행 프리셋 ─────────────────────────
const PROG_NOTE = [
  {root:'C',acc:'n'},{root:'C',acc:'#'},{root:'D',acc:'n'},{root:'E',acc:'b'},
  {root:'E',acc:'n'},{root:'F',acc:'n'},{root:'F',acc:'#'},{root:'G',acc:'n'},
  {root:'A',acc:'b'},{root:'A',acc:'n'},{root:'B',acc:'b'},{root:'B',acc:'n'},
];
const PROGRESSIONS = {
  pop:    [{o:0,q:'maj'},{o:7,q:'maj'},{o:9,q:'m'},{o:5,q:'maj'}],
  ballad: [{o:0,q:'maj'},{o:9,q:'m'},{o:5,q:'maj'},{o:7,q:'maj'}],
  ballad2:[{o:0,q:'maj'},{o:5,q:'maj'},{o:0,q:'maj'},{o:7,q:'maj'}],
  canon:  [{o:0,q:'maj'},{o:7,q:'maj'},{o:9,q:'m'},{o:4,q:'m'},{o:5,q:'maj'},{o:0,q:'maj'},{o:5,q:'maj'},{o:7,q:'maj'}],
  kpop:   [{o:9,q:'m'},{o:5,q:'maj'},{o:0,q:'maj'},{o:7,q:'maj'}],
  minor:  [{o:0,q:'m'},{o:8,q:'maj'},{o:3,q:'maj'},{o:10,q:'maj'}],
  jazz:   [{o:2,q:'m7'},{o:7,q:'7'},{o:0,q:'maj7'}],
};
$('progPresetBtn').addEventListener('click', () => {
  $('progPresetPanel').classList.toggle('hidden');
});
$('progApplyBtn').addEventListener('click', () => {
  const keySemi = parseInt($('progKeySelect').value);
  const steps = PROGRESSIONS[$('progSelect').value];
  if (!steps) return;
  const ct = S.tracks.find(t => t.type === 'chord');
  if (!ct) { alert('코드 트랙이 없어요.'); return; }
  pushHistory();
  for (let bi = 0; bi < S.numBars; bi++) {
    const step = steps[bi % steps.length];
    const n = PROG_NOTE[(keySemi + step.o) % 12];
    ct.bars[bi] = {
      type:'chord', root:n.root, acc:n.acc, quality:step.q, oct:3, inv:0,
      label:chordLabel(n.root,n.acc,step.q), color:chordColor(step.q),
      notes:invertNotes(chordNotes(n.root,n.acc,step.q,3),0),
    };
  }
  renderAll();
});

$('addChordTrack').addEventListener('click',()=>{ pushHistory(); createTrack('chord'); renderAll(); });
$('addMelTrack').addEventListener('click', ()=>{ pushHistory(); createTrack('melody'); renderAll(); });
$('addVocalTrack').addEventListener('click', () => {
  pushHistory();
  createTrack('vocal');
  renderAll();
});
$('addDrumTrack').addEventListener('click', () => {
  pushHistory();
  createTrack('drum');
  renderAll();
});

$('addBassTrack').addEventListener('click', ()=>{
  pushHistory();
  const t = createTrack('melody');
  t.sound = 'bass';
  t.name  = `베이스 ${t.id+1}`;
  initTrackSynth(t);
  S.melOct = 2;
  switchBuilderMode('melody');
  renderAll();
});

// 전조
$('transDown').addEventListener('click', () => transposeAll(-1));
$('transUp').addEventListener('click',   () => transposeAll(+1));
$('octDown').addEventListener('click',   () => transposeAll(-12));
$('octUp').addEventListener('click',     () => transposeAll(+12));

// ─── 멀티 저장 슬롯 ──────────────────────────
const SAVES_KEY = 'idiotcode_saves';
function getSaves() { try { return JSON.parse(localStorage.getItem(SAVES_KEY)||'[]'); } catch{ return []; } }
function putSaves(arr) { localStorage.setItem(SAVES_KEY, JSON.stringify(arr)); }

function saveToSlot(name) {
  const saves = getSaves();
  const idx = saves.findIndex(s => s.name === name);
  const entry = { name, date: new Date().toLocaleString('ko-KR'), data: getStateSnap() };
  if (idx >= 0) saves[idx] = entry; else saves.push(entry);
  putSaves(saves);
}
function loadFromSlot(name) {
  const saves = getSaves();
  const entry = saves.find(s => s.name === name);
  if (!entry) return;
  if (S.isPlaying) stopPlay();
  restoreSnap(entry.data);
}
function deleteSlot(name) {
  putSaves(getSaves().filter(s => s.name !== name));
  renderSaveModal();
}

function renderSaveModal() {
  const list = $('saveSlotList');
  const saves = getSaves();
  list.innerHTML = '';
  // 이전 버전(chordSeq_v1) 저장 데이터 복구 배너
  if (localStorage.getItem('chordSeq_v1')) {
    const banner = document.createElement('div');
    banner.className = 'modal-legacy';
    banner.innerHTML = `<span>⚠️ 이전 저장 데이터가 있어요</span>
      <button class="slot-load" id="legacyLoadBtn">불러오기</button>
      <button class="slot-del" id="legacyDelBtn" title="삭제">✕</button>`;
    banner.querySelector('#legacyLoadBtn').addEventListener('click', () => {
      loadState();
      $('projectModal').classList.add('hidden');
    });
    banner.querySelector('#legacyDelBtn').addEventListener('click', () => {
      if (confirm('이전 저장 데이터를 삭제할까요?')) {
        localStorage.removeItem('chordSeq_v1');
        renderSaveModal();
      }
    });
    list.appendChild(banner);
  }
  if (!saves.length && !localStorage.getItem('chordSeq_v1')) {
    list.innerHTML = '<div class="modal-empty">저장된 프로젝트가 없어요</div>';
    return;
  }
  saves.forEach(s => {
    const row = document.createElement('div');
    row.className = 'modal-slot';
    row.innerHTML = `<span class="slot-name">${s.name}</span><span class="slot-date">${s.date}</span>
      <button class="slot-overwrite" title="현재 상태로 덮어쓰기">💾</button>
      <button class="slot-load">열기</button><button class="slot-del">✕</button>`;
    row.querySelector('.slot-overwrite').addEventListener('click', () => { saveToSlot(s.name); renderSaveModal(); });
    row.querySelector('.slot-load').addEventListener('click', () => { loadFromSlot(s.name); $('projectModal').classList.add('hidden'); });
    row.querySelector('.slot-del').addEventListener('click', () => deleteSlot(s.name));
    list.appendChild(row);
  });
}

$('projectBtn').addEventListener('click', () => {
  renderSaveModal();
  $('projectModal').classList.remove('hidden');
});
$('modalCloseBtn').addEventListener('click', () => $('projectModal').classList.add('hidden'));
$('projectModal').addEventListener('click', e => { if (e.target === $('projectModal')) $('projectModal').classList.add('hidden'); });
$('saveNewBtn').addEventListener('click', () => {
  const name = $('saveNameInput').value.trim() || `프로젝트 ${getSaves().length+1}`;
  saveToSlot(name);
  $('saveNameInput').value = '';
  renderSaveModal();
});


// ─── 버튼 이벤트 ──────────────────────────
$('undoBtn').addEventListener('click', undo);
$('redoBtn').addEventListener('click', redo);
$('metroBtn').addEventListener('click', () => {
  S.metronome = !S.metronome;
  $('metroBtn').classList.toggle('active', S.metronome);
});
$('humanizeBtn').addEventListener('click', () => {
  S.humanize = !S.humanize;
  $('humanizeBtn').classList.toggle('active', S.humanize);
});
$('swingSlider').addEventListener('input', e => {
  S.swing = parseInt(e.target.value) / 100;
  Tone.Transport.swing = S.swing;
  $('swingVal').textContent = e.target.value + '%';
});
$('chordPreviewPlay').addEventListener('click', () => {
  S.builderMode = 'chord'; previewBuilderSound();
});
$('melPreviewPlay').addEventListener('click', () => {
  S.builderMode = 'melody'; previewBuilderSound();
});

// ─── DRUM EDITOR MODAL ───────────────────
$('drumEditClose').addEventListener('click', () => $('drumEditorModal').classList.add('hidden'));

// ─── 햄버거 메뉴 토글 ─────────────────────
$('menuBtn').addEventListener('click', () => {
  const panel = $('menuPanel');
  const backdrop = $('menuBackdrop');
  const isOpen = !panel.classList.contains('hidden');
  panel.classList.toggle('hidden', isOpen);
  backdrop.classList.toggle('hidden', isOpen);
});
$('menuBackdrop').addEventListener('click', () => {
  $('menuPanel').classList.add('hidden');
  $('menuBackdrop').classList.add('hidden');
});

// ─── 빌더 접기/펼치기 ─────────────────────
$('builderToggleBtn').addEventListener('click', () => {
  const wrap = document.querySelector('.builder-wrap');
  const collapsed = wrap.classList.toggle('collapsed');
  $('builderToggleBtn').textContent = collapsed ? '▼' : '▲';
});
$('drumEditorModal').addEventListener('click', e => { if(e.target===$('drumEditorModal')) $('drumEditorModal').classList.add('hidden'); });

// ─── CAMERA MODE ──────────────────────────
let _camStream = null, _wakeLock = null;

function updateCamChord(visual) {
  const chordEl = $('camChord');
  const barEl   = $('camBarLbl');
  if (!chordEl) return;
  const t = S.tracks.find(tr => tr.type === 'chord' && !tr.muted) || S.tracks.find(tr => tr.type === 'chord');
  if (visual === undefined) {
    // 재생 전: 첫 코드 표시
    const first = t?.bars?.find(b => b);
    chordEl.textContent = first?.label || '—';
    if (barEl) barEl.textContent = '';
    return;
  }
  const item = t?.bars?.[visual];
  chordEl.textContent = item?.label || '—';
  if (barEl) barEl.textContent = item ? `마디 ${visual + 1}` : '';
}

async function startCameraMode() {
  try {
    _camStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: false });
    $('camVideo').srcObject = _camStream;
    $('camOverlay').classList.remove('hidden');
    if ('wakeLock' in navigator) {
      try { _wakeLock = await navigator.wakeLock.request('screen'); } catch(e) {}
    }
    updateCamChord();
  } catch(e) {
    alert('카메라 권한이 필요해요.\n' + e.message);
  }
}

function exitCameraMode() {
  if (_camStream) { _camStream.getTracks().forEach(t => t.stop()); _camStream = null; }
  if (_wakeLock)  { try { _wakeLock.release(); } catch(e) {} _wakeLock = null; }
  $('camVideo').srcObject = null;
  $('camOverlay').classList.add('hidden');
}

$('camBtn').addEventListener('click', startCameraMode);
$('camExitBtn').addEventListener('click', exitCameraMode);
$('camPlayBtn').addEventListener('click', () => {
  if (S.isPlaying) {
    stopPlay();
    $('camPlayBtn').textContent = '▶ 재생';
    $('camPlayBtn').classList.remove('playing');
    updateCamChord();
  } else {
    startPlay();
    $('camPlayBtn').textContent = '⏹ 정지';
    $('camPlayBtn').classList.add('playing');
  }
});

// ─── THEME TOGGLE ─────────────────────────
(function() {
  const btn = $('themeBtn');
  const apply = dark => {
    document.body.classList.toggle('dark', dark);
    btn.textContent = dark ? '☀️ 라이트모드' : '🌙 다크모드';
  };
  apply(localStorage.getItem('theme') === 'dark');
  btn.addEventListener('click', () => {
    const isDark = !document.body.classList.contains('dark');
    localStorage.setItem('theme', isDark ? 'dark' : 'light');
    apply(isDark);
  });
})();

// ─── INIT ─────────────────────────────────
createTrack('chord');
updatePreviews();
renderAll();
