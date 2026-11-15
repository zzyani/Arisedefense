/* ==================================================================
 * 배경 음악 (BGM) — 음악 파일 없이 Web Audio로 실시간 연주하는 자체 작곡 7곡
 *  title : 타이틀·챕터 선택 (D단조 66BPM, 어둡고 신비로운 종소리·합창)
 *  ch1   : 카르테논 신전 (A단조 78BPM, 고대 신전: 합창·하프·플루트·태고)
 *  ch2   : 설원 숲 (E단조 88BPM, 첼레스타·글로켄·부드러운 현·바람)
 *  ch3   : 오크 주둔지 (C단조 100BPM, 전쟁 북·낮은 금관 반복·뿔나팔)
 *  ch4   : 악마성 (D화성단조 104BPM, 오르간·하프시코드·종·합창)
 *  ch5   : 개미굴 (F#단조 116BPM, 박동하는 저음·벌레 소리·불협 현)
 *  ch6   : 카르테논 신전 최종전 (ch1과 같은 화음·선율을 120BPM으로, 금관·현 반복·합창·북을 더해 웅장하게)
 *
 * 사용: Bgm.update(곡 이름, 일시정지 여부)를 매 프레임 호출 → 곡이 바뀌면 1.2초 동안 교차 페이드.
 * 브라우저 정책상 첫 클릭·키 입력 뒤에 소리가 남. M 키·BGM 버튼으로 켜고 끔(이 브라우저에 저장).
 * 효과음: Bgm.sfx(이름) — 효과음 리스트 36종(보스 7종은 보스 구현 때). BGM과 따로 켜고 끔(N 키·효과음 버튼)
 * 나중에 실제 음악 파일로 바꾸려면 TRACKS 대신 <audio>를 재생하도록 play()만 바꾸면 됨.
 * ================================================================== */
const Bgm = (() => {
  const PREF_KEY = 'arise-defense-bgm';   // 'off'면 꺼짐
  const SFX_PREF_KEY = 'arise-defense-sfx';   // 효과음 켜기/끄기 (BGM과 따로 저장)
  const VOLUME = 0.5;                     // 전체 음량
  const DUCK = 0.35;                      // 일시정지 중 음량 비율
  const FADE = 1.2;                       // 곡 전환 페이드(초)
  const SFX_VOLUME = 0.5;                 // 버튼 효과음 음량 (BGM 켜기/끄기와 상관없음)

  let ctx = null, master = null, reverb = null, noiseBuf = null, timer = null, sfxOut = null, sfxRev = null;
  let sfxOn = true, silenced = false, duckUntil = 0;   // 효과음 켜짐 · 패배 때 BGM 끔 · 경보 때 잠깐 낮춤
  const recent = {}; let voices = [];                 // 같은 소리 0.06초 제한 · 동시 6개 제한
  let enabled = true, unlocked = false, wanted = null, paused = false;
  let cur = null;   // 지금 곡 { name, track, dry, wet, barIdx, nextBar }
  try { enabled = localStorage.getItem(PREF_KEY) !== 'off'; } catch (e) { /* 저장소 막힘: 켜짐 */ }
  try { sfxOn = localStorage.getItem(SFX_PREF_KEY) !== 'off'; } catch (e) { /* 저장소 막힘: 켜짐 */ }

  /* ---------- 기본 도구 ---------- */
  const NAMES = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  function N(x) {   // 'A3', 'C#4', 'Bb2' 또는 숫자(MIDI) → MIDI 번호
    if (typeof x === 'number') return x;
    const m = /^([A-G])([#b]?)(-?\d)$/.exec(x);
    return 12 * (+m[3] + 1) + NAMES[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
  }
  const hz = (m) => 440 * Math.pow(2, (N(m) - 69) / 12);

  function makeImpulse(sec, decay) {   // 잔향: 점점 사라지는 잡음
    const len = Math.floor(ctx.sampleRate * sec), buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
    return buf;
  }

  // 출력 연결: 전체 음량 → 압축기 → 스피커, 잔향은 전체 음량으로 (실시간·미리 렌더 공용)
  function buildGraph(c, dest) {
    ctx = c;
    master = ctx.createGain();
    master.gain.value = 0;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16; comp.knee.value = 12; comp.ratio.value = 3.5;
    comp.attack.value = 0.01; comp.release.value = 0.25;
    master.connect(comp); comp.connect(dest);
    reverb = ctx.createConvolver();
    reverb.buffer = makeImpulse(3.2, 2.4);
    const rv = ctx.createGain(); rv.gain.value = 0.8;
    reverb.connect(rv); rv.connect(master);
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const nd = noiseBuf.getChannelData(0);
    for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
  }

  function init() {
    if (ctx) return true;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    const c = new AC();
    buildGraph(c, c.destination);
    // 효과음 출력: 배경 음악과 따로 (BGM을 꺼도 들림). 짧은 디지털 메아리를 더해 시스템 창 느낌으로
    sfxOut = ctx.createGain(); sfxOut.gain.value = SFX_VOLUME;
    const echo = ctx.createDelay(0.3), fb = ctx.createGain(), wetE = ctx.createGain();
    echo.delayTime.value = 0.075; fb.gain.value = 0.28; wetE.gain.value = 0.32;
    sfxOut.connect(ctx.destination); sfxOut.connect(echo); echo.connect(fb); fb.connect(echo); echo.connect(wetE); wetE.connect(ctx.destination);
    sfxRev = ctx.createConvolver(); sfxRev.buffer = makeImpulse(2.4, 2.6);   // 큰 소리(일어나라·승리 등)용 잔향
    const rg = ctx.createGain(); rg.gain.value = SFX_VOLUME * 0.7; sfxRev.connect(rg); rg.connect(ctx.destination);
    timer = setInterval(tick, 60);
    return true;
  }

  /* ---------- 효과음 ---------- */
  // 모든 효과음은 sfxOut(짧은 디지털 메아리)로, rev>0이면 sfxRev(잔향)에도 보냄
  function sfxDest(node, rev) {
    node.connect(sfxOut);
    if (rev > 0) { const s2 = ctx.createGain(); s2.gain.value = rev; node.connect(s2); s2.connect(sfxRev); }
  }
  // 사각파 '삑' 하나: f0에서 f1로 짧게 미끄러짐 (시스템 창 전자음)
  function blip(t, f0, f1, dur, v, type = 'square') {
    const o = ctx.createOscillator(); o.type = type;
    o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    const lp = filt('lowpass', 5200, 0.7), g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(v, t + 0.004);
    g.gain.setValueAtTime(v, t + dur * 0.6); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(lp); lp.connect(g); g.connect(sfxOut); o.start(t); o.stop(t + dur + 0.02);
  }
  function shimmer(t, f, dur, v, rev = 0) {   // 맑은 사인 여운
    const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = f;
    const g = ctx.createGain(); g.gain.setValueAtTime(v, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); sfxDest(g, rev); o.start(t); o.stop(t + dur + 0.02);
  }
  // 음 하나: 파형·음높이 미끄럼·저역 통과·잔향
  function tone(t, type, f0, f1, dur, v, o = {}) {
    const os = ctx.createOscillator(); os.type = type;
    os.frequency.setValueAtTime(f0, t); os.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    const lp = filt('lowpass', o.lp ?? 6000, 0.7), g = ctx.createGain(), a = o.attack ?? 0.005;
    g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(v, t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    os.connect(lp); lp.connect(g); sfxDest(g, o.rev ?? 0); os.start(t); os.stop(t + dur + 0.05);
  }
  // 잡음 한 번: 필터 종류·주파수가 f0→f1로 움직임
  function nz(t, dur, v, o = {}) {
    const src = noise(t, t + dur), f = filt(o.type || 'bandpass', o.f0 ?? 1200, o.q ?? 1);
    f.frequency.setValueAtTime(o.f0 ?? 1200, t);
    if (o.f1) f.frequency.exponentialRampToValueAtTime(o.f1, t + dur);
    const g = ctx.createGain(), a = o.attack ?? 0.003;
    g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(v, t + a);
    if (o.hold) g.gain.setValueAtTime(v, t + o.hold);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f); f.connect(g); sfxDest(g, o.rev ?? 0);
  }
  function fmBell(t, f, dur, v, ratio = 3.5, index = 2, rev = 0.3) {
    const car = ctx.createOscillator(), mod = ctx.createOscillator(); car.type = mod.type = 'sine';
    car.frequency.value = f; mod.frequency.value = f * ratio;
    const mg = ctx.createGain(); mg.gain.setValueAtTime(f * index, t); mg.gain.exponentialRampToValueAtTime(f * 0.05, t + dur * 0.6);
    mod.connect(mg); mg.connect(car.frequency);
    const g = ctx.createGain(); g.gain.setValueAtTime(v, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    car.connect(g); sfxDest(g, rev); car.start(t); mod.start(t); car.stop(t + dur + 0.05); mod.stop(t + dur + 0.05);
  }
  function padChord(t, freqs, dur, v, o = {}) {   // 톱니파 화음 (합창·현 느낌), 음높이가 bend배로 미끄러질 수 있음
    const lp = filt('lowpass', o.lp ?? 1800, 0.7), g = ctx.createGain(), a = o.attack ?? 0.05;
    g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(v, t + a);
    g.gain.setValueAtTime(v, t + dur * 0.5); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    lp.connect(g); sfxDest(g, o.rev ?? 0.5);
    for (const f of freqs) for (const dt of [-8, 8]) {
      const os = ctx.createOscillator(); os.type = 'sawtooth'; os.detune.value = dt;
      os.frequency.setValueAtTime(f, t); if (o.bend) os.frequency.exponentialRampToValueAtTime(f * o.bend, t + dur);
      os.connect(lp); os.start(t); os.stop(t + dur + 0.05);
    }
  }
  const midiHz = (m) => 440 * Math.pow(2, (m - 69) / 12);
  // 챕터 곡의 으뜸음 (일어나라 화음을 같은 조성으로)
  const TRACK_ROOT = { title: 50, ch1: 57, ch2: 52, ch3: 48, ch4: 50, ch5: 54, ch6: 57 };

  // 효과음 목록. p = 우선순위(0 높음, 2 낮음) · o.pitch = 음높이 배율 · o.dark = 고역을 깎음 (추출 그림자용)
  const SFX = {
    // ---- UI·시스템 ----
    confirm: { p: 0, f(t) { blip(t, 1046, 1060, 0.05, 0.13); blip(t + 0.055, 1568, 1580, 0.09, 0.13); shimmer(t + 0.055, 3136, 0.35, 0.05); } },   // U01
    back:    { p: 0, f(t) { blip(t, 988, 659, 0.07, 0.12); } },                                             // U02
    warn:    { p: 0, f(t) { blip(t, 523, 523, 0.06, 0.12); blip(t + 0.09, 523, 494, 0.07, 0.12); } },       // U03
    select:  { p: 0, f(t) { tone(t, 'sine', 1760, 1760, 0.06, 0.11); } },                                   // U04 카드 선택
    panel:   { p: 2, f(t) { tone(t, 'sine', 880, 900, 0.1, 0.08, { attack: 0.012 }); } },                   // U05 상세 패널
    pause:   { p: 1, f(t) { blip(t, 880, 880, 0.05, 0.11); blip(t + 0.065, 587, 587, 0.045, 0.11); } },     // U06 일시정지 (끝을 짧게)
    resume:  { p: 1, f(t) { blip(t, 587, 587, 0.05, 0.11); blip(t + 0.065, 880, 880, 0.07, 0.11); } },     // U07 전투 재개
    // ---- 게임 흐름 ----
    waveClear: { p: 0, f(t) { [1046, 1318, 1568].forEach((f, i) => fmBell(t + i * 0.09, f, 0.7, 0.12, 4, 1.2, 0.4)); shimmer(t + 0.18, 3136, 0.6, 0.04, 0.4); } },   // F02
    victory: { p: 0, f(t) {   // F03: F02를 길게 + 합창 화음
      [523, 659, 784, 1046, 1318].forEach((f, i) => fmBell(t + i * 0.12, f, 1.1, 0.12, 4, 1.2, 0.5));
      padChord(t + 0.45, [523, 659, 784], 1.7, 0.05, { attack: 0.4, lp: 2400, rev: 0.8 });
      shimmer(t + 0.6, 2093, 1.2, 0.04, 0.6);
    } },
    defeat: { p: 0, f(t) {    // F04: 내려가는 단조 화음 + 낮은 울림
      padChord(t, [294, 349, 440], 1.9, 0.06, { attack: 0.03, bend: 0.84, lp: 1400, rev: 0.7 });
      tone(t, 'sine', 70, 40, 2.0, 0.22, { rev: 0.5 });
      nz(t, 1.2, 0.05, { type: 'lowpass', f0: 600, f1: 120, rev: 0.6 });
    } },
    cardUnlock: { p: 1, f(t) {   // F05: 반짝이는 글로켄 + 낮은 그림자 울림
      [2093, 2637, 3136, 4186].forEach((f, i) => fmBell(t + i * 0.07, f, 0.9, 0.07, 3.5, 1, 0.6));
      tone(t, 'sine', 65, 55, 1.4, 0.14, { attack: 0.25, rev: 0.6 });
      nz(t, 1.0, 0.04, { type: 'lowpass', f0: 300, f1: 900, attack: 0.3, rev: 0.5 });
    } },
    // ---- 그림자 군단 ----
    summon:  { p: 0, f(t) { nz(t, 0.3, 0.12, { type: 'lowpass', f0: 180, f1: 2200, attack: 0.15, rev: 0.3 }); tone(t + 0.18, 'sine', 130, 48, 0.25, 0.22); } },   // A01
    recall:  { p: 0, f(t) { nz(t, 0.3, 0.12, { type: 'lowpass', f0: 2200, f1: 150, rev: 0.2 }); tone(t, 'sine', 70, 140, 0.18, 0.1); } },                       // A02
    dismantle: { p: 0, f(t) { nz(t, 0.4, 0.25, { f0: 1500, f1: 500, q: 0.7, rev: 0.3 }); blip(t + 0.12, 1975, 1975, 0.05, 0.08); blip(t + 0.18, 2637, 2637, 0.09, 0.08); } },   // A03
    remnant: { p: 0, f(t) { tone(t, 'sine', 233, 175, 0.3, 0.06, { lp: 900, rev: 0.4 }); fmBell(t, 466, 0.4, 0.02, 1.5, 1.5, 0.4); } },   // A04 (작게)
    remnantGone: { p: 1, f(t) { tone(t, 'sine', 330, 110, 0.45, 0.09, { lp: 800, rev: 0.3 }); } },   // A05
    arise: { p: 0, f(t, o) {   // A06 "일어나라": 낮은 드론이 0.3초 솟구치다 터지는 화음 + 합창, 강한 잔향
      const r = midiHz((TRACK_ROOT[o.track] ?? 50) - 12);   // 으뜸음 (낮은 옥타브)
      const lp = filt('lowpass', 200, 2), g = ctx.createGain();
      lp.frequency.setValueAtTime(200, t); lp.frequency.exponentialRampToValueAtTime(3200, t + 0.3);
      g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(0.12, t + 0.3); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.55);
      lp.connect(g); sfxDest(g, 0.4);
      for (const f of [r, r * 1.5]) { const os = ctx.createOscillator(); os.type = 'sawtooth'; os.frequency.setValueAtTime(f, t); os.frequency.exponentialRampToValueAtTime(f * 2, t + 0.3); os.connect(lp); os.start(t); os.stop(t + 0.6); }
      nz(t, 0.32, 0.06, { type: 'bandpass', f0: 300, f1: 3000, attack: 0.28, q: 0.8 });
      const b = t + 0.3;   // 터지는 순간
      padChord(b, [r * 2, r * 2 * 1.189, r * 3, r * 4, r * 4 * 1.189], 1.8, 0.06, { attack: 0.01, lp: 3000, rev: 1 });   // 단조 화음
      tone(b, 'sine', 110, 38, 0.9, 0.3, { rev: 0.6 });
      nz(b, 0.5, 0.08, { type: 'lowpass', f0: 4000, f1: 300, rev: 0.8 });
      fmBell(b, r * 8, 1.6, 0.05, 3.5, 1.5, 0.9);
    } },
    shadowDie: { p: 1, f(t) { nz(t, 0.5, 0.2, { f0: 900, f1: 250, q: 0.6, rev: 0.3 }); tone(t, 'sine', 440, 150, 0.4, 0.06); } },   // A07
    // ---- 그림자 공격 ----
    slam:    { p: 1, f(t) { tone(t, 'sine', 95, 38, 0.28, 0.14); nz(t, 0.07, 0.06, { type: 'highpass', f0: 3000 }); nz(t, 0.12, 0.04, { f0: 2400, q: 8 }); } },   // S01
    slash:   { p: 1, f(t) { nz(t, 0.13, 0.5, { f0: 1800, f1: 6500, q: 2 }); } },                                   // S02
    bearclaw: { p: 1, f(t) { nz(t, 0.08, 0.35, { f0: 1200, q: 1.2 }); nz(t + 0.09, 0.08, 0.35, { f0: 1000, q: 1.2 }); tone(t, 'sawtooth', 75, 60, 0.28, 0.05, { lp: 320 }); } },   // S03
    orb:     { p: 1, f(t) { tone(t, 'sine', 500, 1400, 0.22, 0.12, { attack: 0.02, rev: 0.2 }); } },               // S04 발사
    orbHit:  { p: 2, f(t) { nz(t, 0.25, 0.1, { type: 'lowpass', f0: 1400, f1: 200, rev: 0.5 }); tone(t, 'sine', 170, 60, 0.22, 0.12); } },   // S05 착탄
    breath:  { p: 1, f(t) {   // S06: 0.5초 바람, 필터가 열렸다 닫힘
      const src = noise(t, t + 0.6), f = filt('bandpass', 400, 0.9), g = ctx.createGain();
      f.frequency.setValueAtTime(400, t); f.frequency.exponentialRampToValueAtTime(1800, t + 0.25); f.frequency.exponentialRampToValueAtTime(500, t + 0.55);
      g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(0.22, t + 0.1); g.gain.setValueAtTime(0.22, t + 0.35); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.58);
      src.connect(f); f.connect(g); sfxDest(g, 0.3);
    } },
    berclaw: { p: 1, f(t) { nz(t, 0.035, 0.05, { type: 'highpass', f0: 5000 }); } },                           // S07 (가장 작게)
    // ---- 적 (o.pitch·o.dark: 추출 그림자가 쓰면 한 음 낮고 어둡게) ----
    spawn:   { p: 2, f(t) { nz(t, 0.22, 0.08, { f0: 700, q: 1.5, rev: 0.5 }); tone(t, 'sine', 90, 60, 0.2, 0.04, { rev: 0.4 }); } },   // E01 (멀리서)
    eClaw:   { p: 1, f(t, o) { nz(t, 0.07, 0.4, { f0: 1100 * o.pitch, q: 1.5, ...(o.dark ? { type: 'lowpass', f0: 900 * o.pitch } : {}) }); } },   // E02
    eSlash:  { p: 1, f(t, o) { nz(t, 0.12, 0.35, { f0: 900 * o.pitch, f1: (o.dark ? 1600 : 2500) * o.pitch, q: 2 }); } },   // E03
    eSlam:   { p: 1, f(t, o) { tone(t, 'sine', 80 * o.pitch, 38, 0.22, 0.1); nz(t, 0.22, 0.06, { type: 'lowpass', f0: (o.dark ? 900 : 1500) * o.pitch, f1: 300 }); } },   // E04
    eShotMagic: { p: 1, f(t, o) { tone(t, 'sine', 900 * o.pitch, 1600 * o.pitch, 0.15, 0.09, { lp: o.dark ? 1800 : 6000 }); } },   // E05 마법 계열
    eShotPhys:  { p: 1, f(t, o) { nz(t, 0.12, 0.35, { f0: 2000 * o.pitch, f1: (o.dark ? 2400 : 3500) * o.pitch, q: 3 }); } },    // E05 물리 계열
    eBlast:  { p: 1, f(t, o) { nz(t, 0.42, 0.08, { type: 'lowpass', f0: (o.dark ? 1800 : 3000) * o.pitch, f1: 300, rev: 0.3 }); tone(t, 'sine', 72 * o.pitch, 45, 0.32, 0.07); } },   // E06
    eStab:   { p: 2, f(t, o) { nz(t, 0.045, 0.06, { type: o.dark ? 'bandpass' : 'highpass', f0: 2600 * o.pitch, q: 1 }); tone(t, 'square', 1200 * o.pitch, 900, 0.02, 0.02); } },   // E07
    eHit:    { p: 1, f(t) { nz(t, 0.05, 0.035, { type: 'lowpass', f0: 900 }); tone(t, 'sine', 150, 90, 0.05, 0.035); } },   // E08 (매우 작게)
    eDie:    { p: 0, f(t) { nz(t, 0.3, 0.2, { f0: 1500, f1: 320, q: 1.2 }); blip(t + 0.08, 1318, 1760, 0.06, 0.05, 'sine'); } },   // E09 + 에너지 획득음
    // ---- 거점 ----
    coreHit: { p: 0, f(t) { fmBell(t, 2400, 0.18, 0.06, 2.7, 3, 0.2); nz(t, 0.05, 0.05, { type: 'highpass', f0: 4200 }); tone(t, 'sine', 72, 50, 0.32, 0.12); } },   // C01
    coreDanger: { p: 0, f(t) { for (let i = 0; i < 2; i++) { blip(t + i * 0.42, 988, 988, 0.18, 0.14); blip(t + i * 0.42 + 0.2, 740, 740, 0.18, 0.14); } } },   // C02 (높은 음-낮은 음 2회)
  };
  // 확인용: 효과음 하나를 소리 없이 렌더해 AudioBuffer로 돌려줌 (음량 맞추기용)
  async function renderSfxOffline(name, opts = {}, sec = 2.5) {
    const saved = [ctx, sfxOut, sfxRev, noiseBuf];
    const off = new OfflineAudioContext(2, Math.ceil(44100 * sec), 44100);
    ctx = off;
    noiseBuf = off.createBuffer(1, 44100 * 2, 44100);
    const nd = noiseBuf.getChannelData(0); for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
    sfxOut = off.createGain(); sfxOut.gain.value = SFX_VOLUME; sfxOut.connect(off.destination);
    sfxRev = off.createConvolver(); sfxRev.buffer = makeImpulse(2.4, 2.6);
    const rg = off.createGain(); rg.gain.value = SFX_VOLUME * 0.7; sfxRev.connect(rg); rg.connect(off.destination);
    SFX[name].f(0.01, { pitch: 1, dark: false, ...opts });
    [ctx, sfxOut, sfxRev, noiseBuf] = saved;
    return off.startRendering();
  }

  // 확인용: 곡 하나를 sec초 동안 소리 없이 렌더해 AudioBuffer로 돌려줌 (음량 맞추기·미리 듣기 파일용)
  async function renderOffline(name, sec = 20) {
    const saved = [ctx, master, reverb, noiseBuf];
    const off = new OfflineAudioContext(2, Math.ceil(44100 * sec), 44100);
    buildGraph(off, off.destination);
    master.gain.value = VOLUME;
    const track = TRACKS[name], spb = 60 / track.bpm, dry = off.createGain(), wet = off.createGain();
    dry.gain.value = wet.gain.value = track.gain ?? 1;
    dry.connect(master); wet.connect(reverb);
    for (let b = 0, t = 0.05; t < sec; b++, t += spb * track.beats) track.bar(b % track.bars, player({ dry, wet }, t, spb));
    [ctx, master, reverb, noiseBuf] = saved;
    return off.startRendering();
  }

  // 소리 하나를 곡의 출력(dry)과 잔향(wet)에 연결
  function out(bus, node, wet) {
    node.connect(bus.dry);
    if (wet > 0) { const s = ctx.createGain(); s.gain.value = wet; node.connect(s); s.connect(bus.wet); }
  }
  function osc(type, f, t, end) {
    const o = ctx.createOscillator(); o.type = type; o.frequency.setValueAtTime(f, t);
    o.start(t); o.stop(end + 0.05); return o;
  }
  function noise(t, end) {
    const s = ctx.createBufferSource(); s.buffer = noiseBuf; s.loop = true;
    s.start(t, Math.random() * 1.5); s.stop(end + 0.05); return s;
  }
  function gainEnv(t, a, d, peak, rel) {   // 올라가서(a) d초 유지 후 rel초 동안 사라짐
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(peak, t + a);
    g.gain.setValueAtTime(peak, t + Math.max(a, d));
    g.gain.exponentialRampToValueAtTime(0.0001, t + Math.max(a, d) + rel);
    return g;
  }
  function hitEnv(t, peak, decay) {        // 바로 터지고 사라짐 (타악·뜯는 소리)
    const g = ctx.createGain();
    g.gain.setValueAtTime(peak, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
    return g;
  }
  function filt(type, f, q) { const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; if (q) b.Q.value = q; return b; }

  /* ---------- 악기 ---------- */
  const INST = {
    // 현·신스 패드: 톱니파 2개를 살짝 어긋나게 → 저역 통과
    pad(bus, t, d, notes, v, o = {}) {
      const a = o.attack ?? 0.6, rel = o.release ?? 1.2, end = t + d + rel;
      const lp = filt('lowpass', o.bright ?? 1100, 0.7);
      const g = gainEnv(t, a, d, 0.05 * v, rel);
      lp.connect(g); out(bus, g, o.wet ?? 0.5);
      for (const n of notes) for (const dt of [-(o.detune ?? 7), o.detune ?? 7]) {
        const s = osc(o.type || 'sawtooth', hz(n), t, end); s.detune.value = dt; s.connect(lp);
      }
    },
    // 합창 '아': 톱니파 + 떨림 → 모음 공명 두 곳
    choir(bus, t, d, notes, v, o = {}) {
      const a = o.attack ?? 0.8, rel = o.release ?? 1.4, end = t + d + rel;
      const g = gainEnv(t, a, d, 0.07 * v, rel);
      const f1 = filt('bandpass', o.f1 ?? 750, 5), f2 = filt('bandpass', o.f2 ?? 1150, 7), lp = filt('lowpass', 2600);
      const mix = ctx.createGain(); mix.gain.value = 1;
      f1.connect(mix); f2.connect(mix); lp.connect(mix); mix.connect(g); out(bus, g, o.wet ?? 0.7);
      const lp2 = ctx.createGain(); lp2.gain.value = 0.25; lp2.connect(lp);
      const lfo = osc('sine', 5.2, t, end), lg = ctx.createGain(); lg.gain.value = 9; lfo.connect(lg);
      for (const n of notes) for (const dt of [-6, 6]) {
        const s = osc('sawtooth', hz(n), t, end); s.detune.value = dt; lg.connect(s.detune);
        s.connect(f1); s.connect(f2); s.connect(lp2);
      }
    },
    // 오르간: 사인 배음 쌓기
    organ(bus, t, d, notes, v, o = {}) {
      const rel = o.release ?? 0.3, end = t + d + rel;
      const g = gainEnv(t, 0.04, d, 0.035 * v, rel); out(bus, g, o.wet ?? 0.6);
      for (const n of notes) [[1, 1], [2, 0.55], [3, 0.3], [4, 0.22], [6, 0.1]].forEach(([h, a]) => {
        const s = osc('sine', hz(n) * h, t, end), sg = ctx.createGain(); sg.gain.value = a; s.connect(sg); sg.connect(g);
      });
    },
    // 뜯는 소리(하프·하프시코드·피치카토): 필터가 닫히며 사라짐
    pluck(bus, t, n, v, o = {}) {
      const dec = o.decay ?? 0.9, end = t + dec;
      const lp = filt('lowpass', o.cutoff ?? 3000, 1);
      lp.frequency.setValueAtTime(o.cutoff ?? 3000, t);
      lp.frequency.exponentialRampToValueAtTime(o.floor ?? 400, t + dec);
      const g = hitEnv(t, 0.12 * v, dec); lp.connect(g); out(bus, g, o.wet ?? 0.45);
      const s = osc(o.type || 'triangle', hz(n), t, end); s.connect(lp);
      if (o.type2) { const s2 = osc(o.type2, hz(n) * 2, t, end), g2 = ctx.createGain(); g2.gain.value = 0.3; s2.connect(g2); g2.connect(lp); }
    },
    // 종·첼레스타: FM (변조파가 빨리 사그라들어 맑은 울림)
    bell(bus, t, n, v, o = {}) {
      const dec = o.decay ?? 2.2, end = t + dec, f = hz(n);
      const car = osc('sine', f, t, end), mod = osc('sine', f * (o.ratio ?? 3.5), t, end);
      const mg = ctx.createGain(); mg.gain.setValueAtTime(f * (o.index ?? 2.2), t); mg.gain.exponentialRampToValueAtTime(f * 0.05, t + dec * 0.6);
      mod.connect(mg); mg.connect(car.frequency);
      const g = hitEnv(t, 0.1 * v, dec); car.connect(g); out(bus, g, o.wet ?? 0.6);
    },
    // 플루트·리드: 부드러운 시작, 조금 뒤 떨림
    lead(bus, t, d, n, v, o = {}) {
      const rel = o.release ?? 0.25, end = t + d + rel;
      const g = gainEnv(t, o.attack ?? 0.07, d, 0.07 * v, rel);
      const lp = filt('lowpass', o.bright ?? 2600, 0.8); lp.connect(g); out(bus, g, o.wet ?? 0.55);
      const s = osc(o.type || 'triangle', hz(n), t, end); s.connect(lp);
      const s2 = osc('sine', hz(n) * 2, t, end), g2 = ctx.createGain(); g2.gain.value = 0.18; s2.connect(g2); g2.connect(lp);
      const lfo = osc('sine', o.vibRate ?? 5, t, end), lg = ctx.createGain();
      lg.gain.setValueAtTime(0, t); lg.gain.linearRampToValueAtTime(o.vib ?? 12, t + Math.min(0.35, d));
      lfo.connect(lg); lg.connect(s.detune); lg.connect(s2.detune);
    },
    // 금관: 필터가 열리며 '빠-' 하고 들어옴
    brass(bus, t, d, notes, v, o = {}) {
      const rel = o.release ?? 0.25, end = t + d + rel;
      const lp = filt('lowpass', 300, 1.5);
      lp.frequency.setValueAtTime(300, t);
      lp.frequency.linearRampToValueAtTime(o.bright ?? 2200, t + 0.07);
      lp.frequency.linearRampToValueAtTime((o.bright ?? 2200) * 0.6, t + 0.3);
      const g = gainEnv(t, 0.04, d, 0.045 * v, rel); lp.connect(g); out(bus, g, o.wet ?? 0.45);
      for (const n of [].concat(notes)) for (const dt of [-8, 8]) { const s = osc('sawtooth', hz(n), t, end); s.detune.value = dt; s.connect(lp); }
    },
    // 저음
    bass(bus, t, d, n, v, o = {}) {
      const rel = o.release ?? 0.2, end = t + d + rel;
      const lp = filt('lowpass', o.bright ?? 500, 1); const g = gainEnv(t, 0.012, d, 0.16 * v, rel);
      lp.connect(g); out(bus, g, o.wet ?? 0.12);
      osc(o.type || 'triangle', hz(n), t, end).connect(lp);
      const sub = osc('sine', hz(n), t, end), sg = ctx.createGain(); sg.gain.value = 0.6; sub.connect(sg); sg.connect(g);
    },
    // 현 짧게 끊어 켜기 (반복 음형)
    str(bus, t, d, n, v, o = {}) {
      const end = t + d + 0.1;
      const lp = filt('lowpass', o.bright ?? 2200, 0.8); const g = gainEnv(t, 0.012, d * 0.7, 0.07 * v, 0.09);
      lp.connect(g); out(bus, g, o.wet ?? 0.35);
      osc('sawtooth', hz(n), t, end).connect(lp);
    },
    // 타악
    kick(bus, t, v) {
      const s = osc('sine', 150, t, t + 0.45); s.frequency.exponentialRampToValueAtTime(42, t + 0.14);
      const g = hitEnv(t, 0.5 * v, 0.42); s.connect(g); out(bus, g, 0.05);
    },
    taiko(bus, t, v, o = {}) {
      const f = o.pitch ?? 82;
      const s = osc('sine', f * 1.7, t, t + 0.9); s.frequency.exponentialRampToValueAtTime(f, t + 0.07);
      const g = hitEnv(t, 0.55 * v, o.decay ?? 0.75); s.connect(g); out(bus, g, o.wet ?? 0.35);
      const nz = noise(t, t + 0.2), lp = filt('lowpass', 900), ng = hitEnv(t, 0.25 * v, 0.14);
      nz.connect(lp); lp.connect(ng); out(bus, ng, 0.3);
    },
    snare(bus, t, v) {
      const nz = noise(t, t + 0.25), bp = filt('bandpass', 1900, 0.8), g = hitEnv(t, 0.22 * v, 0.2);
      nz.connect(bp); bp.connect(g); out(bus, g, 0.3);
      const s = osc('triangle', 185, t, t + 0.12), sg = hitEnv(t, 0.15 * v, 0.1); s.connect(sg); out(bus, sg, 0.2);
    },
    hat(bus, t, v, o = {}) {
      const dec = o.decay ?? 0.05, nz = noise(t, t + dec), hp = filt(o.band ? 'bandpass' : 'highpass', o.freq ?? 7500, o.band ? 6 : 0.7);
      const g = hitEnv(t, 0.12 * v, dec); nz.connect(hp); hp.connect(g); out(bus, g, o.wet ?? 0.15);
    },
    timp(bus, t, n, v) {
      const f = hz(n), s = osc('sine', f * 1.03, t, t + 1.6); s.frequency.exponentialRampToValueAtTime(f, t + 0.15);
      const g = hitEnv(t, 0.4 * v, 1.5); s.connect(g); out(bus, g, 0.45);
      const nz = noise(t, t + 0.1), lp = filt('lowpass', 600), ng = hitEnv(t, 0.15 * v, 0.08); nz.connect(lp); lp.connect(ng); out(bus, ng, 0.3);
    },
    // 바람: 잡음이 대역 통과 필터를 오가며 부풀었다 잦아듦
    wind(bus, t, d, v) {
      const end = t + d + 0.5, nz = noise(t, end), bp = filt('bandpass', 700, 1.2);
      bp.frequency.setValueAtTime(500, t); bp.frequency.linearRampToValueAtTime(1300, t + d * 0.5); bp.frequency.linearRampToValueAtTime(600, t + d);
      const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(0.05 * v, t + d * 0.5); g.gain.linearRampToValueAtTime(0.0001, end);
      nz.connect(bp); bp.connect(g); out(bus, g, 0.6);
    },
  };

  /* ---------- 작곡 도우미 ---------- */
  // 한 마디를 연주하는 도구. at·len은 박자 단위
  function player(bus, t0, spb) {
    const T = (at) => t0 + at * spb;
    const P = {
      pad: (at, len, notes, v, o) => INST.pad(bus, T(at), len * spb, notes, v, o),
      choir: (at, len, notes, v, o) => INST.choir(bus, T(at), len * spb, notes, v, o),
      organ: (at, len, notes, v, o) => INST.organ(bus, T(at), len * spb, notes, v, o),
      pluck: (at, n, v, o) => INST.pluck(bus, T(at), n, v, o),
      harp: (at, n, v) => INST.pluck(bus, T(at), n, v, { decay: 1.4, cutoff: 2600, wet: 0.55 }),
      harpsi: (at, n, v) => INST.pluck(bus, T(at), n, v, { type: 'sawtooth', type2: 'square', decay: 0.45, cutoff: 4200, floor: 900, wet: 0.4 }),
      bell: (at, n, v, o) => INST.bell(bus, T(at), n, v, o),
      celesta: (at, n, v) => INST.bell(bus, T(at), n, v, { ratio: 4, index: 1.4, decay: 1.3, wet: 0.55 }),
      gong: (at, n, v) => INST.bell(bus, T(at), n, v, { ratio: 1.41, index: 3, decay: 4.5, wet: 0.8 }),
      lead: (at, len, n, v, o) => INST.lead(bus, T(at), len * spb, n, v, o),
      brass: (at, len, notes, v, o) => INST.brass(bus, T(at), len * spb, notes, v, o),
      bass: (at, len, n, v, o) => INST.bass(bus, T(at), len * spb, n, v, o),
      str: (at, len, n, v, o) => INST.str(bus, T(at), len * spb, n, v, o),
      kick: (at, v) => INST.kick(bus, T(at), v),
      taiko: (at, v, o) => INST.taiko(bus, T(at), v, o),
      snare: (at, v) => INST.snare(bus, T(at), v),
      hat: (at, v, o) => INST.hat(bus, T(at), v, o),
      timp: (at, n, v) => INST.timp(bus, T(at), n, v),
      wind: (at, len, v) => INST.wind(bus, T(at), len * spb, v),
      // 선율: 'A4:1.5 C5:.5 r:1' (음:박자, r은 쉼표)를 차례로 연주. inst는 lead·brass·celesta·bell
      melody(inst, at, text, v, o) {
        let b = at;
        for (const tok of text.trim().split(/\s+/)) {
          const [n, d] = tok.split(':'); const len = +d;
          if (n !== 'r') {
            if (inst === 'celesta' || inst === 'bell') P[inst](b, N(n) + ((o && o.shift) || 0), v);
            else P[inst](b, len * 0.95, inst === 'brass' ? [N(n) + ((o && o.shift) || 0)] : N(n) + ((o && o.shift) || 0), v, o);
          }
          b += len;
        }
      },
    };
    return P;
  }
  const up = (notes, k) => notes.map((n) => N(n) + k);   // 화음을 k반음 올림
  const tri = (s) => s.split(' ');                        // 'A2 C3 E3' → 화음

  /* ---------- 곡 ---------- */
  // 1·6챕터 공통 (A단조, 고대 신전): 화음·선율이 같고 6챕터는 빠르고 악기가 많음
  const TEMPLE_CHORDS = [tri('A2 C3 E3'), tri('Bb2 D3 F3'), tri('A2 C3 E3'), tri('G2 B2 D3'), tri('F2 A2 C3'), tri('E2 G#2 B2'), tri('D3 F3 A3'), tri('E2 G#2 B2')];
  const TEMPLE_ROOTS = ['A1', 'Bb1', 'A1', 'G1', 'F1', 'E1', 'D2', 'E1'];
  const TEMPLE_MELODY = [
    'A4:1.5 C5:.5 B4:1 A4:1', 'Bb4:2 A4:1 F4:1', 'E4:1.5 A4:.5 C5:1 E5:1', 'D5:2 B4:1 G4:1',
    'A4:1.5 C5:.5 F5:1 E5:1', 'D5:1 C5:1 B4:1 G#4:1', 'A4:1 F4:1 D5:1 C5:1', 'B4:3 r:1',
  ];
  const ARP8 = [0, 1, 2, 3, 4, 3, 2, 1];   // 8분음표 펼침화음 순서 (0~2 화음, 3·4 옥타브 위)
  const arpTones = (ch, k) => { const c = up(ch, k); return [c[0], c[1], c[2], c[0] + 12, c[1] + 12]; };
  const hash = (a, b) => { const x = Math.sin(a * 127.1 + b * 311.7) * 43758.5453; return x - Math.floor(x); };   // 같은 자리 = 같은 값 (매 반복 똑같이)

  const TRACKS = {
    title: {
      bpm: 66, beats: 4, bars: 8, gain: 1.15,
      bar(b, P) {
        const C = [tri('D3 F3 A3'), tri('Bb2 D3 F3'), tri('G2 Bb2 D3'), tri('A2 C#3 E3'), tri('D3 F3 A3'), tri('F2 A2 C3'), tri('C3 E3 G3'), tri('A2 C#3 E3')][b];
        const R = ['D2', 'Bb1', 'G1', 'A1', 'D2', 'F1', 'C2', 'A1'][b];
        P.pad(0, 4, up(C, 12), 0.75, { bright: 900, attack: 1.2, release: 2 });
        P.bass(0, 3.8, R, 0.45, { type: 'sine', release: 0.8 });
        const a = arpTones(C, 24);
        P.bell(0, a[0], 0.32); P.bell(1.5, a[2], 0.25); P.bell(3, a[1], 0.22);
        if (b === 0 || b === 4) P.timp(0, N(R) + 12, 0.45);
        if (b >= 4) {
          P.choir(0, 4, up(C, 12), 0.55, { attack: 1.2, release: 2 });
          P.melody('celesta', 0, ['D5:1.5 E5:.5 F5:1 A5:1', 'G5:2 F5:1 C5:1', 'E5:1.5 F5:.5 G5:1 E5:1', 'C#5:3 r:1'][b - 4], 0.5);
        }
      },
    },
    ch1: {
      bpm: 78, beats: 4, bars: 8, gain: 1.0,
      bar(b, P) {
        const C = TEMPLE_CHORDS[b], R = TEMPLE_ROOTS[b], a = arpTones(C, 12);
        P.choir(0, 4, up(C, 12), 0.6);
        P.bass(0, 3.8, R, 0.5, { type: 'sine', release: 0.6 });
        P.pad(0, 4, [N(R) + 12], 0.35, { bright: 500 });
        ARP8.forEach((k, i) => P.harp(i * 0.5, a[k], i % 4 === 0 ? 0.42 : 0.3));
        P.taiko(0, 0.75); P.taiko(2.5, 0.4);
        if (b === 7) { P.taiko(3, 0.5); P.taiko(3.5, 0.6); }
        if (b === 0) P.bell(0, 'A5', 0.3, { decay: 3 });
        P.melody('lead', 0, TEMPLE_MELODY[b], 0.6);
      },
    },
    ch6: {
      bpm: 120, beats: 4, bars: 8, gain: 0.9,
      bar(b, P) {
        const C = TEMPLE_CHORDS[b], R = TEMPLE_ROOTS[b], a = arpTones(C, 12), r = N(R);
        P.choir(0, 4, up(C, 12), 0.8);
        P.pad(0, 4, up(C, 24), 0.3, { bright: 1800 });
        P.bass(0, 1.9, r, 0.6); P.bass(2, 1.9, r, 0.55);
        for (let i = 0; i < 16; i++) P.str(i * 0.25, 0.22, [r + 24, r + 24, r + 31, r + 24, r + 36, r + 24, r + 31, r + 24][i % 8], i % 4 === 0 ? 0.55 : 0.38);   // 16분 현 반복 음형
        P.brass(0, 1.4, up(C, 12), 0.5); P.brass(2.5, 1.4, up(C, 12), 0.45);
        P.melody('brass', 0, TEMPLE_MELODY[b], 0.6, { bright: 2600 });
        P.melody('lead', 0, TEMPLE_MELODY[b], 0.4, { shift: 12 });
        // 북: 큰북·스네어·하이햇 + 태고
        P.kick(0, 0.8); P.kick(1.5, 0.5); P.kick(2, 0.75);
        P.snare(1, 0.6); P.snare(3, 0.65);
        for (let i = 0; i < 8; i++) P.hat(i * 0.5, i % 2 ? 0.5 : 0.3);
        P.taiko(0, 0.9); P.taiko(2.5, 0.6);
        P.timp(0, r + 12, 0.55);
        if (b === 0) P.gong(0, 'A2', 0.45);
        if (b === 7) for (let i = 0; i < 4; i++) P.taiko(3 + i * 0.25, 0.45 + i * 0.12);
      },
    },
    ch2: {
      bpm: 88, beats: 4, bars: 8, gain: 1.45,
      bar(b, P) {
        const C = [tri('E3 G3 B3'), tri('C3 E3 G3'), tri('G2 B2 D3'), tri('D3 F#3 A3'), tri('E3 G3 B3'), tri('A2 C3 E3'), tri('C3 E3 G3'), tri('B2 D#3 F#3')][b];
        const R = ['E2', 'C2', 'G1', 'D2', 'E2', 'A1', 'C2', 'B1'][b], a = arpTones(C, 24);
        P.pad(0, 4, up(C, 12), 0.5, { bright: 1500, attack: 0.9, release: 1.6 });
        P.bass(0, 1.9, R, 0.35, { type: 'sine' }); P.bass(2, 1.9, N(R) + 7, 0.28, { type: 'sine' });
        [0, 2, 1, 2, 4, 2, 1, 3].forEach((k, i) => P.celesta(i * 0.5, a[k], i % 4 === 0 ? 0.32 : 0.22));
        P.melody('bell', 0, ['B5:1 G5:.5 A5:.5 B5:2', 'C6:1 B5:.5 G5:.5 E5:2', 'D5:1 G5:1 B5:1 A5:1', 'F#5:3 r:1',
          'G5:1 E5:.5 F#5:.5 G5:2', 'A5:1 C6:1 B5:1 A5:1', 'G5:1.5 E5:.5 C5:1 E5:1', 'D#5:3 r:1'][b], 0.3);
        P.wind(0, 4, b % 2 ? 0.6 : 1);
        P.hat(1.5, 0.25, { band: true, freq: 6000, decay: 0.09 }); P.hat(3.5, 0.25, { band: true, freq: 6000, decay: 0.09 });
      },
    },
    ch3: {
      bpm: 100, beats: 4, bars: 8, gain: 0.95,
      bar(b, P) {
        const C = [tri('C3 Eb3 G3'), tri('C3 Eb3 G3'), tri('Ab2 C3 Eb3'), tri('Bb2 D3 F3'), tri('C3 Eb3 G3'), tri('C3 Eb3 G3'), tri('F2 Ab2 C3'), tri('G2 B2 D3')][b];
        const r = N(['C2', 'C2', 'Ab1', 'Bb1', 'C2', 'C2', 'F1', 'G1'][b]);
        // 전쟁 북 (16칸)
        const big = { 0: 0.95, 3: 0.6, 6: 0.75, 10: 0.6 }, low = { 8: 0.5, 12: 0.5, 14: 0.45 };
        for (let s = 0; s < 16; s++) {
          if (big[s]) P.taiko(s * 0.25, big[s]);
          if (low[s]) P.taiko(s * 0.25, low[s], { pitch: 135, decay: 0.4 });
          if (s % 2 === 0) P.hat(s * 0.25, s % 4 === 2 ? 0.35 : 0.2, { band: true, freq: 4500, decay: 0.07 });
        }
        P.kick(0, 0.7); P.kick(2, 0.6);
        if (b === 7) for (let i = 0; i < 4; i++) P.taiko(3 + i * 0.25, 0.5 + i * 0.12);
        // 낮은 금관 반복 음형 (화음 뿌리 기준)
        [[0, 0], [0.75, 0], [1.5, 3], [2, 0], [2.5, 7], [3, 5], [3.5, 3]].forEach(([at, k]) => P.brass(at, 0.45, [r + 12 + k], 0.5, { bright: 1300 }));
        P.bass(0, 3.8, r, 0.45, { type: 'sawtooth', bright: 300 });
        if (b < 4) P.choir(0, 4, up(C, 0), 0.45, { f1: 500, f2: 850 });   // 낮은 주문 소리
        else P.melody('brass', 0, ['C4:1.5 Eb4:.5 G4:1 F4:1', 'Eb4:1 D4:1 C4:2', 'F4:1.5 Ab4:.5 G4:1 F4:1', 'G4:2 B3:1 D4:1'][b - 4], 0.6, { bright: 2400 });
      },
    },
    ch4: {
      bpm: 104, beats: 4, bars: 8, gain: 1.1,
      bar(b, P) {
        const C = [tri('D3 F3 A3'), tri('C#3 E3 A3'), tri('Bb2 D3 F3'), tri('A2 C#3 E3'), tri('G2 Bb2 D3'), tri('D3 F3 A3'), tri('E3 G3 Bb3'), tri('A2 C#3 G3')][b];
        const r = N(['D2', 'C#2', 'Bb1', 'A1', 'G1', 'D2', 'E2', 'A1'][b]);
        P.organ(0, 4, up(C, 12).concat([r + 12]), 0.55);
        const t = up(C, 12), h = [t[0], t[1], t[2], t[0] + 12];
        [0, 1, 2, 3, 2, 1, 0, 1, 0, 1, 2, 3, 2, 1, 2, 1].forEach((k, i) => P.harpsi(i * 0.25, h[k], i % 4 === 0 ? 0.32 : 0.22));
        P.bass(0, 1.5, r, 0.5); P.bass(2, 1.5, r, 0.45);
        P.timp(0, r + 12, 0.5);
        if (b === 0 || b === 4) P.gong(0, r + 12, 0.4);
        if (b >= 4) P.choir(0, 4, up(C, 12), 0.5);
        if (b === 7) [3, 3.25, 3.5, 3.75].forEach((at, i) => P.timp(at, r + 12, 0.3 + i * 0.1));
        P.melody('lead', 0, ['D5:1 A4:.5 D5:.5 F5:1 E5:1', 'E5:1 C#5:1 A4:2', 'D5:1 F5:.5 D5:.5 Bb4:2', 'C#5:1 E5:1 A5:2',
          'G5:1 F5:.5 E5:.5 D5:1 Bb4:1', 'A4:1 D5:1 F5:2', 'E5:1 G5:1 Bb5:1 G5:1', 'C#5:3 r:1'][b], 0.5, { type: 'square', bright: 1800, vib: 8 });
      },
    },
    ch5: {
      bpm: 116, beats: 4, bars: 8, gain: 1.3,
      bar(b, P) {
        const r = N(['F#2', 'G2', 'F#2', 'D2', 'B1', 'C2', 'F#2', 'C#2'][b]);
        for (let i = 0; i < 8; i++) P.bass(i * 0.5, 0.4, r, i % 2 ? 0.35 : 0.55, { type: 'sawtooth', bright: 380 });   // 박동하는 저음
        P.pad(0, 4, [r + 12, r + 13, r + 19], 0.4, { bright: 700, attack: 1, release: 1.5 });   // 반음 부딪히는 불협 현
        const sc = [0, 1, 3, 6, 7, 10].map((k) => N('F#4') + k);   // 반음 섞인 음 묶음
        for (let s = 0; s < 16; s++) {
          if (hash(b, s) < 0.45) P.pluck(s * 0.25, sc[Math.floor(hash(s, b + 9) * sc.length)] + (hash(b + 3, s) < 0.3 ? 12 : 0), 0.3, { decay: 0.18, cutoff: 3500, wet: 0.3 });
          if (hash(s + 7, b) < 0.3) P.hat(s * 0.25, 0.3, { band: true, freq: 2800 + hash(s, b) * 2000, decay: 0.025, wet: 0.25 });   // 벌레 딸깍
        }
        P.kick(0, 0.7); P.kick(2.5, 0.55); P.snare(1, 0.25); P.snare(3, 0.3);
        if (b === 0 || b === 4) P.taiko(0, 0.6);
        if (b >= 4) P.melody('lead', 0, ['C#5:2 D5:1 C#5:1', 'C5:2 B4:2', 'A4:1 C5:1 C#5:1 F#5:1', 'F5:3 r:1'][b - 4], 0.45, { type: 'sine', vib: 30, vibRate: 6.5 });
      },
    },
  };

  /* ---------- 재생 ---------- */
  function startTrack(name) {
    const track = TRACKS[name];
    if (!track) return;
    const t = ctx.currentTime;
    if (cur) {   // 이전 곡은 서서히 사라지고 예약된 음이 끝나면 정리
      const old = cur;
      for (const g of [old.dry, old.wet]) { g.gain.cancelScheduledValues(t); g.gain.setValueAtTime(g.gain.value, t); g.gain.linearRampToValueAtTime(0.0001, t + FADE); }
      setTimeout(() => { old.dry.disconnect(); old.wet.disconnect(); }, (FADE + 6) * 1000);
    }
    const dry = ctx.createGain(), wet = ctx.createGain(), gv = track.gain ?? 1;
    for (const g of [dry, wet]) { g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(gv, t + FADE); }
    dry.connect(master); wet.connect(reverb);
    cur = { name, track, dry, wet, barIdx: 0, nextBar: t + 0.1 };
  }

  function tick() {   // 앞으로 0.5초 안에 시작하는 마디를 미리 예약
    if (!ctx || !cur || ctx.state !== 'running') return;
    const spb = 60 / cur.track.bpm, barLen = spb * cur.track.beats;
    if (cur.nextBar < ctx.currentTime) cur.nextBar = ctx.currentTime + 0.05;   // 멈췄다 돌아오면 이어서
    while (cur.nextBar < ctx.currentTime + 0.5) {
      cur.track.bar(cur.barIdx % cur.track.bars, player({ dry: cur.dry, wet: cur.wet }, cur.nextBar, spb));
      cur.nextBar += barLen; cur.barIdx += 1;
    }
  }

  function applyVolume() {
    if (!ctx) return;
    const t = ctx.currentTime, target = enabled && !silenced ? VOLUME * (paused ? DUCK : 1) * (performance.now() < duckUntil ? 0.4 : 1) : 0.0001;
    master.gain.cancelScheduledValues(t); master.gain.setValueAtTime(master.gain.value, t);
    master.gain.linearRampToValueAtTime(target, t + (silenced ? 1.5 : 0.4));   // 패배 때는 1.5초 동안 사라짐
  }

  // 첫 클릭·키 입력 때 오디오 시작 (브라우저 자동 재생 정책)
  function unlock() {
    if (unlocked || !init()) return;
    unlocked = true;
    ctx.resume();
    applyVolume();
    if (wanted) startTrack(wanted);
  }
  ['pointerdown', 'keydown', 'touchstart'].forEach((ev) => window.addEventListener(ev, unlock, { capture: true }));
  document.addEventListener('visibilitychange', () => {   // 다른 탭이면 소리를 멈춤
    if (!ctx || !unlocked) return;
    if (document.hidden) ctx.suspend(); else ctx.resume();
  });

  return {
    // 매 프레임: 지금 화면에 맞는 곡 이름, 일시정지 여부, 음악을 끌지(패배 화면)
    update(name, isPaused, isSilenced = false) {
      wanted = name;
      if (isPaused !== paused || isSilenced !== silenced) { paused = isPaused; silenced = isSilenced; applyVolume(); }
      if (unlocked && (!cur || cur.name !== name)) startTrack(name);
    },
    toggle() {
      enabled = !enabled;
      try { localStorage.setItem(PREF_KEY, enabled ? 'on' : 'off'); } catch (e) { /* 저장 실패는 무시 */ }
      applyVolume();
      return enabled;
    },
    // 효과음 켜기/끄기 (BGM과 따로 저장). 켜면 확인음으로 알림
    toggleSfx() {
      sfxOn = !sfxOn;
      try { localStorage.setItem(SFX_PREF_KEY, sfxOn ? 'on' : 'off'); } catch (e) { /* 저장 실패는 무시 */ }
      if (sfxOn) this.sfx('confirm');
      return sfxOn;
    },
    isSfxEnabled: () => sfxOn,
    // BGM을 ms 동안 낮춤 (거점 위험 경고)
    duck(ms) { duckUntil = performance.now() + ms; applyVolume(); setTimeout(applyVolume, ms + 20); },
    // 효과음: 이름은 SFX 목록. opts.pitch(음높이 배율)·opts.dark(고역 깎기)·opts.track(일어나라 조성)
    //  같은 소리는 0.06초 안에 한 번만, 동시에 6개까지 (넘으면 우선순위가 낮은 소리부터 건너뜀)
    sfx(name, opts = {}) {
      if (!sfxOn) return;
      unlock();
      const def = SFX[name];
      if (!ctx || !def) return;
      if (ctx.state !== 'running') ctx.resume();
      const now = ctx.currentTime;
      if (recent[name] !== undefined && now - recent[name] < 0.06) return;
      voices = voices.filter((v) => v.end > now);
      if (voices.length >= 6) {
        const worst = Math.max(...voices.map((v) => v.p));
        if (def.p >= worst) return;   // 지금 울리는 소리보다 중요하지 않으면 건너뜀
      }
      recent[name] = now;
      voices.push({ end: now + 0.25, p: def.p });
      def.f(now + 0.005, { pitch: 1, dark: false, ...opts });
    },
    isEnabled: () => enabled,
    current: () => (cur ? cur.name : null),
    tracks: () => Object.keys(TRACKS),
    renderOffline,
    renderSfxOffline,
    sfxNames: () => Object.keys(SFX),
  };
})();
