'use strict';

/* ==================================================================
 * ARISE: 그림자 군단 디펜스 — game.js (v2.0 중앙 거점 · 자유 배치 · 그림자 추출)
 *
 *  [1] GAME_DATA   밸런스·콘텐츠 데이터 (수치 조정은 여기만 수정)
 *  [2] 상수 / 상태  게임 상태(GameState)와 상태 전이 규칙
 *  [3] 규칙 함수    배치, 회수, 추출, 대상 탐색 등 (화면 코드와 분리)
 *  [4] 전투 틱      1/60초마다 실행되는 전투 계산
 *  [5] 렌더링       Canvas 그리기
 *  [6] UI / 입력    HUD, 카드, 추출 패널, 마우스·키보드
 *  [7] 게임 루프    requestAnimationFrame 1개만 사용
 *
 *  핵심 루프: 자유 배치 → 적 처치 → 잔영 생성 → 수동 추출 → 자동 추적
 * ================================================================== */


/* ==================================================================
 * [1] GAME_DATA
 *  - 좌표 단위는 전장 좌표(960×540 기준), 시간 단위는 초
 *  - spawn 값은 적 출현 지점 번호 (0 북, 1 동, 2 남, 3 서)
 *  - 데이터를 잘못 수정하면 게임 시작 전에 화면에 오류 목록이 표시됩니다.
 * ================================================================== */
const GAME_DATA = {
  config: {
    startEnergy: 100,
    maxEnergy: 150,
    killReward: 10,
    waveStartBonus: 20,    // 2웨이브부터 [웨이브 시작]을 누를 때 지급
    recallRefundRate: 1.0, // 회수 시 환불 비율 (1.0 = 전액). 이번 준비 단계에서 배치한 기본 그림자만 회수 가능
    dismantleRefundRate: 0.5, // 해체 시 반환 비율. 생성 때 실제 소비한 에너지 기준, 반올림 (SD-DISMANTLE)
    coreHp: 10,
    maxArmy: 15,           // 전체 군단 최대 수 (기본 + 추출)
    maxBasic: 3,           // 기본 그림자 최대 수
    fixedStep: 1 / 60,     // 전투 계산 간격(초). 바꾸지 않는 것을 권장
  },

  field: {
    width: 960,
    height: 540,
    core: { x: 480, y: 270, radius: 45 },
    spawnPoints: [
      { id: 'N', label: '북', x: 480, y: 24 },
      { id: 'E', label: '동', x: 936, y: 270 },
      { id: 'S', label: '남', x: 480, y: 516 },
      { id: 'W', label: '서', x: 24,  y: 270 },
    ],
    // 기본 그림자 배치 제한 (추출 그림자는 맵 범위만 검사)
    placement: {
      coreClear: 70,     // 거점 중심 70px 이내 불가
      spawnClear: 50,    // 적 출현 지점 50px 이내 불가
      edgeClear: 20,     // 맵 경계 20px 이내 불가
      basicSpacing: 35,  // 기존 기본 그림자 35px 이내 불가
    },
    unitMargin: 12,      // 움직이는 유닛이 맵 경계 안쪽에 머무는 여백
  },

  // 기본 소환 그림자: 원하는 위치에 배치하는 고정형 방어 병력
  shadows: [
    { id: 'SH_001', name: '아이언',   role: 'tank',   cost: 30, maxHp: 300, attack: 20, attackInterval: 1.5, attackRange: 100, targetType: 'single',       color: '#4f86ff' },
    { id: 'SH_002', name: '이그리트', role: 'damage', cost: 50, maxHp: 150, attack: 65, attackInterval: 1.0, attackRange: 120, targetType: 'single',       color: '#a66bff' },
    { id: 'SH_003', name: '탱크',     role: 'area',   cost: 40, maxHp: 220, attack: 35, attackInterval: 2.0, attackRange: 110, targetType: 'all_in_range', color: '#2ec4b6' },
  ],

  enemies: [
    { id: 'EN_001', name: '일반형',   maxHp: 100, attack: 15, moveSpeed: 35, attackInterval: 2.0, attackRange: 45, baseDamage: 1, radius: 14, color: '#d99a3e' },
    { id: 'EN_002', name: '돌격형',   maxHp: 70,  attack: 12, moveSpeed: 65, attackInterval: 1.5, attackRange: 45, baseDamage: 1, radius: 12, color: '#ff5d73' },
    { id: 'EN_003', name: '중장갑형', maxHp: 260, attack: 30, moveSpeed: 20, attackInterval: 2.5, attackRange: 45, baseDamage: 2, radius: 18, color: '#b07a5a' },
  ],

  // 그림자 추출: 적 사망 위치에 잔영 생성 → 플레이어가 선택·에너지 지불 → 자동 추적형 그림자
  extraction: {
    remnantChance: 1.0,     // 잔영 생성 확률 (1.0 = 100%)
    remnantDuration: 12,    // 잔영 지속 시간(초). 전투 중에만 줄어듦
    detectionRadius: 180,   // 그림자 기준 적 탐색 반경
    maxRoamRadius: 220,     // 생성 위치(origin) 기준 최대 이동 반경
    returnThreshold: 20,    // 추격 대상이 없고 원점에서 이만큼 떨어지면 복귀
    spawnDelay: 0.5,        // 추출 직후 행동 시작까지(초)
    units: [
      { sourceEnemyId: 'EN_001', cost: 10, maxHp: 80,  attack: 23, moveSpeed: 55, attackRange: 35, attackInterval: 1.5 },
      { sourceEnemyId: 'EN_002', cost: 15, maxHp: 56,  attack: 18, moveSpeed: 90, attackRange: 35, attackInterval: 1.2 },
      { sourceEnemyId: 'EN_003', cost: 25, maxHp: 208, attack: 45, moveSpeed: 35, attackRange: 35, attackInterval: 2.0 },
    ],
  },

  // 적은 배열 순서대로 spawnInterval 간격으로 생성됩니다 (첫 적은 웨이브 시작 즉시).
  // 북·남 출현 지점은 거점과 가까워(약 185px) 동·서(약 395px)보다 빨리 도착합니다.
  waves: [
    { waveId: 1, spawnInterval: 2.5, enemies: [
      { enemyId: 'EN_001', spawn: 3 }, { enemyId: 'EN_001', spawn: 1 }, { enemyId: 'EN_001', spawn: 3 },
      { enemyId: 'EN_001', spawn: 1 }, { enemyId: 'EN_001', spawn: 0 }, { enemyId: 'EN_001', spawn: 2 },
    ] },
    { waveId: 2, spawnInterval: 2.2, enemies: [
      { enemyId: 'EN_001', spawn: 3 }, { enemyId: 'EN_001', spawn: 1 }, { enemyId: 'EN_002', spawn: 0 },
      { enemyId: 'EN_001', spawn: 3 }, { enemyId: 'EN_001', spawn: 2 }, { enemyId: 'EN_002', spawn: 1 },
      { enemyId: 'EN_001', spawn: 3 }, { enemyId: 'EN_002', spawn: 2 },
    ] },
    { waveId: 3, spawnInterval: 2.0, enemies: [
      { enemyId: 'EN_001', spawn: 1 }, { enemyId: 'EN_002', spawn: 3 }, { enemyId: 'EN_001', spawn: 0 },
      { enemyId: 'EN_003', spawn: 3 }, { enemyId: 'EN_001', spawn: 2 }, { enemyId: 'EN_002', spawn: 1 },
      { enemyId: 'EN_001', spawn: 3 }, { enemyId: 'EN_002', spawn: 0 }, { enemyId: 'EN_001', spawn: 1 },
      { enemyId: 'EN_001', spawn: 2 },
    ] },
    { waveId: 4, spawnInterval: 1.8, enemies: [
      { enemyId: 'EN_001', spawn: 3 }, { enemyId: 'EN_001', spawn: 1 }, { enemyId: 'EN_002', spawn: 0 },
      { enemyId: 'EN_003', spawn: 1 }, { enemyId: 'EN_002', spawn: 2 }, { enemyId: 'EN_001', spawn: 3 },
      { enemyId: 'EN_001', spawn: 0 }, { enemyId: 'EN_003', spawn: 3 }, { enemyId: 'EN_002', spawn: 1 },
      { enemyId: 'EN_001', spawn: 2 }, { enemyId: 'EN_002', spawn: 3 }, { enemyId: 'EN_001', spawn: 1 },
    ] },
    { waveId: 5, spawnInterval: 1.6, enemies: [
      { enemyId: 'EN_001', spawn: 3 }, { enemyId: 'EN_001', spawn: 1 }, { enemyId: 'EN_002', spawn: 0 },
      { enemyId: 'EN_002', spawn: 2 }, { enemyId: 'EN_003', spawn: 3 }, { enemyId: 'EN_001', spawn: 1 },
      { enemyId: 'EN_001', spawn: 0 }, { enemyId: 'EN_003', spawn: 1 }, { enemyId: 'EN_002', spawn: 3 },
      { enemyId: 'EN_001', spawn: 2 }, { enemyId: 'EN_002', spawn: 1 }, { enemyId: 'EN_003', spawn: 0 },
      { enemyId: 'EN_001', spawn: 3 }, { enemyId: 'EN_002', spawn: 2 }, { enemyId: 'EN_001', spawn: 1 },
    ] },
  ],
};


/* ==================================================================
 * [2] 상수 / 상태
 * ================================================================== */
const STATUS = Object.freeze({
  READY: 'READY',             // 타이틀 화면
  PREPARATION: 'PREPARATION', // 병력 배치 (전투 정지)
  PLAYING: 'PLAYING',         // 전투 진행
  PAUSED: 'PAUSED',           // 일시정지 (다음 작업)
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

// 추출 그림자 AI 상태 (기획서 3-1). RETURN은 원점 복귀 이동 구간
const AI = Object.freeze({
  SPAWN: 'SPAWN', IDLE: 'IDLE', CHASE: 'CHASE', ATTACK: 'ATTACK', RETURN: 'RETURN', DEAD: 'DEAD',
});

// 실패 사유 → 화면 메시지
const REASON_TEXT = Object.freeze({
  INVALID_STATUS:    '지금은 할 수 없습니다.',
  NO_SELECTION:      '소환할 그림자를 먼저 선택하세요.',
  INVALID_SHADOW:    '알 수 없는 그림자입니다.',
  BASIC_FULL:        `기본 그림자는 최대 ${GAME_DATA.config.maxBasic}기까지 배치할 수 있습니다.`,
  ARMY_FULL:         `군단이 가득 찼습니다 (최대 ${GAME_DATA.config.maxArmy}기).`,
  NOT_ENOUGH_ENERGY: '그림자 에너지가 부족합니다.',
  // 배치 제한
  PLACE_EDGE:        '전장 가장자리에는 배치할 수 없습니다.',
  PLACE_CORE:        '거점과 너무 가깝습니다.',
  PLACE_SPAWN:       '적 출현 지점과 너무 가깝습니다.',
  PLACE_OVERLAP:     '다른 기본 그림자와 너무 가깝습니다.',
  // 회수
  RECALL_NOT_PREP:   '전투 중에는 회수할 수 없습니다.',
  RECALL_LOCKED:     '이전 웨이브에서 싸운 그림자는 회수할 수 없습니다.',
  RECALL_EMPTY:      '회수할 그림자가 없습니다.',
  // 추출
  EXTRACT_GONE:      '잔영이 사라졌습니다.',
  // 해체
  DISMANTLE_GONE:    '이미 사라진 그림자입니다.',
  UNIT_LOST:         '선택한 그림자가 쓰러졌습니다.',
});

const ROLE_TEXT = Object.freeze({ tank: '탱커', damage: '딜러', area: '광역' });
const AI_TEXT = Object.freeze({ SPAWN: '추출 중', IDLE: '대기', CHASE: '추격', ATTACK: '공격', RETURN: '복귀', DEAD: '사망' });

function createInitialState() {
  const c = GAME_DATA.config;
  return {
    status: STATUS.READY,
    previousStatus: null,
    wave: 1,
    energy: c.startEnergy,
    maxEnergy: c.maxEnergy,
    coreHp: c.coreHp,
    maxCoreHp: c.coreHp,
    selectedShadowId: null,   // 배치할 기본 그림자 카드
    selectedRemnantUid: null, // 추출 패널에 띄운 잔영
    selectedUnitUid: null,    // 상세 정보(해체) 패널에 띄운 그림자
    basicUnits: [],           // 기본 소환 그림자 (고정)
    extractedUnits: [],       // 추출 그림자 (자동 추적)
    enemies: [],
    remnants: [],
    effects: [],              // 공격 선 표시 (연출용, 게임 규칙에 영향 없음)
    events: [],               // 규칙 → UI 알림 (예: 선택한 잔영 만료). UI가 매 프레임 비움
    spawnIndex: 0,
    spawnTimer: 0,
    nextUid: 1,               // 전장 객체 고유 ID (종류 ID와 별개)
    elapsed: 0,
    stats: {
      kills: 0, waveKills: 0,
      extractionAttempts: 0, extractionSuccesses: 0,
      dismantles: 0, energyRefunded: 0,
      energySpent: 0, coreDamageTaken: 0,
    },
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
function findShadowData(id)     { return GAME_DATA.shadows.find((s) => s.id === id) || null; }
function findEnemyData(id)      { return GAME_DATA.enemies.find((e) => e.id === id) || null; }
function findExtractionData(id) { return GAME_DATA.extraction.units.find((u) => u.sourceEnemyId === id) || null; }
function getWaveData(waveNumber) { return GAME_DATA.waves[waveNumber - 1] || null; }

function dist(ax, ay, bx, by) { return Math.hypot(ax - bx, ay - by); }
function isFieldActive(state) { return state.status === STATUS.PREPARATION || state.status === STATUS.PLAYING; }

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
    if (target.aiState) target.aiState = AI.DEAD;
    return true;
  }
  return false;
}

function countBasic(state)     { return state.basicUnits.filter((u) => u.alive).length; }
function countExtracted(state) { return state.extractedUnits.filter((u) => u.alive).length; }
function countArmy(state)      { return countBasic(state) + countExtracted(state); }
function getAllShadows(state)  { return state.basicUnits.concat(state.extractedUnits); }

// 움직이는 유닛을 맵 안쪽으로 고정
function clampToField(unit) {
  const F = GAME_DATA.field;
  const m = F.unitMargin;
  unit.x = Math.max(m, Math.min(F.width - m, unit.x));
  unit.y = Math.max(m, Math.min(F.height - m, unit.y));
}

// (x, y)로 이동. stopDist 안쪽까지는 들어가지 않음
function moveToward(unit, tx, ty, maxStep, stopDist) {
  const d = dist(unit.x, unit.y, tx, ty);
  if (d <= stopDist || d === 0) return;
  const step = Math.min(maxStep, d - stopDist);
  unit.x += ((tx - unit.x) / d) * step;
  unit.y += ((ty - unit.y) / d) * step;
}

/* ---------- 기본 그림자: 자유 배치 / 회수 ---------- */

// 기본 그림자 배치 위치 검사. 문제가 없으면 null
function checkPlacement(state, x, y) {
  const F = GAME_DATA.field;
  const P = F.placement;
  if (x < P.edgeClear || x > F.width - P.edgeClear || y < P.edgeClear || y > F.height - P.edgeClear) return 'PLACE_EDGE';
  if (dist(x, y, F.core.x, F.core.y) <= P.coreClear) return 'PLACE_CORE';
  if (F.spawnPoints.some((sp) => dist(x, y, sp.x, sp.y) <= P.spawnClear)) return 'PLACE_SPAWN';
  if (state.basicUnits.some((u) => u.alive && dist(x, y, u.x, u.y) <= P.basicSpacing)) return 'PLACE_OVERLAP';
  return null;
}

function canSummon(state, shadowId, x, y) {
  if (!isFieldActive(state)) return { ok: false, reason: 'INVALID_STATUS' };
  if (!shadowId) return { ok: false, reason: 'NO_SELECTION' };
  const data = findShadowData(shadowId);
  if (!data) return { ok: false, reason: 'INVALID_SHADOW' };
  if (countBasic(state) >= GAME_DATA.config.maxBasic) return { ok: false, reason: 'BASIC_FULL' };
  if (countArmy(state) >= GAME_DATA.config.maxArmy) return { ok: false, reason: 'ARMY_FULL' };
  const placeError = checkPlacement(state, x, y);
  if (placeError) return { ok: false, reason: placeError };
  if (state.energy < data.cost) return { ok: false, reason: 'NOT_ENOUGH_ENERGY' };
  return { ok: true, data };
}

function summonShadow(state, shadowId, x, y) {
  const check = canSummon(state, shadowId, x, y);
  if (!check.ok) return check;
  const d = check.data;
  state.energy -= d.cost;
  state.stats.energySpent += d.cost;
  const unit = {
    uid: state.nextUid++,
    typeId: d.id,
    kind: 'basic',
    x, y,
    hp: d.maxHp,
    maxHp: d.maxHp,
    attack: d.attack,
    attackInterval: d.attackInterval,
    attackRange: d.attackRange,
    targetType: d.targetType,
    cooldown: 0,          // 생성 직후 첫 공격 가능
    alive: true,
    energyCostPaid: d.cost, // 실제 소비 에너지 → 회수·해체 반환 기준
    // 준비 단계에서 배치한 그림자만 회수 가능. 웨이브가 시작되면 false로 잠김
    recallable: state.status === STATUS.PREPARATION,
  };
  state.basicUnits.push(unit);
  return { ok: true, unit };
}

// (x, y)에 있는 기본 그림자 (그림자 사각형 안)
function getBasicAt(state, x, y) {
  let best = null;
  let bestDist = Infinity;
  for (const u of state.basicUnits) {
    if (!u.alive || Math.abs(u.x - x) > 17 || Math.abs(u.y - y) > 17) continue;
    const d = dist(x, y, u.x, u.y);
    if (d < bestDist) { best = u; bestDist = d; }
  }
  return best;
}

// 회수 규칙: 준비 단계 + 이번 준비 단계에서 배치한 기본 그림자만, 비용 × recallRefundRate 환불
function canRecall(state, unit) {
  if (!unit || !unit.alive) return { ok: false, reason: 'RECALL_EMPTY' };
  if (state.status !== STATUS.PREPARATION) return { ok: false, reason: 'RECALL_NOT_PREP' };
  if (!unit.recallable) return { ok: false, reason: 'RECALL_LOCKED' };
  return { ok: true, unit };
}

function recallShadow(state, unit) {
  const check = canRecall(state, unit);
  if (!check.ok) return check;
  const refund = Math.round(unit.energyCostPaid * GAME_DATA.config.recallRefundRate);
  unit.alive = false;
  state.basicUnits = state.basicUnits.filter((u) => u.uid !== unit.uid);
  if (state.selectedUnitUid === unit.uid) state.selectedUnitUid = null;
  addEnergy(state, refund);
  state.stats.energySpent -= refund;
  return { ok: true, unit, refund };
}

/* ---------- 그림자 해체 (SD-DISMANTLE) ---------- */

function findShadowUnit(state, uid) {
  if (uid === null || uid === undefined) return null;
  return getAllShadows(state).find((u) => u.uid === uid && u.alive) || null;
}

// (x, y)에 있는 그림자: 기본(사각형) 우선, 없으면 추출(원)
function getShadowAt(state, x, y) {
  const basic = getBasicAt(state, x, y);
  if (basic) return basic;
  let best = null;
  let bestDist = Infinity;
  for (const s of state.extractedUnits) {
    if (!s.alive) continue;
    const d = dist(x, y, s.x, s.y);
    if (d <= 16 && d < bestDist) { best = s; bestDist = d; }
  }
  return best;
}

// 반환 에너지 = round(실제 소비 에너지 × 0.5)  → 0.5 이상 올림
function calculateDismantleRefund(unit) {
  return Math.round(unit.energyCostPaid * GAME_DATA.config.dismantleRefundRate);
}

// 준비·전투 단계에서 살아 있는 모든 그림자(기본 + 추출) 해체 가능
function canDismantle(state, unitUid) {
  if (!isFieldActive(state)) return { ok: false, reason: 'INVALID_STATUS' };   // 일시정지·승리·패배 등 불가
  const unit = findShadowUnit(state, unitUid);
  if (!unit) return { ok: false, reason: 'DISMANTLE_GONE' };                  // 사망·이미 해체
  return { ok: true, unit, refund: calculateDismantleRefund(unit) };
}

// 확인 버튼을 누른 순간 다시 검사 → 그림자 제거 → 군단 슬롯 즉시 확보 → 에너지 반환(상한 150)
function dismantleShadow(state, unitUid) {
  const check = canDismantle(state, unitUid);
  if (!check.ok) return check;
  const { unit, refund } = check;
  unit.alive = false;
  if (unit.aiState) unit.aiState = AI.DEAD;
  state.basicUnits = state.basicUnits.filter((u) => u.uid !== unit.uid);
  state.extractedUnits = state.extractedUnits.filter((u) => u.uid !== unit.uid);
  if (state.selectedUnitUid === unit.uid) state.selectedUnitUid = null;
  // 이 그림자를 노리던 적은 다음 틱에 대상을 다시 찾음 (findEnemyTarget이 매 틱 재탐색)
  const before = state.energy;
  addEnergy(state, refund);
  const gained = state.energy - before;   // 상한에 걸리면 실제 반환량은 더 작음
  state.stats.dismantles += 1;
  state.stats.energyRefunded += gained;
  return { ok: true, unit, refund, gained };
}

/* ---------- 잔영 / 그림자 추출 ---------- */

function createRemnant(state, enemy) {
  const duration = GAME_DATA.extraction.remnantDuration;
  state.remnants.push({
    uid: state.nextUid++,
    sourceEnemyId: enemy.typeId,
    x: enemy.x,
    y: enemy.y,
    ttl: duration,
    duration,
  });
}

function findRemnant(state, uid) {
  if (uid === null || uid === undefined) return null;
  return state.remnants.find((r) => r.uid === uid && r.ttl > 0) || null;
}

function getRemnantAt(state, x, y) {
  let best = null;
  let bestDist = 16;
  for (const r of state.remnants) {
    if (r.ttl <= 0) continue;
    const d = dist(x, y, r.x, r.y);
    if (d <= bestDist) { best = r; bestDist = d; }
  }
  return best;
}

function canExtract(state, remnantUid) {
  if (!isFieldActive(state)) return { ok: false, reason: 'INVALID_STATUS' };
  const remnant = findRemnant(state, remnantUid);
  if (!remnant) return { ok: false, reason: 'EXTRACT_GONE' };   // 만료된 순간에는 추출 불가
  const data = findExtractionData(remnant.sourceEnemyId);
  if (!data) return { ok: false, reason: 'EXTRACT_GONE' };
  if (countArmy(state) >= GAME_DATA.config.maxArmy) return { ok: false, reason: 'ARMY_FULL', remnant, data };
  if (state.energy < data.cost) return { ok: false, reason: 'NOT_ENOUGH_ENERGY', remnant, data };
  return { ok: true, remnant, data };
}

// 실패 시 에너지를 차감하지 않고 잔영도 그대로 둠.
// 성공 시 잔영이 즉시 사라지므로 버튼을 연속으로 눌러도 그림자는 한 번만 생성됨
function extractShadow(state, remnantUid) {
  state.stats.extractionAttempts += 1;
  const check = canExtract(state, remnantUid);
  if (!check.ok) return check;
  const { remnant, data } = check;
  const ex = GAME_DATA.extraction;

  state.energy -= data.cost;
  state.stats.energySpent += data.cost;
  state.remnants = state.remnants.filter((r) => r.uid !== remnant.uid);
  if (state.selectedRemnantUid === remnant.uid) state.selectedRemnantUid = null;

  const unit = {
    uid: state.nextUid++,
    kind: 'extracted',
    sourceEnemyId: remnant.sourceEnemyId,
    aiState: AI.SPAWN,
    spawnTimer: ex.spawnDelay,
    x: remnant.x,
    y: remnant.y,
    originX: 0,
    originY: 0,
    hp: data.maxHp,
    maxHp: data.maxHp,
    attack: data.attack,
    moveSpeed: data.moveSpeed,
    attackRange: data.attackRange,
    attackInterval: data.attackInterval,
    detectionRadius: ex.detectionRadius,
    maxRoamRadius: ex.maxRoamRadius,
    targetId: null,
    cooldown: 0,
    alive: true,
    energyCostPaid: data.cost, // 실제 소비 에너지 → 해체 반환 기준
  };
  clampToField(unit);   // 추출 그림자는 배치 제한 없이 맵 범위만 검사
  unit.originX = unit.x;
  unit.originY = unit.y;
  state.extractedUnits.push(unit);
  state.stats.extractionSuccesses += 1;
  return { ok: true, unit, data };
}

/* ---------- 적 ---------- */

function createEnemy(state, enemyId, spawnIndex) {
  const d = findEnemyData(enemyId);
  const sp = GAME_DATA.field.spawnPoints[spawnIndex];
  return {
    uid: state.nextUid++,
    typeId: d.id,
    spawn: spawnIndex,
    x: sp.x,
    y: sp.y,
    radius: d.radius,
    hp: d.maxHp,
    maxHp: d.maxHp,
    attack: d.attack,
    moveSpeed: d.moveSpeed,
    attackInterval: d.attackInterval,
    attackRange: d.attackRange,
    baseDamage: d.baseDamage,
    cooldown: 0,
    alive: true,
    reachedCore: false,
    moving: true,
  };
}

/* ---------- 대상 탐색 ---------- */

// 기본 그림자: 사거리 내 적 중 거점에 가장 가까운 적 → 동률이면 먼저 생성된 적
function findBasicTargets(state, unit) {
  const core = GAME_DATA.field.core;
  const inRange = state.enemies.filter((e) => e.alive && dist(e.x, e.y, unit.x, unit.y) <= unit.attackRange);
  if (inRange.length === 0) return [];
  inRange.sort((a, b) => (dist(a.x, a.y, core.x, core.y) - dist(b.x, b.y, core.x, core.y)) || (a.uid - b.uid));
  return unit.targetType === 'all_in_range' ? inRange : [inRange[0]];
}

// 적: 사거리 내 가장 가까운 그림자(기본·추출) → 동률이면 먼저 생성된 그림자
function findEnemyTarget(state, enemy) {
  let best = null;
  let bestDist = Infinity;
  for (const s of getAllShadows(state)) {
    if (!s.alive) continue;
    const d = dist(enemy.x, enemy.y, s.x, s.y);
    if (d > enemy.attackRange) continue;
    if (d < bestDist || (d === bestDist && s.uid < best.uid)) {
      best = s;
      bestDist = d;
    }
  }
  return best;
}

// 추출 그림자가 이 적을 쫓을 수 있는가:
//  - 그림자 기준 탐색 반경 안
//  - 적이 이동 제한 범위(원점 기준 maxRoamRadius) + 공격 사거리 안 → 범위 밖으로 나가면 추격 중단
function canChase(shadow, enemy) {
  if (!enemy || !enemy.alive) return false;
  if (dist(shadow.x, shadow.y, enemy.x, enemy.y) > shadow.detectionRadius) return false;
  return dist(shadow.originX, shadow.originY, enemy.x, enemy.y) <= shadow.maxRoamRadius + shadow.attackRange;
}

// 추격 대상: 쫓을 수 있는 적 중 가장 가까운 적 → 동률이면 생성 ID가 빠른 적
function findChaseTarget(state, shadow) {
  let best = null;
  let bestDist = Infinity;
  for (const e of state.enemies) {
    if (!canChase(shadow, e)) continue;
    const d = dist(shadow.x, shadow.y, e.x, e.y);
    if (d < bestDist || (d === bestDist && e.uid < best.uid)) {
      best = e;
      bestDist = d;
    }
  }
  return best;
}

/* ---------- 웨이브 ---------- */

function startWave(state) {
  if (state.status !== STATUS.PREPARATION) return false;
  if (!getWaveData(state.wave)) return false;
  if (state.wave >= 2) addEnergy(state, GAME_DATA.config.waveStartBonus);
  for (const u of state.basicUnits) u.recallable = false;   // 전투에 들어간 그림자는 회수 잠금
  state.spawnIndex = 0;
  state.spawnTimer = 0;   // 첫 적은 즉시 생성
  state.stats.waveKills = 0;
  return setStatus(state, STATUS.PLAYING);
}

// WAVE_CLEAR → 다음 웨이브 PREPARATION
// 추출 그림자는 HP 0 또는 게임 종료까지 유지. 남은 잔영은 준비 단계에서도 추출 가능(타이머는 전투 중에만 감소)
function goToNextWave(state) {
  if (state.status !== STATUS.WAVE_CLEAR) return false;
  state.wave += 1;
  return setStatus(state, STATUS.PREPARATION);
}


/* ==================================================================
 * [4] 전투 틱
 *  사망한 객체는 반복 도중 바로 지우지 않고 alive=false로 표시한 뒤
 *  틱 마지막에 한꺼번에 제거합니다.
 *  일시정지·준비 단계에서는 이 함수가 아무것도 하지 않으므로
 *  이동, 공격, 잔영 타이머가 모두 멈춥니다.
 * ================================================================== */
function updateGame(state, dt) {
  if (state.status !== STATUS.PLAYING) return;
  state.elapsed += dt;

  updateSpawning(state, dt);              // 1. 적 생성
  updateRemnants(state, dt);              // 2. 잔영 시간 갱신
  updateEnemyMovement(state, dt);         // 3. 적 이동 / 거점 도달
  if (state.coreHp <= 0) {                //    거점 HP 0 → 즉시 패배
    cleanupDead(state);
    state.selectedRemnantUid = null;
    setStatus(state, STATUS.DEFEAT);
    return;
  }
  updateExtractedAI(state, dt);           // 4. 추출 그림자 탐색 / 추격 / 복귀
  updateCooldowns(state, dt);             // 5. 쿨타임
  const killed = processShadowAttacks(state); // 6. 그림자 공격 (기본 + 추출)
  processEnemyAttacks(state);             //    적 공격 (이번 틱에 죽은 적은 공격하지 않음)
  for (const enemy of killed) {           // 7. 처치 보상 + 잔영 생성 (사망 1회당 1번)
    state.stats.kills += 1;
    state.stats.waveKills += 1;
    addEnergy(state, GAME_DATA.config.killReward);
    if (Math.random() < GAME_DATA.extraction.remnantChance) createRemnant(state, enemy);
  }
  cleanupDead(state);                     // 8. 사망 객체 일괄 제거
  updateEffects(state, dt);
  checkWaveComplete(state);               // 9. 웨이브 완료 판정
}

function updateSpawning(state, dt) {
  const wave = getWaveData(state.wave);
  if (!wave || state.spawnIndex >= wave.enemies.length) return;
  state.spawnTimer -= dt;
  while (state.spawnTimer <= 0 && state.spawnIndex < wave.enemies.length) {
    const entry = wave.enemies[state.spawnIndex];
    state.enemies.push(createEnemy(state, entry.enemyId, entry.spawn));
    state.spawnIndex += 1;
    state.spawnTimer += wave.spawnInterval;
  }
}

function updateRemnants(state, dt) {
  for (const r of state.remnants) r.ttl -= dt;
  const before = state.selectedRemnantUid;
  state.remnants = state.remnants.filter((r) => r.ttl > 0);
  if (before !== null && !findRemnant(state, before)) {
    state.selectedRemnantUid = null;
    state.events.push('REMNANT_EXPIRED');
  }
}

function updateEnemyMovement(state, dt) {
  const core = GAME_DATA.field.core;
  for (const e of state.enemies) {
    if (!e.alive) continue;
    e.moving = !findEnemyTarget(state, e);   // 사거리 안에 그림자가 있으면 멈추고 공격
    if (!e.moving) continue;
    moveToward(e, core.x, core.y, e.moveSpeed * dt, 0);
    if (dist(e.x, e.y, core.x, core.y) <= core.radius + e.radius) {
      e.alive = false;                // 처치가 아니므로 보상·잔영 없음
      e.reachedCore = true;
      state.coreHp = Math.max(0, state.coreHp - e.baseDamage);
      state.stats.coreDamageTaken += e.baseDamage;
    }
  }
}

// 추출 그림자 AI: SPAWN → IDLE → CHASE → ATTACK → (대상 사망) → IDLE / RETURN
function updateExtractedAI(state, dt) {
  const ex = GAME_DATA.extraction;
  for (const s of state.extractedUnits) {
    if (!s.alive) continue;

    if (s.aiState === AI.SPAWN) {
      s.spawnTimer -= dt;
      if (s.spawnTimer > 0) continue;
      s.aiState = AI.IDLE;
    }

    // 현재 대상이 사라졌거나 범위를 벗어나면 즉시 새 대상 탐색
    let target = s.targetId === null ? null : state.enemies.find((e) => e.uid === s.targetId);
    if (!canChase(s, target)) target = findChaseTarget(state, s);
    s.targetId = target ? target.uid : null;

    if (target) {
      if (dist(s.x, s.y, target.x, target.y) <= s.attackRange) {
        s.aiState = AI.ATTACK;
        continue;
      }
      s.aiState = AI.CHASE;
      moveToward(s, target.x, target.y, s.moveSpeed * dt, s.attackRange * 0.9);
      clampToRoam(s);
      clampToField(s);
      continue;
    }

    // 추격할 적이 없음: 원점에서 멀면 복귀, 아니면 대기
    const fromOrigin = dist(s.x, s.y, s.originX, s.originY);
    if (s.aiState === AI.RETURN || fromOrigin > ex.returnThreshold) {
      s.aiState = AI.RETURN;
      moveToward(s, s.originX, s.originY, s.moveSpeed * dt, 0);
      if (dist(s.x, s.y, s.originX, s.originY) < 0.5) {
        s.x = s.originX;
        s.y = s.originY;
        s.aiState = AI.IDLE;
      }
    } else {
      s.aiState = AI.IDLE;
    }
  }
}

// 원점 기준 maxRoamRadius 밖으로 나가지 않도록
function clampToRoam(s) {
  const d = dist(s.x, s.y, s.originX, s.originY);
  if (d <= s.maxRoamRadius) return;
  s.x = s.originX + ((s.x - s.originX) / d) * s.maxRoamRadius;
  s.y = s.originY + ((s.y - s.originY) / d) * s.maxRoamRadius;
}

function updateCooldowns(state, dt) {
  for (const u of getAllShadows(state)) if (u.alive) u.cooldown = Math.max(0, u.cooldown - dt);
  for (const e of state.enemies) if (e.alive) e.cooldown = Math.max(0, e.cooldown - dt);
}

function processShadowAttacks(state) {
  const killed = [];
  // 기본 그림자: 제자리에서 사거리 내 적 공격
  for (const u of state.basicUnits) {
    if (!u.alive || u.cooldown > 0) continue;
    const targets = findBasicTargets(state, u);
    if (targets.length === 0) continue;   // 대상이 없으면 쿨타임 0 유지 → 대상이 오면 즉시 공격
    const dmg = calcDamage(u.attack);
    for (const t of targets) {
      if (applyDamage(t, dmg)) killed.push(t);
      addEffect(state, u.x, u.y, t.x, t.y, 'shadow');
    }
    u.cooldown = u.attackInterval;
  }
  // 추출 그림자: ATTACK 상태일 때 추격 대상 공격
  for (const s of state.extractedUnits) {
    if (!s.alive || s.aiState !== AI.ATTACK || s.cooldown > 0) continue;
    const t = state.enemies.find((e) => e.uid === s.targetId);
    if (!t || !t.alive || dist(s.x, s.y, t.x, t.y) > s.attackRange) continue;
    if (applyDamage(t, calcDamage(s.attack))) killed.push(t);   // 추출 그림자의 처치도 잔영 생성
    addEffect(state, s.x, s.y, t.x, t.y, 'extracted');
    s.cooldown = s.attackInterval;
  }
  return killed;
}

function processEnemyAttacks(state) {
  for (const e of state.enemies) {
    if (!e.alive || e.cooldown > 0) continue;
    const target = findEnemyTarget(state, e);   // 매번 다시 찾음 → 이미 죽은 그림자 공격 방지
    if (!target) continue;
    applyDamage(target, calcDamage(e.attack));
    addEffect(state, e.x, e.y, target.x, target.y, 'enemy');
    e.cooldown = e.attackInterval;
  }
}

function cleanupDead(state) {
  state.enemies = state.enemies.filter((e) => e.alive);
  state.basicUnits = state.basicUnits.filter((u) => u.alive);
  state.extractedUnits = state.extractedUnits.filter((u) => u.alive);
  // 상세 패널(해체 확인 포함)을 띄운 그림자가 쓰러지면 선택 해제. 사망 시 반환 없음
  if (state.selectedUnitUid !== null && !findShadowUnit(state, state.selectedUnitUid)) {
    state.selectedUnitUid = null;
    state.events.push('UNIT_LOST');
  }
}

function checkWaveComplete(state) {
  const wave = getWaveData(state.wave);
  if (!wave) return;
  if (state.spawnIndex < wave.enemies.length || state.enemies.length > 0) return;
  const isLast = state.wave >= GAME_DATA.waves.length;
  if (isLast) state.selectedRemnantUid = null;
  setStatus(state, isLast ? STATUS.VICTORY : STATUS.WAVE_CLEAR);
}

function addEffect(state, x1, y1, x2, y2, kind) {
  state.effects.push({ x1, y1, x2, y2, kind, ttl: 0.12 });
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
  const F = data.field;
  if (!isPos(c.startEnergy) || !isPos(c.maxEnergy)) errors.push('config: startEnergy / maxEnergy는 0보다 큰 숫자여야 합니다.');
  if (c.startEnergy > c.maxEnergy) errors.push('config: startEnergy가 maxEnergy보다 큽니다.');
  if (!isPos(c.coreHp)) errors.push('config: coreHp는 0보다 큰 숫자여야 합니다.');
  if (!Number.isInteger(c.maxArmy) || c.maxArmy < 1) errors.push('config: maxArmy는 1 이상의 정수여야 합니다.');
  if (!Number.isInteger(c.maxBasic) || c.maxBasic < 1 || c.maxBasic > c.maxArmy) errors.push('config: maxBasic은 1 이상, maxArmy 이하의 정수여야 합니다.');
  if (typeof c.recallRefundRate !== 'number' || c.recallRefundRate < 0 || c.recallRefundRate > 1) errors.push('config: recallRefundRate는 0~1 사이 숫자여야 합니다.');
  if (typeof c.dismantleRefundRate !== 'number' || c.dismantleRefundRate < 0 || c.dismantleRefundRate > 1) errors.push('config: dismantleRefundRate는 0~1 사이 숫자여야 합니다.');

  if (!isPos(F.width) || !isPos(F.height)) errors.push('field: width / height가 올바르지 않습니다.');
  if (!F.core || !isPos(F.core.radius)) errors.push('field: core.radius가 올바르지 않습니다.');
  if (!F.spawnPoints.length) errors.push('field: spawnPoints가 비어 있습니다.');
  F.spawnPoints.forEach((sp, i) => {
    if (!(sp.x >= 0 && sp.x <= F.width && sp.y >= 0 && sp.y <= F.height)) errors.push(`field.spawnPoints[${i}]: 맵 밖 좌표입니다.`);
  });

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
    for (const k of ['maxHp', 'attack', 'moveSpeed', 'attackInterval', 'attackRange', 'baseDamage', 'radius']) {
      if (!isPos(e[k])) errors.push(`enemies ${e.id}: ${k} 값이 올바르지 않습니다 (${e[k]}).`);
    }
  }

  const ex = data.extraction;
  if (typeof ex.remnantChance !== 'number' || ex.remnantChance < 0 || ex.remnantChance > 1) errors.push('extraction: remnantChance는 0~1 사이 숫자여야 합니다.');
  for (const k of ['remnantDuration', 'detectionRadius', 'maxRoamRadius', 'returnThreshold']) {
    if (!isPos(ex[k])) errors.push(`extraction: ${k} 값이 올바르지 않습니다 (${ex[k]}).`);
  }
  for (const e of data.enemies) {
    if (!ex.units.some((u) => u.sourceEnemyId === e.id)) errors.push(`extraction.units: ${e.id}의 추출 데이터가 없습니다.`);
  }
  for (const u of ex.units) {
    if (!data.enemies.some((e) => e.id === u.sourceEnemyId)) errors.push(`extraction.units: 없는 적 ID ${u.sourceEnemyId}`);
    for (const k of ['cost', 'maxHp', 'attack', 'moveSpeed', 'attackRange', 'attackInterval']) {
      if (!isPos(u[k])) errors.push(`extraction.units ${u.sourceEnemyId}: ${k} 값이 올바르지 않습니다 (${u[k]}).`);
    }
  }

  if (!data.waves.length) errors.push('waves: 웨이브가 없습니다.');
  data.waves.forEach((w, i) => {
    if (!isPos(w.spawnInterval)) errors.push(`waves[${i}]: spawnInterval 값이 올바르지 않습니다.`);
    if (!w.enemies.length) errors.push(`waves[${i}]: 적이 없습니다.`);
    w.enemies.forEach((en, j) => {
      if (!data.enemies.some((d) => d.id === en.enemyId)) errors.push(`waves[${i}].enemies[${j}]: 없는 적 ID ${en.enemyId}`);
      if (!Number.isInteger(en.spawn) || en.spawn < 0 || en.spawn >= F.spawnPoints.length) errors.push(`waves[${i}].enemies[${j}]: spawn은 0~${F.spawnPoints.length - 1} 사이여야 합니다.`);
    });
  });
  return errors;
}


/* ==================================================================
 * [5] 렌더링 (Canvas) — 게임 규칙을 바꾸지 않고 그리기만 함
 * ================================================================== */
const COLORS = {
  bg: '#0b0d17', grid: 'rgba(255,255,255,0.03)', arena: '#11152a', arenaLine: '#262d4b',
  core: '#1d1233', coreLine: '#8b6cff', coreHp: '#3ddc97', coreHpLow: '#ff5c7a',
  spawn: '#ff5c7a', noZone: 'rgba(255,92,122,0.09)', noZoneLine: 'rgba(255,92,122,0.35)',
  ghostOk: '#3ddc97', ghostBad: '#ff5c7a', recall: '#ffcf5c',
  remnant: '#7b5cff', remnantRing: '#c9b8ff', selected: '#ffffff',
  extracted: '#241a46', extractedLine: '#a98bff',
  text: '#e6e8f2', subText: '#8b91b0', hpBack: 'rgba(0,0,0,0.6)',
  hpShadow: '#7cc4ff', hpExtracted: '#c3b2ff', hpEnemy: '#ff6b6b',
  fxShadow: '#9fd0ff', fxExtracted: '#c9b8ff', fxEnemy: '#ff9a6b',
  range: 'rgba(124,196,255,0.10)', rangeLine: 'rgba(124,196,255,0.35)',
  detect: 'rgba(185,166,255,0.45)', roam: 'rgba(185,166,255,0.06)', rangeEnemy: 'rgba(255,107,107,0.35)',
};

function drawCircle(ctx, x, y, r) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
}

function drawHpBar(ctx, cx, top, width, ratio, color) {
  ctx.fillStyle = COLORS.hpBack;
  ctx.fillRect(cx - width / 2, top, width, 4);
  ctx.fillStyle = color;
  ctx.fillRect(cx - width / 2, top, width * Math.max(0, Math.min(1, ratio)), 4);
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

function drawLabel(ctx, text, x, y, color, font) {
  ctx.fillStyle = color;
  ctx.font = font || '11px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x, y);
}

function render(ctx, state, view) {
  const F = GAME_DATA.field;
  const core = F.core;
  const P = F.placement;
  const placing = !!state.selectedShadowId && isFieldActive(state);

  // 배경 + 격자
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, F.width, F.height);
  ctx.strokeStyle = COLORS.grid;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 40; x < F.width; x += 40) { ctx.moveTo(x, 0); ctx.lineTo(x, F.height); }
  for (let y = 30; y < F.height; y += 40) { ctx.moveTo(0, y); ctx.lineTo(F.width, y); }
  ctx.stroke();

  // 원형 전장 디자인 (판정은 직사각형 전장 전체)
  ctx.fillStyle = COLORS.arena;
  drawCircle(ctx, core.x, core.y, 250); ctx.fill();
  ctx.strokeStyle = COLORS.arenaLine;
  ctx.stroke();
  ctx.setLineDash([6, 8]);
  drawCircle(ctx, core.x, core.y, 150); ctx.stroke();
  ctx.setLineDash([]);

  // 배치 불가 구역 (카드 선택 중에만)
  if (placing) {
    ctx.fillStyle = COLORS.noZone;
    ctx.fillRect(0, 0, F.width, P.edgeClear);
    ctx.fillRect(0, F.height - P.edgeClear, F.width, P.edgeClear);
    ctx.fillRect(0, P.edgeClear, P.edgeClear, F.height - P.edgeClear * 2);
    ctx.fillRect(F.width - P.edgeClear, P.edgeClear, P.edgeClear, F.height - P.edgeClear * 2);
    ctx.strokeStyle = COLORS.noZoneLine;
    const zones = [{ x: core.x, y: core.y, r: P.coreClear }]
      .concat(F.spawnPoints.map((sp) => ({ x: sp.x, y: sp.y, r: P.spawnClear })))
      .concat(state.basicUnits.filter((u) => u.alive).map((u) => ({ x: u.x, y: u.y, r: P.basicSpacing })));
    for (const z of zones) {
      drawCircle(ctx, z.x, z.y, z.r);
      ctx.fill();
      ctx.stroke();
    }
  }

  // 적 출현 지점
  F.spawnPoints.forEach((sp) => {
    ctx.strokeStyle = COLORS.spawn;
    ctx.setLineDash([4, 4]);
    drawCircle(ctx, sp.x, sp.y, 14); ctx.stroke();
    ctx.setLineDash([]);
    const lx = sp.x + (sp.x < 100 ? 30 : sp.x > F.width - 100 ? -30 : 0);
    const ly = sp.y + (sp.y < 100 ? 26 : sp.y > F.height - 100 ? -26 : 0);
    drawLabel(ctx, sp.label, lx, ly, COLORS.spawn, 'bold 12px sans-serif');
  });

  // 중앙 거점 + HP 링
  const hpRatio = state.coreHp / state.maxCoreHp;
  ctx.fillStyle = COLORS.core;
  drawCircle(ctx, core.x, core.y, core.radius); ctx.fill();
  ctx.strokeStyle = COLORS.coreLine;
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.lineWidth = 5;
  ctx.strokeStyle = hpRatio <= 0.3 ? COLORS.coreHpLow : COLORS.coreHp;
  ctx.beginPath();
  ctx.arc(core.x, core.y, core.radius + 7, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * hpRatio);
  ctx.stroke();
  ctx.lineWidth = 1;
  drawLabel(ctx, '거점', core.x, core.y - 8, COLORS.coreLine, 'bold 14px sans-serif');
  drawLabel(ctx, `${state.coreHp} / ${state.maxCoreHp}`, core.x, core.y + 10, COLORS.text, '12px sans-serif');

  // 범위 표시 (D 키)
  if (view.showRanges) {
    for (const u of state.basicUnits) {
      ctx.fillStyle = COLORS.range;
      ctx.strokeStyle = COLORS.rangeLine;
      drawCircle(ctx, u.x, u.y, u.attackRange); ctx.fill(); ctx.stroke();
    }
    for (const s of state.extractedUnits) {
      ctx.fillStyle = COLORS.roam;
      drawCircle(ctx, s.originX, s.originY, s.maxRoamRadius); ctx.fill();
      ctx.strokeStyle = COLORS.detect;
      ctx.setLineDash([3, 5]);
      drawCircle(ctx, s.x, s.y, s.detectionRadius); ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(s.originX - 4, s.originY); ctx.lineTo(s.originX + 4, s.originY);
      ctx.moveTo(s.originX, s.originY - 4); ctx.lineTo(s.originX, s.originY + 4);
      ctx.stroke();
      drawLabel(ctx, s.aiState, s.x, s.y + 26, COLORS.hpExtracted, '9px monospace');
    }
    for (const e of state.enemies) {
      ctx.strokeStyle = COLORS.rangeEnemy;
      drawCircle(ctx, e.x, e.y, e.attackRange); ctx.stroke();
    }
  }

  // 잔영
  for (const r of state.remnants) {
    const pulse = 0.55 + 0.25 * Math.sin(view.time * 5 + r.uid);
    const isSelected = state.selectedRemnantUid === r.uid;
    const isHover = view.hoverRemnantUid === r.uid;
    ctx.globalAlpha = pulse;
    ctx.fillStyle = COLORS.remnant;
    drawCircle(ctx, r.x, r.y, 9); ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = COLORS.remnantRing;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(r.x, r.y, 13, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * (r.ttl / r.duration));
    ctx.stroke();
    if (isSelected || isHover) {
      ctx.strokeStyle = isSelected ? COLORS.selected : COLORS.remnantRing;
      ctx.lineWidth = isSelected ? 2 : 1;
      drawCircle(ctx, r.x, r.y, 18); ctx.stroke();
    }
    ctx.lineWidth = 1;
  }

  // 기본 그림자
  for (const u of state.basicUnits) {
    const d = findShadowData(u.typeId);
    ctx.fillStyle = d ? d.color : '#888';
    drawRoundRect(ctx, u.x - 15, u.y - 15, 30, 30, 7);
    ctx.fill();
    if (state.selectedUnitUid === u.uid) {
      ctx.strokeStyle = COLORS.selected;   // 상세 패널을 띄운 그림자
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.lineWidth = 1;
    } else if (view.hoverUnitUid === u.uid && canRecall(state, u).ok) {
      ctx.strokeStyle = COLORS.recall;   // 회수 가능한 그림자에 마우스를 올리면 노란 테두리
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.lineWidth = 1;
    }
    drawLabel(ctx, d ? d.name[0] : '?', u.x, u.y + 1, '#fff', 'bold 14px sans-serif');
    drawLabel(ctx, d ? d.name : '', u.x, u.y + 26, COLORS.text);
    drawHpBar(ctx, u.x, u.y - 24, 34, u.hp / u.maxHp, COLORS.hpShadow);
  }

  // 추출 그림자
  for (const s of state.extractedUnits) {
    const src = findEnemyData(s.sourceEnemyId);
    const r = Math.round((src ? src.radius : 14) * 0.9);
    const spawnRatio = s.aiState === AI.SPAWN ? 1 - s.spawnTimer / GAME_DATA.extraction.spawnDelay : 1;
    ctx.globalAlpha = 0.35 + 0.65 * Math.max(0, Math.min(1, spawnRatio));
    ctx.save();
    ctx.shadowColor = COLORS.extractedLine;
    ctx.shadowBlur = 10;
    ctx.fillStyle = COLORS.extracted;
    drawCircle(ctx, s.x, s.y, r); ctx.fill();
    ctx.restore();
    ctx.strokeStyle = COLORS.extractedLine;
    ctx.lineWidth = 2;
    drawCircle(ctx, s.x, s.y, r); ctx.stroke();
    ctx.lineWidth = 1;
    drawLabel(ctx, src ? src.name[0] : '?', s.x, s.y + 1, COLORS.hpExtracted, 'bold 12px sans-serif');
    ctx.globalAlpha = 1;
    if (state.selectedUnitUid === s.uid || view.hoverUnitUid === s.uid) {
      ctx.strokeStyle = state.selectedUnitUid === s.uid ? COLORS.selected : COLORS.remnantRing;
      ctx.lineWidth = state.selectedUnitUid === s.uid ? 2 : 1;
      drawCircle(ctx, s.x, s.y, r + 5); ctx.stroke();
      ctx.lineWidth = 1;
    }
    drawHpBar(ctx, s.x, s.y - r - 9, 28, s.hp / s.maxHp, COLORS.hpExtracted);
  }

  // 적
  for (const e of state.enemies) {
    const d = findEnemyData(e.typeId);
    ctx.fillStyle = d.color;
    drawCircle(ctx, e.x, e.y, e.radius); ctx.fill();
    ctx.strokeStyle = e.moving ? 'rgba(0,0,0,0.4)' : '#ffffff';   // 멈춰서 싸우는 중이면 흰 테두리
    ctx.lineWidth = e.moving ? 1 : 2;
    ctx.stroke();
    ctx.lineWidth = 1;
    drawLabel(ctx, d.name, e.x, e.y + e.radius + 10, COLORS.text, '10px sans-serif');
    drawHpBar(ctx, e.x, e.y - e.radius - 9, 30, e.hp / e.maxHp, COLORS.hpEnemy);
  }

  // 공격 선
  for (const fx of state.effects) {
    ctx.strokeStyle = fx.kind === 'shadow' ? COLORS.fxShadow : fx.kind === 'extracted' ? COLORS.fxExtracted : COLORS.fxEnemy;
    ctx.globalAlpha = Math.max(0, fx.ttl / 0.12);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(fx.x1, fx.y1);
    ctx.lineTo(fx.x2, fx.y2);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.lineWidth = 1;
  }

  // 배치 미리보기 (카드 선택 중 마우스 위치)
  if (placing && view.mouse && view.hoverRemnantUid === null) {
    const d = findShadowData(state.selectedShadowId);
    const ok = canSummon(state, state.selectedShadowId, view.mouse.x, view.mouse.y).ok;
    const color = ok ? COLORS.ghostOk : COLORS.ghostBad;
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = d.color;
    drawRoundRect(ctx, view.mouse.x - 15, view.mouse.y - 15, 30, 30, 7);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    drawCircle(ctx, view.mouse.x, view.mouse.y, d.attackRange); ctx.stroke();
    ctx.setLineDash([]);
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
  // confirmDismantleUid: 해체 확인 단계에 들어간 그림자 (UI 전용 상태)
  view: { mouse: null, hoverRemnantUid: null, hoverUnitUid: null, showRanges: false, time: 0, confirmDismantleUid: null },
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
      `<span class="card-stats">HP ${s.maxHp} · ATK ${s.attack} · 사거리 ${s.attackRange}</span>` +
      `<span class="card-cost">에너지 ${s.cost}</span>`;
    btn.addEventListener('click', () => selectShadow(s.id));
    wrap.appendChild(btn);
  });
}

function selectShadow(id) {
  const st = game.state;
  if (!isFieldActive(st)) return;
  st.selectedShadowId = st.selectedShadowId === id ? null : id;  // 같은 카드 다시 누르면 선택 해제
  if (st.selectedShadowId) {                                     // 카드 선택 시 다른 패널 닫기
    st.selectedRemnantUid = null;
    st.selectedUnitUid = null;
  }
}

function clearSelection() {
  game.state.selectedShadowId = null;
  game.state.selectedRemnantUid = null;
  game.state.selectedUnitUid = null;
}

// 우클릭(또는 Mac Control + 클릭)
//  - 기본 그림자 위: 회수 시도
//  - 그 밖의 곳: 선택 해제
function onSecondaryClick(evt) {
  evt.preventDefault();   // 브라우저 우클릭 메뉴가 뜨지 않도록
  if (evt.target === game.canvas) {
    const p = toFieldPos(evt);
    const unit = getBasicAt(game.state, p.x, p.y);
    if (unit) {
      const result = recallShadow(game.state, unit);
      if (result.ok) showToast(`${findShadowData(result.unit.typeId).name} 회수 (에너지 +${result.refund})`, 'ok');
      else showToast(REASON_TEXT[result.reason] || result.reason, 'warn');
      return;
    }
  }
  clearSelection();
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
  const st = game.state;
  if (!isFieldActive(st)) return;
  const p = toFieldPos(evt);

  // 1순위: 잔영 클릭 → 추출 패널
  const remnant = getRemnantAt(st, p.x, p.y);
  if (remnant) {
    st.selectedRemnantUid = remnant.uid;
    st.selectedShadowId = null;
    st.selectedUnitUid = null;
    return;
  }
  // 2순위: 그림자 클릭 → 상세 정보 / 해체 패널
  const unit = getShadowAt(st, p.x, p.y);
  if (unit) {
    st.selectedUnitUid = unit.uid;
    st.selectedShadowId = null;
    st.selectedRemnantUid = null;
    return;
  }
  // 3순위: 카드 선택 중이면 배치
  if (st.selectedShadowId) {
    const result = summonShadow(st, st.selectedShadowId, p.x, p.y);
    if (result.ok) showToast(`${findShadowData(result.unit.typeId).name} 소환`, 'ok');
    else showToast(REASON_TEXT[result.reason] || result.reason, 'warn');
    return;
  }
  // 빈 곳 클릭: 패널 닫기
  st.selectedRemnantUid = null;
  st.selectedUnitUid = null;
}

// 해체 → 확인 → 실행. 확인 중에도 전투는 계속되며, 그 사이 그림자가 쓰러지면 해체 실패
function onDismantleConfirm() {
  const st = game.state;
  const uid = game.view.confirmDismantleUid;
  game.view.confirmDismantleUid = null;
  if (uid === null) return;   // 연속 클릭 방지: 이미 처리된 경우 무시
  const result = dismantleShadow(st, uid);
  if (result.ok) {
    const name = result.unit.kind === 'basic'
      ? findShadowData(result.unit.typeId).name
      : `${findEnemyData(result.unit.sourceEnemyId).name} 그림자`;
    showToast(`${name} 해체 (에너지 +${result.gained})`, 'ok');
  } else {
    showToast(REASON_TEXT[result.reason] || result.reason, 'warn');
  }
}

function onExtract() {
  const st = game.state;
  if (st.selectedRemnantUid === null) return;   // 연속 클릭 방지: 이미 처리된 경우 무시
  const result = extractShadow(st, st.selectedRemnantUid);   // 버튼을 누른 순간 조건을 다시 검사
  if (result.ok) {
    showToast(`일어나라! ${findEnemyData(result.unit.sourceEnemyId).name} 그림자 추출`, 'ok');
  } else {
    if (result.reason === 'EXTRACT_GONE') st.selectedRemnantUid = null;
    showToast(REASON_TEXT[result.reason] || result.reason, 'warn');   // 에너지 부족 등: 잔영 유지
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
  if (key === 'escape') { clearSelection(); return; }
  const num = Number(evt.key);
  if (Number.isInteger(num) && num >= 1 && num <= GAME_DATA.shadows.length) selectShadow(GAME_DATA.shadows[num - 1].id);
}

function onMouseMove(evt) {
  const p = toFieldPos(evt);
  const st = game.state;
  const remnant = isFieldActive(st) ? getRemnantAt(st, p.x, p.y) : null;
  const unit = isFieldActive(st) && !remnant ? getShadowAt(st, p.x, p.y) : null;
  game.view.mouse = p;
  game.view.hoverRemnantUid = remnant ? remnant.uid : null;
  game.view.hoverUnitUid = unit ? unit.uid : null;
  game.canvas.style.cursor = remnant || unit ? 'pointer' : st.selectedShadowId ? 'crosshair' : 'default';
}

function onMouseLeave() {
  game.view.mouse = null;
  game.view.hoverRemnantUid = null;
  game.view.hoverUnitUid = null;
}

function setText(el, text) { if (el.textContent !== text) el.textContent = text; }
function setHidden(el, hidden) { if (el.classList.contains('hidden') !== hidden) el.classList.toggle('hidden', hidden); }

function hintText(st) {
  switch (st.status) {
    case STATUS.PREPARATION:
      return `카드를 고르고 전장 빈 곳을 클릭해 기본 그림자를 배치하세요 (최대 ${GAME_DATA.config.maxBasic}기). 남은 잔영은 지금도 추출할 수 있습니다.`;
    case STATUS.PLAYING:
      return '적을 처치하면 그 자리에 잔영이 남습니다. 잔영을 클릭해 그림자를 추출하세요.';
    default:
      return '';
  }
}

// 규칙 쪽에서 쌓은 알림 처리
function consumeEvents(st) {
  for (const ev of st.events) {
    if (ev === 'REMNANT_EXPIRED') showToast(REASON_TEXT.EXTRACT_GONE, 'warn');
    if (ev === 'UNIT_LOST') showToast(REASON_TEXT.UNIT_LOST, 'warn');
  }
  st.events.length = 0;
}

// 그림자 상세 정보 + 해체 패널
function syncUnitPanel(st) {
  const ui = game.ui;
  const unit = isFieldActive(st) ? findShadowUnit(st, st.selectedUnitUid) : null;
  if (!unit || game.view.confirmDismantleUid !== unit.uid) game.view.confirmDismantleUid = null;
  setHidden(ui.unitPanel, !unit);
  if (!unit) return;

  if (unit.kind === 'basic') {
    const d = findShadowData(unit.typeId);
    setText(ui.unitKind, '기본 그림자');
    setText(ui.unitName, `${d.name} · ${ROLE_TEXT[d.role] || d.role}`);
    setText(ui.unitStats, `HP ${unit.hp}/${unit.maxHp} · ATK ${unit.attack} · 사거리 ${unit.attackRange}`);
    setText(ui.unitState, canRecall(st, unit).ok ? '이번 준비 단계 배치 · 우클릭 회수 시 전액 환불' : '고정 배치');
  } else {
    const src = findEnemyData(unit.sourceEnemyId);
    setText(ui.unitKind, '추출 그림자');
    setText(ui.unitName, `${src.name} 몬스터의 그림자`);
    setText(ui.unitStats, `HP ${unit.hp}/${unit.maxHp} · ATK ${unit.attack} · 이동 속도 ${unit.moveSpeed}`);
    setText(ui.unitState, `상태: ${AI_TEXT[unit.aiState] || unit.aiState}`);
  }

  const refund = calculateDismantleRefund(unit);
  const actual = Math.min(refund, st.maxEnergy - st.energy);
  const refundText = actual < refund
    ? `해체 시 에너지 +${actual} (반환 ${refund}, 상한 ${st.maxEnergy})`
    : `해체 시 에너지 +${refund} (소비 ${unit.energyCostPaid}의 50%)`;
  const confirming = game.view.confirmDismantleUid === unit.uid;
  setText(ui.unitRefund, confirming ? `정말 해체할까요? ${refundText.replace('해체 시 ', '')}` : refundText);
  setHidden(ui.unitActions, confirming);
  setHidden(ui.unitConfirm, !confirming);
}

function syncExtractPanel(st) {
  const ui = game.ui;
  const remnant = isFieldActive(st) ? findRemnant(st, st.selectedRemnantUid) : null;
  setHidden(ui.extractPanel, !remnant);
  if (!remnant) return;
  const enemy = findEnemyData(remnant.sourceEnemyId);
  const data = findExtractionData(remnant.sourceEnemyId);
  setText(ui.extractName, `${enemy.name} 몬스터의 그림자`);
  setText(ui.extractStats, `HP ${data.maxHp} · ATK ${data.attack} · 이동 속도 ${data.moveSpeed}`);
  setText(ui.extractCost, `추출 비용: 에너지 ${data.cost}`);
  setText(ui.extractTime, `잔여 시간: ${remnant.ttl.toFixed(1)}초${st.status === STATUS.PLAYING ? '' : ' (정지)'}`);
  ui.btnExtract.classList.toggle('poor', !canExtract(st, remnant.uid).ok);
}

function syncUI() {
  const st = game.state;
  const ui = game.ui;
  const C = GAME_DATA.config;
  consumeEvents(st);

  setText(ui.wave, `${st.wave} / ${GAME_DATA.waves.length}`);
  setText(ui.energy, `${st.energy} / ${st.maxEnergy}`);
  setText(ui.core, `${st.coreHp} / ${st.maxCoreHp}`);
  setText(ui.army, `${countArmy(st)} / ${C.maxArmy}`);
  setText(ui.armyBasic, `기본 ${countBasic(st)}/${C.maxBasic}`);
  setText(ui.status, STATUS_TEXT[st.status]);
  setText(ui.hint, hintText(st));
  ui.core.classList.toggle('danger', st.coreHp <= 3);

  const basicFull = countBasic(st) >= C.maxBasic || countArmy(st) >= C.maxArmy;
  for (const btn of ui.cards.children) {
    const d = findShadowData(btn.dataset.shadowId);
    btn.classList.toggle('selected', st.selectedShadowId === d.id);
    btn.classList.toggle('poor', st.energy < d.cost || basicFull);
  }

  setHidden(ui.btnStart, st.status !== STATUS.PREPARATION);
  setText(ui.btnStart, `WAVE ${st.wave} 시작`);

  syncExtractPanel(st);
  syncUnitPanel(st);

  setHidden(ui.overlayTitle, st.status !== STATUS.READY);
  const showResult = st.status === STATUS.WAVE_CLEAR || st.status === STATUS.VICTORY || st.status === STATUS.DEFEAT;
  setHidden(ui.overlayResult, !showResult);
  if (showResult) {
    const s = st.stats;
    if (st.status === STATUS.WAVE_CLEAR) {
      setText(ui.resultTitle, '웨이브 방어 성공');
      setText(ui.resultDesc, `WAVE ${st.wave} 클리어 · 처치 ${s.waveKills} · 군단 ${countArmy(st)}/${C.maxArmy} · 거점 HP ${st.coreHp}/${st.maxCoreHp}`);
      setText(ui.btnResultPrimary, '다음 웨이브 준비');
    } else if (st.status === STATUS.VICTORY) {
      setText(ui.resultTitle, '던전 방어 성공!');
      setText(ui.resultDesc, `전 웨이브 클리어 · 총 처치 ${s.kills} · 추출 ${s.extractionSuccesses} · 거점 HP ${st.coreHp}/${st.maxCoreHp}`);
      setText(ui.btnResultPrimary, '다시 도전');
    } else {
      setText(ui.resultTitle, '던전 방어 실패');
      setText(ui.resultDesc, `WAVE ${st.wave}에서 거점 파괴 · 총 처치 ${s.kills} · 추출 ${s.extractionSuccesses}`);
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
  game.view.time = now / 1000;
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
    wave: $('hud-wave'), energy: $('hud-energy'), core: $('hud-core'), army: $('hud-army'),
    armyBasic: $('hud-army-basic'), status: $('hud-status'),
    hint: $('hint'), toast: $('toast'), cards: $('shadow-cards'), btnStart: $('btn-start-wave'),
    extractPanel: $('extract-panel'), extractName: $('extract-name'), extractStats: $('extract-stats'),
    extractCost: $('extract-cost'), extractTime: $('extract-time'), btnExtract: $('btn-extract'),
    unitPanel: $('unit-panel'), unitKind: $('unit-kind'), unitName: $('unit-name'), unitStats: $('unit-stats'),
    unitState: $('unit-state'), unitRefund: $('unit-refund'), unitActions: $('unit-actions'), unitConfirm: $('unit-confirm'),
    overlayTitle: $('overlay-title'), overlayResult: $('overlay-result'),
    resultTitle: $('result-title'), resultDesc: $('result-desc'),
    btnResultPrimary: $('btn-result-primary'),
  };

  game.state = createInitialState();
  buildShadowCards();

  game.canvas.addEventListener('click', onCanvasClick);
  game.canvas.addEventListener('mousemove', onMouseMove);
  game.canvas.addEventListener('mouseleave', onMouseLeave);
  $('app').addEventListener('contextmenu', onSecondaryClick);   // 기본 그림자 위: 회수 / 그 밖: 선택 해제
  $('btn-play').addEventListener('click', newGame);
  game.ui.btnStart.addEventListener('click', onStartWave);
  game.ui.btnExtract.addEventListener('click', onExtract);
  $('btn-extract-cancel').addEventListener('click', () => { game.state.selectedRemnantUid = null; });
  $('btn-unit-close').addEventListener('click', () => { game.state.selectedUnitUid = null; });
  $('btn-dismantle').addEventListener('click', () => { game.view.confirmDismantleUid = game.state.selectedUnitUid; });
  $('btn-dismantle-cancel').addEventListener('click', () => { game.view.confirmDismantleUid = null; });   // 변화 없음
  $('btn-dismantle-confirm').addEventListener('click', onDismantleConfirm);
  game.ui.btnResultPrimary.addEventListener('click', onResultPrimary);
  $('btn-result-title').addEventListener('click', goToTitle);
  window.addEventListener('keydown', onKeyDown);

  requestAnimationFrame(frame);
}

if (typeof document !== 'undefined') boot();
