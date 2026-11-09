'use strict';

/* ==================================================================
 * ARISE: 그림자 군단 디펜스 — game.js (DAY 1 전투 프로토타입)
 *
 *  [1] GAME_DATA   밸런스·콘텐츠 데이터 (수치 조정은 여기만 수정)
 *  [2] 상수 / 상태  게임 상태(GameState)와 상태 전이 규칙
 *  [3] 규칙 함수    소환, 피해, 에너지 등 (화면 코드와 분리)
 *  [4] 전투 틱      1/60초마다 실행되는 전투 계산
 *  [5] 렌더링       Canvas 그리기
 *  [6] UI / 입력    HUD, 카드, 버튼, 마우스·키보드
 *  [7] 게임 루프    requestAnimationFrame 1개만 사용
 * ================================================================== */


/* ==================================================================
 * [1] GAME_DATA
 *  - lane 값은 0, 1, 2 (화면에는 L1, L2, L3로 표시)
 *  - 시간 단위는 초, 거리 단위는 전장 좌표(960×450 기준)
 *  - 데이터를 잘못 수정하면 게임 시작 전에 화면에 오류 목록이 표시됩니다.
 * ================================================================== */
const GAME_DATA = {
  config: {
    startEnergy: 100,
    maxEnergy: 150,
    killReward: 10,
    waveStartBonus: 20,   // 2웨이브부터 [웨이브 시작]을 누를 때 지급
    recallRefundRate: 1.0,// 회수 시 환불 비율 (1.0 = 전액). 이번 준비 단계에서 배치한 그림자만 회수 가능
    baseHp: 10,
    fixedStep: 1 / 60,    // 전투 계산 간격(초). 바꾸지 않는 것을 권장
  },

  field: {
    width: 960,
    height: 450,
    laneY: [75, 225, 375],
    baseX: 40,                 // 적이 이 X 이하로 오면 기지 피해
    spawnX: 940,               // 적 생성 X
    permanentSlotX: [190, 350],// 영구 그림자 슬롯 X (라인당 2개)
    temporarySlotX: 270,       // 추출 그림자 슬롯 X (DAY 3에서 사용)
    slotSize: 56,
  },

  shadows: [
    { id: 'SH_001', name: '아이언',   role: 'tank',   cost: 30, maxHp: 300, attack: 20, attackInterval: 1.5, attackRange: 100, targetType: 'single',       color: '#4f86ff' },
    { id: 'SH_002', name: '이그리트', role: 'damage', cost: 50, maxHp: 150, attack: 65, attackInterval: 1.0, attackRange: 120, targetType: 'single',       color: '#a66bff' },
    { id: 'SH_003', name: '탱크',     role: 'area',   cost: 40, maxHp: 220, attack: 35, attackInterval: 2.0, attackRange: 110, targetType: 'all_in_range', color: '#2ec4b6' },
  ],

  enemies: [
    { id: 'EN_001', name: '일반형',   maxHp: 100, attack: 15, moveSpeed: 35, attackInterval: 2.0, attackRange: 45, baseDamage: 1, radius: 16, color: '#d99a3e' },
    { id: 'EN_002', name: '돌격형',   maxHp: 70,  attack: 12, moveSpeed: 65, attackInterval: 1.5, attackRange: 45, baseDamage: 1, radius: 14, color: '#ff5d73' },
    { id: 'EN_003', name: '중장갑형', maxHp: 260, attack: 30, moveSpeed: 20, attackInterval: 2.5, attackRange: 45, baseDamage: 2, radius: 20, color: '#b07a5a' },
  ],

  // 적은 배열 순서대로 spawnInterval 간격으로 생성됩니다 (첫 적은 웨이브 시작 즉시).
  waves: [
    { waveId: 1, spawnInterval: 2.0, enemies: [
      { enemyId: 'EN_001', lane: 0 }, { enemyId: 'EN_001', lane: 1 }, { enemyId: 'EN_001', lane: 2 }, { enemyId: 'EN_001', lane: 1 },
    ] },
    { waveId: 2, spawnInterval: 2.0, enemies: [
      { enemyId: 'EN_001', lane: 0 }, { enemyId: 'EN_001', lane: 2 }, { enemyId: 'EN_002', lane: 1 }, { enemyId: 'EN_001', lane: 1 },
      { enemyId: 'EN_001', lane: 0 }, { enemyId: 'EN_002', lane: 2 }, { enemyId: 'EN_001', lane: 1 },
    ] },
    { waveId: 3, spawnInterval: 2.0, enemies: [
      { enemyId: 'EN_001', lane: 1 }, { enemyId: 'EN_002', lane: 0 }, { enemyId: 'EN_001', lane: 2 }, { enemyId: 'EN_002', lane: 2 },
      { enemyId: 'EN_003', lane: 1 }, { enemyId: 'EN_001', lane: 0 }, { enemyId: 'EN_002', lane: 1 }, { enemyId: 'EN_001', lane: 2 },
    ] },
    { waveId: 4, spawnInterval: 2.0, enemies: [
      { enemyId: 'EN_001', lane: 0 }, { enemyId: 'EN_001', lane: 1 }, { enemyId: 'EN_002', lane: 2 }, { enemyId: 'EN_003', lane: 0 },
      { enemyId: 'EN_001', lane: 2 }, { enemyId: 'EN_002', lane: 1 }, { enemyId: 'EN_001', lane: 1 }, { enemyId: 'EN_002', lane: 0 },
      { enemyId: 'EN_003', lane: 2 }, { enemyId: 'EN_002', lane: 2 }, { enemyId: 'EN_001', lane: 0 },
    ] },
    { waveId: 5, spawnInterval: 2.0, enemies: [
      { enemyId: 'EN_001', lane: 1 }, { enemyId: 'EN_001', lane: 0 }, { enemyId: 'EN_002', lane: 2 }, { enemyId: 'EN_003', lane: 1 },
      { enemyId: 'EN_001', lane: 2 }, { enemyId: 'EN_002', lane: 0 }, { enemyId: 'EN_001', lane: 1 }, { enemyId: 'EN_003', lane: 0 },
      { enemyId: 'EN_002', lane: 1 }, { enemyId: 'EN_001', lane: 2 }, { enemyId: 'EN_003', lane: 2 }, { enemyId: 'EN_002', lane: 2 },
      { enemyId: 'EN_001', lane: 0 },
    ] },
  ],

  // extraction: { ... }  → DAY 3 그림자 추출 단계에서 추가
};


/* ==================================================================
 * [2] 상수 / 상태
 * ================================================================== */
const STATUS = Object.freeze({
  READY: 'READY',             // 타이틀 화면
  PREPARATION: 'PREPARATION', // 병력 배치 (전투 정지)
  PLAYING: 'PLAYING',         // 전투 진행
  PAUSED: 'PAUSED',           // 일시정지 (DAY 2)
  WAVE_CLEAR: 'WAVE_CLEAR',   // 웨이브 종료 처리
  VICTORY: 'VICTORY',
  DEFEAT: 'DEFEAT',
});

// 허용된 상태 전이. 여기에 없는 전이는 무시되고 콘솔에 경고가 남습니다.
const TRANSITIONS = Object.freeze({
  READY:       ['PREPARATION'],
  PREPARATION: ['PLAYING', 'READY'],
  PLAYING:     ['PAUSED', 'WAVE_CLEAR', 'VICTORY', 'DEFEAT'],
  PAUSED:      ['PLAYING', 'READY'],
  WAVE_CLEAR:  ['PREPARATION', 'READY'],
  VICTORY:     ['READY'],
  DEFEAT:      ['READY'],
});

// 실패 사유 → 화면 메시지 (기획서 11-3)
const REASON_TEXT = Object.freeze({
  INVALID_STATUS:    '지금은 소환할 수 없습니다.',
  NO_SELECTION:      '소환할 그림자를 먼저 선택하세요.',
  INVALID_SHADOW:    '알 수 없는 그림자입니다.',
  INVALID_SLOT:      '배치할 수 없는 위치입니다.',
  SLOT_OCCUPIED:     '이미 그림자가 배치된 슬롯입니다.',
  NOT_ENOUGH_ENERGY: '그림자 에너지가 부족합니다.',
  // 회수
  RECALL_NOT_PREP:   '전투 중에는 회수할 수 없습니다.',
  RECALL_LOCKED:     '이전 웨이브에서 싸운 그림자는 회수할 수 없습니다.',
  RECALL_EMPTY:      '회수할 그림자가 없습니다.',
});

const ROLE_TEXT = Object.freeze({ tank: '탱커', damage: '딜러', area: '광역' });

function createInitialState() {
  const c = GAME_DATA.config;
  return {
    status: STATUS.READY,
    previousStatus: null,
    wave: 1,
    energy: c.startEnergy,
    maxEnergy: c.maxEnergy,
    baseHp: c.baseHp,
    maxBaseHp: c.baseHp,
    selectedShadowId: null,
    permanentUnits: [],
    temporaryUnits: [],   // DAY 3
    enemies: [],
    remnants: [],         // DAY 3
    effects: [],          // 공격 선 표시 (연출용, 게임 규칙에 영향 없음)
    spawnIndex: 0,
    spawnTimer: 0,
    nextUid: 1,           // 전장 객체 고유 ID (종류 ID와 별개)
    elapsed: 0,
    stats: { kills: 0, extractionAttempts: 0, extractionSuccesses: 0, energySpent: 0, baseDamageTaken: 0 },
  };
}

function setStatus(state, next) {
  const allowed = TRANSITIONS[state.status] || [];
  if (!allowed.includes(next)) {
    console.warn(`[상태 전이 거부] ${state.status} → ${next}`);
    return false;
  }
  state.previousStatus = state.status;
  state.status = next;
  return true;
}


/* ==================================================================
 * [3] 규칙 함수 (DOM을 사용하지 않음 → 따로 테스트 가능)
 * ================================================================== */
function findShadowData(id) { return GAME_DATA.shadows.find((s) => s.id === id) || null; }
function findEnemyData(id)  { return GAME_DATA.enemies.find((e) => e.id === id) || null; }
function getWaveData(waveNumber) { return GAME_DATA.waves[waveNumber - 1] || null; }

function addEnergy(state, amount) {
  state.energy = Math.min(state.maxEnergy, state.energy + amount);
}

function calcDamage(attack, multiplier) {
  return Math.max(1, Math.round(attack * (multiplier === undefined ? 1 : multiplier)));
}

// 대상에게 피해. 이 공격으로 사망했을 때만 true (사망 처리 1회 보장)
function applyDamage(target, amount) {
  if (!target.alive) return false;
  target.hp = Math.max(0, target.hp - amount);
  if (target.hp === 0) {
    target.alive = false;
    return true;
  }
  return false;
}

function getSlotOccupant(state, lane, slotIndex) {
  return state.permanentUnits.find((u) => u.alive && u.lane === lane && u.slotIndex === slotIndex) || null;
}

function canSummon(state, shadowId, lane, slotIndex) {
  if (state.status !== STATUS.PREPARATION && state.status !== STATUS.PLAYING) return { ok: false, reason: 'INVALID_STATUS' };
  if (!shadowId) return { ok: false, reason: 'NO_SELECTION' };
  const data = findShadowData(shadowId);
  if (!data) return { ok: false, reason: 'INVALID_SHADOW' };
  const F = GAME_DATA.field;
  if (!Number.isInteger(lane) || lane < 0 || lane >= F.laneY.length) return { ok: false, reason: 'INVALID_SLOT' };
  if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex >= F.permanentSlotX.length) return { ok: false, reason: 'INVALID_SLOT' };
  if (getSlotOccupant(state, lane, slotIndex)) return { ok: false, reason: 'SLOT_OCCUPIED' };
  if (state.energy < data.cost) return { ok: false, reason: 'NOT_ENOUGH_ENERGY' };
  return { ok: true, data };
}

function summonShadow(state, shadowId, lane, slotIndex) {
  const check = canSummon(state, shadowId, lane, slotIndex);
  if (!check.ok) return check;
  const d = check.data;
  state.energy -= d.cost;
  state.stats.energySpent += d.cost;
  const unit = {
    uid: state.nextUid++,
    typeId: d.id,
    kind: 'permanent',
    lane,
    slotIndex,
    x: GAME_DATA.field.permanentSlotX[slotIndex],
    hp: d.maxHp,
    maxHp: d.maxHp,
    attack: d.attack,
    attackInterval: d.attackInterval,
    attackRange: d.attackRange,
    targetType: d.targetType,
    cooldown: 0,          // 생성 직후 첫 공격 가능
    alive: true,
    paidCost: d.cost,     // 회수 시 환불 기준
    // 준비 단계에서 배치한 그림자만 회수 가능. 웨이브가 시작되면 false로 잠김
    recallable: state.status === STATUS.PREPARATION,
  };
  state.permanentUnits.push(unit);
  return { ok: true, unit };
}

// 회수 규칙 (A안): 준비 단계 + 이번 준비 단계에서 배치한 그림자만, 비용 × recallRefundRate 환불
function canRecall(state, lane, slotIndex) {
  const unit = getSlotOccupant(state, lane, slotIndex);
  if (!unit) return { ok: false, reason: 'RECALL_EMPTY' };
  if (state.status !== STATUS.PREPARATION) return { ok: false, reason: 'RECALL_NOT_PREP' };
  if (!unit.recallable) return { ok: false, reason: 'RECALL_LOCKED' };
  return { ok: true, unit };
}

function recallShadow(state, lane, slotIndex) {
  const check = canRecall(state, lane, slotIndex);
  if (!check.ok) return check;
  const unit = check.unit;
  const refund = Math.round(unit.paidCost * GAME_DATA.config.recallRefundRate);
  unit.alive = false;   // 슬롯 비움 (getSlotOccupant는 살아 있는 그림자만 봄)
  state.permanentUnits = state.permanentUnits.filter((u) => u.uid !== unit.uid);
  addEnergy(state, refund);
  state.stats.energySpent -= refund;
  return { ok: true, unit, refund };
}

function createEnemy(state, enemyId, lane) {
  const d = findEnemyData(enemyId);
  return {
    uid: state.nextUid++,
    typeId: d.id,
    lane,
    x: GAME_DATA.field.spawnX,
    hp: d.maxHp,
    maxHp: d.maxHp,
    attack: d.attack,
    moveSpeed: d.moveSpeed,
    attackInterval: d.attackInterval,
    attackRange: d.attackRange,
    baseDamage: d.baseDamage,
    cooldown: 0,
    alive: true,
    reachedBase: false,
    moving: true,
  };
}

function getAllShadows(state) {
  return state.permanentUnits.concat(state.temporaryUnits);
}

// 그림자의 공격 대상: 같은 라인, 사거리 내, 가장 왼쪽(x 최소) → 동률이면 먼저 생성된 적
function findShadowTargets(state, unit) {
  const inRange = state.enemies.filter((e) =>
    e.alive && e.lane === unit.lane && Math.abs(e.x - unit.x) <= unit.attackRange);
  inRange.sort((a, b) => (a.x - b.x) || (a.uid - b.uid));
  if (inRange.length === 0) return [];
  return unit.targetType === 'all_in_range' ? inRange : [inRange[0]];
}

// 적의 공격 대상: 같은 라인, 사거리 내 가장 가까운 그림자 → 동률이면 먼저 생성된 그림자
function findEnemyTarget(state, enemy) {
  let best = null;
  let bestDist = Infinity;
  for (const s of getAllShadows(state)) {
    if (!s.alive || s.lane !== enemy.lane) continue;
    const dist = Math.abs(enemy.x - s.x);
    if (dist > enemy.attackRange) continue;
    if (dist < bestDist || (dist === bestDist && s.uid < best.uid)) {
      best = s;
      bestDist = dist;
    }
  }
  return best;
}

function startWave(state) {
  if (state.status !== STATUS.PREPARATION) return false;
  if (!getWaveData(state.wave)) return false;
  if (state.wave >= 2) addEnergy(state, GAME_DATA.config.waveStartBonus);
  for (const u of state.permanentUnits) u.recallable = false;   // 전투에 들어간 그림자는 회수 잠금
  state.spawnIndex = 0;
  state.spawnTimer = 0;   // 첫 적은 즉시 생성
  return setStatus(state, STATUS.PLAYING);
}

// WAVE_CLEAR → 다음 웨이브 PREPARATION
function goToNextWave(state) {
  if (state.status !== STATUS.WAVE_CLEAR) return false;
  state.wave += 1;
  state.remnants = [];
  state.temporaryUnits = [];
  return setStatus(state, STATUS.PREPARATION);
}


/* ==================================================================
 * [4] 전투 틱 — 기획서 9-1 처리 순서
 *  사망한 객체는 반복 도중 바로 지우지 않고 alive=false로 표시한 뒤
 *  틱 마지막에 한꺼번에 제거합니다.
 * ================================================================== */
function updateGame(state, dt) {
  if (state.status !== STATUS.PLAYING) return;
  state.elapsed += dt;

  updateSpawning(state, dt);              // 1. 적 생성
  // 2. 잔영 시간 갱신 → DAY 3
  updateEnemyMovement(state, dt);         // 3. 적 이동 / 기지 도달
  if (state.baseHp <= 0) {                // 기지 HP 0 → 즉시 패배
    cleanupDead(state);
    setStatus(state, STATUS.DEFEAT);
    return;
  }
  updateCooldowns(state, dt);             // 4. 쿨타임
  const killed = processShadowAttacks(state); // 5. 그림자 공격
  processEnemyAttacks(state);             //    적 공격 (이번 틱에 죽은 적은 공격하지 않음)
  for (const enemy of killed) {           // 6. 처치 보상 (사망 1회당 1번)
    state.stats.kills += 1;
    addEnergy(state, GAME_DATA.config.killReward);
    // 잔영 생성 확률 판정 → DAY 3
  }
  cleanupDead(state);                     // 7. 사망 객체 일괄 제거
  updateEffects(state, dt);
  checkWaveComplete(state);               // 8. 웨이브 완료 판정
}

function updateSpawning(state, dt) {
  const wave = getWaveData(state.wave);
  if (!wave || state.spawnIndex >= wave.enemies.length) return;
  state.spawnTimer -= dt;
  while (state.spawnTimer <= 0 && state.spawnIndex < wave.enemies.length) {
    const entry = wave.enemies[state.spawnIndex];
    state.enemies.push(createEnemy(state, entry.enemyId, entry.lane));
    state.spawnIndex += 1;
    state.spawnTimer += wave.spawnInterval;
  }
}

function updateEnemyMovement(state, dt) {
  const baseX = GAME_DATA.field.baseX;
  for (const e of state.enemies) {
    if (!e.alive) continue;
    const target = findEnemyTarget(state, e);
    e.moving = !target;               // 사거리 안에 그림자가 있으면 멈춤
    if (!e.moving) continue;
    e.x -= e.moveSpeed * dt;
    if (e.x <= baseX) {
      e.x = baseX;
      e.alive = false;                // 처치가 아니므로 보상 없음
      e.reachedBase = true;
      state.baseHp = Math.max(0, state.baseHp - e.baseDamage);
      state.stats.baseDamageTaken += e.baseDamage;
    }
  }
}

function updateCooldowns(state, dt) {
  for (const u of getAllShadows(state)) if (u.alive) u.cooldown = Math.max(0, u.cooldown - dt);
  for (const e of state.enemies) if (e.alive) e.cooldown = Math.max(0, e.cooldown - dt);
}

function processShadowAttacks(state) {
  const killed = [];
  for (const u of getAllShadows(state)) {
    if (!u.alive || u.cooldown > 0) continue;
    const targets = findShadowTargets(state, u);
    if (targets.length === 0) continue;   // 대상이 없으면 쿨타임 0 유지 → 대상이 오면 즉시 공격
    const dmg = calcDamage(u.attack);
    for (const t of targets) {
      if (applyDamage(t, dmg)) killed.push(t);
      addEffect(state, u.x, u.lane, t.x, t.lane, 'shadow');
    }
    u.cooldown = u.attackInterval;
  }
  return killed;
}

function processEnemyAttacks(state) {
  for (const e of state.enemies) {
    if (!e.alive || e.cooldown > 0) continue;
    const target = findEnemyTarget(state, e);   // 매번 다시 찾음 → 이미 죽은 그림자 공격 방지
    if (!target) continue;
    applyDamage(target, calcDamage(e.attack));
    addEffect(state, e.x, e.lane, target.x, target.lane, 'enemy');
    e.cooldown = e.attackInterval;
  }
}

function cleanupDead(state) {
  state.enemies = state.enemies.filter((e) => e.alive);
  state.permanentUnits = state.permanentUnits.filter((u) => u.alive);  // 죽으면 슬롯이 비워짐
  state.temporaryUnits = state.temporaryUnits.filter((u) => u.alive);
}

function checkWaveComplete(state) {
  const wave = getWaveData(state.wave);
  if (!wave) return;
  if (state.spawnIndex < wave.enemies.length || state.enemies.length > 0) return;
  state.remnants = [];
  state.temporaryUnits = [];
  setStatus(state, state.wave >= GAME_DATA.waves.length ? STATUS.VICTORY : STATUS.WAVE_CLEAR);
}

function addEffect(state, x1, lane1, x2, lane2, kind) {
  state.effects.push({ x1, lane1, x2, lane2, kind, ttl: 0.12 });
}

function updateEffects(state, dt) {
  for (const fx of state.effects) fx.ttl -= dt;
  state.effects = state.effects.filter((fx) => fx.ttl > 0);
}


/* ==================================================================
 * 데이터 검증 — GAME_DATA를 잘못 고쳤을 때 원인을 바로 알 수 있게
 * ================================================================== */
function validateGameData(data) {
  const errors = [];
  const isPos = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;
  const c = data.config;
  if (!isPos(c.startEnergy) || !isPos(c.maxEnergy)) errors.push('config: startEnergy / maxEnergy는 0보다 큰 숫자여야 합니다.');
  if (c.startEnergy > c.maxEnergy) errors.push('config: startEnergy가 maxEnergy보다 큽니다.');
  if (!isPos(c.baseHp)) errors.push('config: baseHp는 0보다 큰 숫자여야 합니다.');
  if (typeof c.recallRefundRate !== 'number' || c.recallRefundRate < 0 || c.recallRefundRate > 1) errors.push('config: recallRefundRate는 0~1 사이 숫자여야 합니다.');
  if (!data.field.laneY.length) errors.push('field: laneY가 비어 있습니다.');
  if (!data.field.permanentSlotX.length) errors.push('field: permanentSlotX가 비어 있습니다.');

  const ids = new Set();
  for (const s of data.shadows) {
    if (ids.has(s.id)) errors.push(`shadows: 중복 ID ${s.id}`);
    ids.add(s.id);
    for (const k of ['cost', 'maxHp', 'attack', 'attackInterval', 'attackRange']) {
      if (!isPos(s[k])) errors.push(`shadows ${s.id}: ${k} 값이 올바르지 않습니다 (${s[k]}).`);
    }
    if (!['single', 'all_in_range'].includes(s.targetType)) errors.push(`shadows ${s.id}: targetType은 single 또는 all_in_range 입니다.`);
  }
  for (const e of data.enemies) {
    if (ids.has(e.id)) errors.push(`enemies: 중복 ID ${e.id}`);
    ids.add(e.id);
    for (const k of ['maxHp', 'attack', 'moveSpeed', 'attackInterval', 'attackRange', 'baseDamage']) {
      if (!isPos(e[k])) errors.push(`enemies ${e.id}: ${k} 값이 올바르지 않습니다 (${e[k]}).`);
    }
  }
  if (!data.waves.length) errors.push('waves: 웨이브가 없습니다.');
  data.waves.forEach((w, i) => {
    if (!isPos(w.spawnInterval)) errors.push(`waves[${i}]: spawnInterval 값이 올바르지 않습니다.`);
    if (!w.enemies.length) errors.push(`waves[${i}]: 적이 없습니다.`);
    w.enemies.forEach((en, j) => {
      if (!data.enemies.some((d) => d.id === en.enemyId)) errors.push(`waves[${i}].enemies[${j}]: 없는 적 ID ${en.enemyId}`);
      if (!Number.isInteger(en.lane) || en.lane < 0 || en.lane >= data.field.laneY.length) errors.push(`waves[${i}].enemies[${j}]: lane은 0~${data.field.laneY.length - 1} 사이여야 합니다.`);
    });
  });
  return errors;
}


/* ==================================================================
 * [5] 렌더링 (Canvas) — 게임 규칙을 바꾸지 않고 그리기만 함
 * ================================================================== */
const COLORS = {
  bg: '#0c0e18', laneA: '#131726', laneB: '#161b2d', laneLine: '#252b43',
  base: '#2c1022', baseLine: '#ff4d6d', spawn: '#3a3f5c',
  slot: '#1d2340', slotBorder: '#46507a', slotOk: '#3ddc97', slotBad: '#ff5c7a', slotRecall: '#ffcf5c', tempSlot: '#5d4b91',
  text: '#e6e8f2', subText: '#8b91b0', hpBack: 'rgba(0,0,0,0.6)', hpShadow: '#7cc4ff', hpEnemy: '#ff6b6b',
  fxShadow: '#b9a6ff', fxEnemy: '#ff9a6b', range: 'rgba(124,196,255,0.10)', rangeEnemy: 'rgba(255,107,107,0.25)',
};

function laneHeight() { return GAME_DATA.field.height / GAME_DATA.field.laneY.length; }

function getSlotAt(x, y) {
  const F = GAME_DATA.field;
  const half = F.slotSize / 2;
  for (let lane = 0; lane < F.laneY.length; lane++) {
    for (let slotIndex = 0; slotIndex < F.permanentSlotX.length; slotIndex++) {
      if (Math.abs(x - F.permanentSlotX[slotIndex]) <= half && Math.abs(y - F.laneY[lane]) <= half) {
        return { lane, slotIndex };
      }
    }
  }
  return null;
}

function drawHpBar(ctx, cx, top, width, ratio, color) {
  ctx.fillStyle = COLORS.hpBack;
  ctx.fillRect(cx - width / 2, top, width, 5);
  ctx.fillStyle = color;
  ctx.fillRect(cx - width / 2, top, width * Math.max(0, Math.min(1, ratio)), 5);
}

function drawRoundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function render(ctx, state, view) {
  const F = GAME_DATA.field;
  const lh = laneHeight();

  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, F.width, F.height);

  // 라인
  F.laneY.forEach((y, i) => {
    ctx.fillStyle = i % 2 === 0 ? COLORS.laneA : COLORS.laneB;
    ctx.fillRect(0, y - lh / 2, F.width, lh);
    ctx.strokeStyle = COLORS.laneLine;
    ctx.beginPath(); ctx.moveTo(0, y + lh / 2); ctx.lineTo(F.width, y + lh / 2); ctx.stroke();
    ctx.fillStyle = COLORS.subText;
    ctx.font = 'bold 13px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(`L${i + 1}`, F.baseX + 8, y - lh / 2 + 6);
  });

  // 기지
  ctx.fillStyle = COLORS.base;
  ctx.fillRect(0, 0, F.baseX, F.height);
  ctx.strokeStyle = COLORS.baseLine;
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(F.baseX, 0); ctx.lineTo(F.baseX, F.height); ctx.stroke();
  ctx.lineWidth = 1;
  ctx.save();
  ctx.translate(F.baseX / 2, F.height / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillStyle = COLORS.baseLine;
  ctx.font = 'bold 14px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('기지', 0, 0);
  ctx.restore();

  // 적 생성 위치
  ctx.strokeStyle = COLORS.spawn;
  ctx.setLineDash([6, 6]);
  ctx.beginPath(); ctx.moveTo(F.spawnX, 0); ctx.lineTo(F.spawnX, F.height); ctx.stroke();
  ctx.setLineDash([]);

  // 슬롯
  const half = F.slotSize / 2;
  F.laneY.forEach((y, lane) => {
    // 추출 슬롯 자리 (DAY 3에서 사용)
    ctx.strokeStyle = COLORS.tempSlot;
    ctx.setLineDash([4, 4]);
    ctx.strokeRect(F.temporarySlotX - half + 8, y - half + 8, F.slotSize - 16, F.slotSize - 16);
    ctx.setLineDash([]);

    F.permanentSlotX.forEach((x, slotIndex) => {
      const occupied = !!getSlotOccupant(state, lane, slotIndex);
      const isHover = view.hoverSlot && view.hoverSlot.lane === lane && view.hoverSlot.slotIndex === slotIndex;
      ctx.fillStyle = COLORS.slot;
      drawRoundRect(ctx, x - half, y - half, F.slotSize, F.slotSize, 8);
      ctx.fill();
      ctx.strokeStyle = COLORS.slotBorder;
      if (isHover && state.selectedShadowId && !occupied) {
        ctx.strokeStyle = canSummon(state, state.selectedShadowId, lane, slotIndex).ok ? COLORS.slotOk : COLORS.slotBad;
        ctx.lineWidth = 3;
      } else if (isHover && occupied && canRecall(state, lane, slotIndex).ok) {
        ctx.strokeStyle = COLORS.slotRecall;   // 회수 가능한 그림자에 마우스를 올리면 노란 테두리
        ctx.lineWidth = 3;
      }
      ctx.stroke();
      ctx.lineWidth = 1;
    });
  });

  // 사거리 표시 (D 키)
  if (view.showRanges) {
    for (const u of getAllShadows(state)) {
      const y = F.laneY[u.lane];
      ctx.fillStyle = COLORS.range;
      ctx.fillRect(u.x - u.attackRange, y - lh / 2 + 2, u.attackRange * 2, lh - 4);
    }
    for (const e of state.enemies) {
      const y = F.laneY[e.lane];
      ctx.fillStyle = COLORS.rangeEnemy;
      ctx.fillRect(e.x - e.attackRange, y - 2, e.attackRange, 4);
    }
  }

  // 그림자
  for (const u of getAllShadows(state)) {
    const d = findShadowData(u.typeId);
    const y = F.laneY[u.lane];
    ctx.fillStyle = d ? d.color : '#888';
    drawRoundRect(ctx, u.x - 20, y - 20, 40, 40, 8);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 16px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(d ? d.name[0] : '?', u.x, y + 1);
    ctx.fillStyle = COLORS.text;
    ctx.font = '11px sans-serif';
    ctx.fillText(d ? d.name : '', u.x, y + 32);
    drawHpBar(ctx, u.x, y - 30, 44, u.hp / u.maxHp, COLORS.hpShadow);
  }

  // 적
  for (const e of state.enemies) {
    const d = findEnemyData(e.typeId);
    const y = F.laneY[e.lane];
    const r = d.radius || 16;
    ctx.fillStyle = d.color || '#c66';
    ctx.beginPath(); ctx.arc(e.x, y, r, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = e.moving ? 'rgba(0,0,0,0.4)' : '#ffffff';
    ctx.lineWidth = e.moving ? 1 : 2;
    ctx.stroke();
    ctx.lineWidth = 1;
    ctx.fillStyle = COLORS.text;
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(d.name, e.x, y + r + 12);
    drawHpBar(ctx, e.x, y - r - 10, 36, e.hp / e.maxHp, COLORS.hpEnemy);
  }

  // 공격 선
  for (const fx of state.effects) {
    ctx.strokeStyle = fx.kind === 'shadow' ? COLORS.fxShadow : COLORS.fxEnemy;
    ctx.globalAlpha = Math.max(0, fx.ttl / 0.12);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(fx.x1, F.laneY[fx.lane1]);
    ctx.lineTo(fx.x2, F.laneY[fx.lane2]);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.lineWidth = 1;
  }
}


/* ==================================================================
 * [6] UI / 입력 — 이벤트는 boot()에서 딱 한 번만 등록
 * ================================================================== */
const STATUS_TEXT = {
  READY: '대기', PREPARATION: '배치 준비', PLAYING: '전투 중', PAUSED: '일시정지',
  WAVE_CLEAR: '웨이브 완료', VICTORY: '승리', DEFEAT: '패배',
};

const game = {
  state: null,
  canvas: null,
  ctx: null,
  ui: {},
  view: { hoverSlot: null, showRanges: false },
  toastTimer: null,
  lastTime: null,
  accumulator: 0,
};

function $(id) { return document.getElementById(id); }

function showToast(text, type) {
  const el = game.ui.toast;
  el.textContent = text;
  el.className = `toast show ${type || ''}`;
  clearTimeout(game.toastTimer);
  game.toastTimer = setTimeout(hideToast, 1400);
}

function hideToast() {
  clearTimeout(game.toastTimer);
  game.ui.toast.className = 'toast';
}

function buildShadowCards() {
  const wrap = game.ui.cards;
  wrap.innerHTML = '';
  GAME_DATA.shadows.forEach((s, i) => {
    const btn = document.createElement('button');
    btn.className = 'card';
    btn.type = 'button';
    btn.dataset.shadowId = s.id;
    btn.style.setProperty('--card-color', s.color);
    btn.innerHTML =
      `<span class="card-key">${i + 1}</span>` +
      `<span class="card-name">${s.name}</span>` +
      `<span class="card-role">${ROLE_TEXT[s.role] || s.role}</span>` +
      `<span class="card-stats">HP ${s.maxHp} · ATK ${s.attack} · ${s.attackInterval}초</span>` +
      `<span class="card-cost">에너지 ${s.cost}</span>`;
    btn.addEventListener('click', () => selectShadow(s.id));
    wrap.appendChild(btn);
  });
}

function selectShadow(id) {
  const st = game.state;
  if (st.status !== STATUS.PREPARATION && st.status !== STATUS.PLAYING) return;
  st.selectedShadowId = st.selectedShadowId === id ? null : id;  // 같은 카드 다시 누르면 선택 해제
}

// 우클릭(또는 Mac Control + 클릭)
//  - 배치된 그림자 위: 회수 시도
//  - 그 밖의 곳: 카드 선택 해제
function onSecondaryClick(evt) {
  evt.preventDefault();   // 브라우저 우클릭 메뉴가 뜨지 않도록
  if (evt.target === game.canvas) {
    const p = toFieldPos(evt);
    const slot = getSlotAt(p.x, p.y);
    if (slot && getSlotOccupant(game.state, slot.lane, slot.slotIndex)) {
      tryRecall(slot);
      return;
    }
  }
  game.state.selectedShadowId = null;
}

function tryRecall(slot) {
  const result = recallShadow(game.state, slot.lane, slot.slotIndex);
  if (result.ok) {
    showToast(`${findShadowData(result.unit.typeId).name} 회수 (에너지 +${result.refund})`, 'ok');
  } else {
    showToast(REASON_TEXT[result.reason] || result.reason, 'warn');
  }
}

function toFieldPos(evt) {
  const rect = game.canvas.getBoundingClientRect();
  return {
    x: (evt.clientX - rect.left) * (game.canvas.width / rect.width),
    y: (evt.clientY - rect.top) * (game.canvas.height / rect.height),
  };
}

function onCanvasClick(evt) {
  if (evt.ctrlKey) { onSecondaryClick(evt); return; }   // Mac Control + 클릭 = 우클릭
  const p = toFieldPos(evt);
  const slot = getSlotAt(p.x, p.y);
  if (!slot) return;   // DAY 3: 잔영 클릭 처리 추가 예정
  const st = game.state;
  const result = summonShadow(st, st.selectedShadowId, slot.lane, slot.slotIndex);
  if (result.ok) {
    showToast(`${findShadowData(result.unit.typeId).name} 소환 (L${slot.lane + 1})`, 'ok');
  } else {
    showToast(REASON_TEXT[result.reason] || result.reason, 'warn');
  }
}

function newGame() {
  game.state = createInitialState();
  setStatus(game.state, STATUS.PREPARATION);
  game.accumulator = 0;
  hideToast();   // 이전 판의 메시지가 남지 않도록
}

function goToTitle() {
  game.state = createInitialState();   // READY
  game.accumulator = 0;
  hideToast();
}

function onStartWave() {
  if (startWave(game.state)) showToast(`WAVE ${game.state.wave} 시작`, 'ok');
}

function onResultPrimary() {
  const st = game.state;
  if (st.status === STATUS.WAVE_CLEAR) goToNextWave(st);
  else if (st.status === STATUS.VICTORY || st.status === STATUS.DEFEAT) newGame();
}

function onKeyDown(evt) {
  if (evt.repeat) return;
  const key = evt.key.toLowerCase();
  if (key === 'd') { game.view.showRanges = !game.view.showRanges; return; }
  const num = Number(evt.key);
  if (Number.isInteger(num) && num >= 1 && num <= GAME_DATA.shadows.length) selectShadow(GAME_DATA.shadows[num - 1].id);
}

function setText(el, text) { if (el.textContent !== text) el.textContent = text; }
function setHidden(el, hidden) { if (el.classList.contains('hidden') !== hidden) el.classList.toggle('hidden', hidden); }

function hintText(st) {
  switch (st.status) {
    case STATUS.PREPARATION: return '카드를 고르고 빈 슬롯을 클릭해 배치하세요. 이번에 배치한 그림자는 우클릭으로 회수(전액 환불)할 수 있습니다.';
    case STATUS.PLAYING: return '전투 중에도 배치할 수 있습니다. 처치 시 에너지 +' + GAME_DATA.config.killReward;
    default: return '';
  }
}

function syncUI() {
  const st = game.state;
  const ui = game.ui;
  setText(ui.wave, `${st.wave} / ${GAME_DATA.waves.length}`);
  setText(ui.energy, `${st.energy} / ${st.maxEnergy}`);
  setText(ui.base, `${st.baseHp} / ${st.maxBaseHp}`);
  setText(ui.status, STATUS_TEXT[st.status]);
  setText(ui.hint, hintText(st));
  ui.base.classList.toggle('danger', st.baseHp <= 3);

  for (const btn of ui.cards.children) {
    const d = findShadowData(btn.dataset.shadowId);
    btn.classList.toggle('selected', st.selectedShadowId === d.id);
    btn.classList.toggle('poor', st.energy < d.cost);
  }

  setHidden(ui.btnStart, st.status !== STATUS.PREPARATION);
  setText(ui.btnStart, `WAVE ${st.wave} 시작`);

  setHidden(ui.overlayTitle, st.status !== STATUS.READY);
  const showResult = st.status === STATUS.WAVE_CLEAR || st.status === STATUS.VICTORY || st.status === STATUS.DEFEAT;
  setHidden(ui.overlayResult, !showResult);
  if (showResult) {
    if (st.status === STATUS.WAVE_CLEAR) {
      setText(ui.resultTitle, '웨이브 방어 성공');
      setText(ui.resultDesc, `WAVE ${st.wave} 클리어 · 처치 ${st.stats.kills} · 기지 HP ${st.baseHp}/${st.maxBaseHp}`);
      setText(ui.btnResultPrimary, '다음 웨이브 준비');
    } else if (st.status === STATUS.VICTORY) {
      setText(ui.resultTitle, '던전 방어 성공!');
      setText(ui.resultDesc, `전 웨이브 클리어 · 처치 ${st.stats.kills} · 기지 HP ${st.baseHp}/${st.maxBaseHp}`);
      setText(ui.btnResultPrimary, '다시 도전');
    } else {
      setText(ui.resultTitle, '던전 방어 실패');
      setText(ui.resultDesc, `WAVE ${st.wave}에서 기지 파괴 · 처치 ${st.stats.kills}`);
      setText(ui.btnResultPrimary, '다시 도전');
    }
    ui.overlayResult.dataset.kind = st.status.toLowerCase();
  }
}


/* ==================================================================
 * [7] 게임 루프 & 부팅
 *  - requestAnimationFrame 루프는 boot()에서 1번만 시작 (재시작해도 새로 만들지 않음)
 *  - 전투는 1/60초 고정 간격, 화면은 브라우저 프레임마다 그림
 * ================================================================== */
function frame(now) {
  if (game.lastTime === null) game.lastTime = now;
  let delta = (now - game.lastTime) / 1000;
  game.lastTime = now;
  if (delta > 0.25) delta = 0.25;   // 탭 전환 후 복귀 시 한꺼번에 몰아서 계산하지 않도록

  const step = GAME_DATA.config.fixedStep;
  game.accumulator += delta;
  let steps = 0;
  while (game.accumulator >= step && steps < 30) {
    updateGame(game.state, step);
    game.accumulator -= step;
    steps += 1;
  }
  if (steps >= 30) game.accumulator = 0;

  render(game.ctx, game.state, game.view);
  syncUI();
  requestAnimationFrame(frame);
}

function boot() {
  const errors = validateGameData(GAME_DATA);
  if (errors.length) {
    const box = $('data-error');
    box.innerHTML = '<h2>GAME_DATA 오류</h2><p>game.js 상단 데이터를 확인하세요.</p><ul>' +
      errors.map((e) => `<li>${e}</li>`).join('') + '</ul>';
    box.classList.remove('hidden');
    console.error('[GAME_DATA 오류]', errors);
    return;
  }

  game.canvas = $('field');
  game.ctx = game.canvas.getContext('2d');
  game.ui = {
    wave: $('hud-wave'), energy: $('hud-energy'), base: $('hud-base'), status: $('hud-status'),
    hint: $('hint'), toast: $('toast'), cards: $('shadow-cards'), btnStart: $('btn-start-wave'),
    overlayTitle: $('overlay-title'), overlayResult: $('overlay-result'),
    resultTitle: $('result-title'), resultDesc: $('result-desc'),
    btnResultPrimary: $('btn-result-primary'),
  };

  game.state = createInitialState();
  buildShadowCards();

  game.canvas.addEventListener('click', onCanvasClick);
  game.canvas.addEventListener('mousemove', (evt) => {
    const p = toFieldPos(evt);
    game.view.hoverSlot = getSlotAt(p.x, p.y);
    game.canvas.style.cursor = game.view.hoverSlot ? 'pointer' : 'default';
  });
  game.canvas.addEventListener('mouseleave', () => { game.view.hoverSlot = null; });
  $('app').addEventListener('contextmenu', onSecondaryClick);   // 그림자 위: 회수 / 그 밖: 선택 해제
  $('btn-play').addEventListener('click', newGame);
  game.ui.btnStart.addEventListener('click', onStartWave);
  game.ui.btnResultPrimary.addEventListener('click', onResultPrimary);
  $('btn-result-title').addEventListener('click', goToTitle);
  window.addEventListener('keydown', onKeyDown);

  requestAnimationFrame(frame);
}

if (typeof document !== 'undefined') boot();
