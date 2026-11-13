'use strict';

/* ==================================================================
 * ARISE: 그림자 군단 디펜스 — game.js (v2.0 중앙 거점 · 자유 배치 · 그림자 추출)
 *
 *  [1] GAME_DATA   밸런스·콘텐츠 데이터 → data.js (수치 조정·챕터 추가는 그 파일만 수정)
 *  [2] 상수 / 상태  게임 상태(GameState)와 상태 전이 규칙
 *  [3] 규칙 함수    배치, 회수, 추출, 대상 탐색 등 (화면 코드와 분리)
 *  [4] 전투 틱      1/60초마다 실행되는 전투 계산
 *  [5] 렌더링       Canvas 그리기
 *  [6] UI / 입력    HUD, 카드, 추출 패널, 마우스·키보드
 *  [7] 게임 루프    requestAnimationFrame 1개만 사용
 *
 *  핵심 루프: 자유 배치 → 적 처치 → 잔영 생성 → 수동 추출 → 자동 추적
 * ================================================================== */


/* [1] GAME_DATA는 data.js에 있습니다 (index.html에서 game.js보다 먼저 불러옴) */


/* ==================================================================
 * [2] 상수 / 상태
 * ================================================================== */
const STATUS = Object.freeze({
  READY: 'READY',             // 타이틀 화면
  PREPARATION: 'PREPARATION', // 병력 배치 (전투 정지)
  PLAYING: 'PLAYING',         // 전투 진행
  PAUSED: 'PAUSED',           // 일시정지 (전투 중 P/Esc, 탭 전환 시 자동)
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
  BASIC_FULL:        '기본 그림자를 더 배치할 수 없습니다.',   // 실제 메시지는 reasonText()가 현재 최대 수를 넣어 만듦
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

// 실패 결과 → 화면 메시지 (최대 수처럼 판마다 달라지는 값은 여기서 채움)
function reasonText(result, state) {
  if (result.reason === 'BASIC_FULL') return `기본 그림자는 최대 ${state.maxBasic}기까지 배치할 수 있습니다.`;
  return REASON_TEXT[result.reason] || result.reason;
}

const ROLE_TEXT = Object.freeze({ tank: '탱커', damage: '딜러', area: '광역', magic: '원거리 마법', speed: '스피드' });
const AI_TEXT = Object.freeze({ SPAWN: '추출 중', IDLE: '대기', CHASE: '추격', ATTACK: '공격', RETURN: '복귀', DEAD: '사망' });

// availableShadowIds: 이번 판에 쓸 수 있는 기본 그림자 카드 (챕터 보상으로 해금된 카드 포함)
function createInitialState(chapterId = GAME_DATA.chapters[0].chapterId, availableShadowIds = baseShadowIds()) {
  const c = GAME_DATA.config;
  const available = GAME_DATA.shadows.filter((s) => availableShadowIds.includes(s.id)).map((s) => s.id);
  return {
    status: STATUS.READY,
    previousStatus: null,
    chapterId,                // 플레이 중인 챕터
    availableShadowIds: available,
    maxBasic: maxBasicFor(available),   // 기본 그림자 최대 수: 기본 4 + 해금 카드 1장당 1
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
    pendingHits: [],          // 늦게 들어가는 피해 (어금니 마력구처럼 날아가 닿을 때): { uid, dmg, at }
    corpses: [],              // 사망 애니메이션 표시 (연출용)
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
/* ---------- 카드 해금 ---------- */
// 처음부터 쓰는 카드 (unlockAfterChapter 없음)
function baseShadowIds() { return GAME_DATA.shadows.filter((s) => !s.unlockAfterChapter).map((s) => s.id); }
// 저장 기록 기준 쓸 수 있는 카드: 기본 카드 + 해금 챕터를 클리어한 카드
// 챕터를 클리어한 것으로 보는지: 저장 기록이 있거나, 테스트 설정 clearAllChapters가 켜져 있으면 (저장에는 쓰지 않음)
function isChapterCleared(save, chapterId) {
  return !!GAME_DATA.config.clearAllChapters || !!(save && save.cleared[chapterId]);
}
function getUnlockedShadowIds(save) {
  return GAME_DATA.shadows.filter((s) => !s.unlockAfterChapter || isChapterCleared(save, s.unlockAfterChapter)).map((s) => s.id);
}
function maxBasicFor(shadowIds) {
  const extra = shadowIds.filter((id) => { const d = findShadowData(id); return d && d.unlockAfterChapter; }).length;
  return GAME_DATA.config.maxBasic + extra;
}
// 그 챕터를 클리어하면 생기는 카드
function rewardShadowsFor(chapterId) { return GAME_DATA.shadows.filter((s) => s.unlockAfterChapter === chapterId); }
// 그 챕터에서 처음 나오는 적 종류 (앞 챕터들에 없던 적)
function newEnemiesIn(chapterId) {
  const seen = new Set();
  for (const ch of GAME_DATA.chapters) {
    const here = new Set();
    for (const w of ch.waves) for (const en of w.enemies) here.add(en.enemyId);
    if (ch.chapterId === chapterId) return [...here].filter((id) => !seen.has(id)).map(findEnemyData).filter(Boolean);
    here.forEach((id) => seen.add(id));
  }
  return [];
}

function getChapter(chapterId)  { return GAME_DATA.chapters.find((c) => c.chapterId === chapterId) || null; }
function getWaveCount(state)    { const ch = getChapter(state.chapterId); return ch ? ch.waves.length : 0; }
function getWaveData(state, waveNumber) {
  const ch = getChapter(state.chapterId);
  return (ch && ch.waves[waveNumber - 1]) || null;
}

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

/* ---------- 거점 우회 이동 (추출 그림자) ----------
 * 거점(반경 45) + 유닛 반경 + 여유 2px 원을 장애물로 보고,
 * 목표까지 직선이 이 원을 지나면 원의 접선 방향으로 돌아서 이동한다. */
const CORE_CLEARANCE = 2;

function coreBlockRadius(unit) {
  return GAME_DATA.field.core.radius + (unit.radius || 0) + CORE_CLEARANCE;
}

// -π ~ π 범위의 각도 차이
function angleDiff(a, b) {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

// 선분 (ax, ay)→(bx, by)가 중심 (cx, cy), 반경 r인 원을 지나는가
function segmentHitsCircle(ax, ay, bx, by, cx, cy, r) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((cx - ax) * dx + (cy - ay) * dy) / len2));
  return dist(ax + dx * t, ay + dy * t, cx, cy) < r;
}

// 거점에 겹쳐 있으면 둘레 밖으로 밀어냄
function pushOutOfCore(unit) {
  const c = GAME_DATA.field.core;
  const R = coreBlockRadius(unit);
  const d = dist(unit.x, unit.y, c.x, c.y);
  if (d >= R) return;
  if (d === 0) { unit.y = c.y - R; return; }
  unit.x = c.x + ((unit.x - c.x) / d) * R;
  unit.y = c.y + ((unit.y - c.y) / d) * R;
}

// 우회 경유점: 목표가 있는 쪽으로 도는 접선 위의 점
function coreDetourPoint(unit, tx, ty, R) {
  const c = GAME_DATA.field.core;
  const d = dist(unit.x, unit.y, c.x, c.y);
  const base = Math.atan2(unit.y - c.y, unit.x - c.x);
  const side = angleDiff(Math.atan2(ty - c.y, tx - c.x), base) >= 0 ? 1 : -1;
  if (d <= R + 0.5) {
    // 이미 둘레에 붙어 있으면 둘레를 따라 조금 앞 지점으로
    const a = base + side * 0.35;
    return { x: c.x + Math.cos(a) * (R + 1), y: c.y + Math.sin(a) * (R + 1) };
  }
  const a = base + side * Math.acos(R / d);   // 접점
  return { x: c.x + Math.cos(a) * R, y: c.y + Math.sin(a) * R };
}

// 거점을 통과하지 않고 (tx, ty)로 이동
function moveAroundCore(unit, tx, ty, maxStep, stopDist) {
  if (dist(unit.x, unit.y, tx, ty) <= stopDist) return;
  const c = GAME_DATA.field.core;
  const R = coreBlockRadius(unit);
  if (segmentHitsCircle(unit.x, unit.y, tx, ty, c.x, c.y, R - 0.5)) {
    const wp = coreDetourPoint(unit, tx, ty, R + 1);
    moveToward(unit, wp.x, wp.y, maxStep, 0);
  } else {
    moveToward(unit, tx, ty, maxStep, stopDist);
  }
  pushOutOfCore(unit);
}

/* ---------- 기본 그림자: 자유 배치 / 회수 ---------- */

// 기본 그림자 배치 위치 검사. 문제가 없으면 null
function checkPlacement(state, x, y) {
  const F = GAME_DATA.field;
  const P = F.placement;
  if (x < P.edgeClear || x > F.width - P.edgeClear || y < P.edgeClear || y > F.height - P.edgeClear) return 'PLACE_EDGE';
  if (dist(x, y, F.core.x, F.core.y) <= P.coreClear) return 'PLACE_CORE';
  if (F.spawnPoints.some((sp, i) => { const p = spawnPointFor(state.chapterId, i); return dist(x, y, p.x, p.y) <= P.spawnClear; })) return 'PLACE_SPAWN';
  if (state.basicUnits.some((u) => u.alive && dist(x, y, u.x, u.y) <= P.basicSpacing)) return 'PLACE_OVERLAP';
  return null;
}

function canSummon(state, shadowId, x, y) {
  if (!isFieldActive(state)) return { ok: false, reason: 'INVALID_STATUS' };
  if (!shadowId) return { ok: false, reason: 'NO_SELECTION' };
  const data = findShadowData(shadowId);
  if (!data || !state.availableShadowIds.includes(shadowId)) return { ok: false, reason: 'INVALID_SHADOW' };   // 아직 해금 안 된 카드 포함
  if (countBasic(state) >= state.maxBasic) return { ok: false, reason: 'BASIC_FULL' };
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
  const unit = makeBasicUnit(state, d, x, y);
  state.basicUnits.push(unit);
  return { ok: true, unit };
}

// 기본 그림자 객체 생성 (배치·이어하기 복원 공용)
function makeBasicUnit(state, d, x, y) {
  return {
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
    splashRadius: d.splashRadius || 0,
    lineLength: d.lineLength || 0,   // line: 줄기 길이 (유닛 위치부터)
    lineWidth: d.lineWidth || 0,     // line: 줄기 폭
    lineMaxTilt: d.lineMaxTilt || 0, // line: 위아래로 꺾이는 최대 각도(라디안, 0이면 제한 없음)
    cooldown: 0,          // 생성 직후 첫 공격 가능
    alive: true,
    energyCostPaid: d.cost, // 실제 소비 에너지 → 회수·해체 반환 기준
    facing: x < GAME_DATA.field.core.x ? -1 : 1,   // 그림 방향(표시 전용): 거점 바깥쪽을 봄
    // 준비 단계에서 배치한 그림자만 회수 가능. 웨이브가 시작되면 false로 잠김
    recallable: state.status === STATUS.PREPARATION,
    // 돌격(charge)이 있는 그림자(베르): 배치한 자리(origin)를 지키다가 범위 안 적에게 달려가 붙어서 공격하고, 적이 없으면 돌아옴
    ...(d.charge ? {
      mobile: true, originX: x, originY: y, moveSpeed: d.charge.speed,
      detectionRadius: d.charge.search, maxRoamRadius: d.charge.leash,
      targetId: null, moving: false,
    } : {}),
  };
}

// (x, y)에 있는 기본 그림자 (그림자 사각형 안)
function getBasicAt(state, x, y) {
  let best = null;
  let bestDist = Infinity;
  for (const u of state.basicUnits) {
    if (!u.alive || Math.abs(u.x - x) > 17) continue;
    // 스프라이트로 그리는 그림자는 몸이 판정 위치보다 위로 그려지므로 위쪽(투구까지)도 클릭 범위에 포함
    const sprite = typeof SPRITES !== 'undefined' && SPRITES[u.typeId] && SPRITES[u.typeId].img;
    const dy = y - u.y;
    if (sprite ? (dy < -40 || dy > 14) : Math.abs(dy) > 17) continue;
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
    // 스프라이트로 그리는 그림자는 몸이 판정 위치보다 위로 그려지므로 클릭 범위도 맞춰 넓힘
    const sprite = typeof SPRITES !== 'undefined' && SPRITES[s.sourceEnemyId] && SPRITES[s.sourceEnemyId].img;
    const d = dist(x, y, s.x, sprite ? s.y - 10 : s.y);
    if (d <= (sprite ? 24 : 16) && d < bestDist) { best = s; bestDist = d; }
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

  state.energy -= data.cost;
  state.stats.energySpent += data.cost;
  state.remnants = state.remnants.filter((r) => r.uid !== remnant.uid);
  if (state.selectedRemnantUid === remnant.uid) state.selectedRemnantUid = null;

  const unit = makeExtractedUnit(state, data, remnant.x, remnant.y);
  clampToField(unit);   // 추출 그림자는 배치 제한 없이 맵 범위만 검사
  pushOutOfCore(unit);  // 거점 바로 옆에서 처치된 경우 거점과 겹치지 않게
  unit.originX = unit.x;
  unit.originY = unit.y;
  state.extractedUnits.push(unit);
  state.stats.extractionSuccesses += 1;
  return { ok: true, unit, data };
}

// 추출 그림자 객체 생성 (추출·이어하기 복원 공용). data = extraction.units 항목
function makeExtractedUnit(state, data, x, y) {
  const ex = GAME_DATA.extraction;
  return {
    uid: state.nextUid++,
    kind: 'extracted',
    sourceEnemyId: data.sourceEnemyId,
    aiState: AI.SPAWN,
    spawnTimer: ex.spawnDelay,
    x,
    y,
    radius: Math.round((findEnemyData(data.sourceEnemyId) || { radius: 14 }).radius * 0.9),   // 그리기·거점 충돌 반경
    originX: x,
    originY: y,
    hp: data.maxHp,
    maxHp: data.maxHp,
    attack: data.attack,
    moveSpeed: data.moveSpeed,
    attackRange: data.attackRange,
    attackInterval: data.attackInterval,
    targetType: data.targetType || 'single',
    detectionRadius: ex.detectionRadius,
    maxRoamRadius: ex.maxRoamRadius,
    targetId: null,
    cooldown: 0,
    alive: true,
    energyCostPaid: data.cost, // 실제 소비 에너지 → 해체 반환 기준
  };
}

/* ---------- 적 ---------- */

// 챕터별 출현 지점: 기본 출현 지점에 챕터 배경의 출입구에 맞춘 값(theme.spawn[id] = { y, revealTop })을 덮어씀
//  - revealTop: 이 y보다 위는 그리지 않음 (문·벽·굴 아래에서 걸어 나오는 것처럼). null이면 가리지 않음
function spawnPointFor(chapterId, i) {
  const sp = GAME_DATA.field.spawnPoints[i];
  if (!sp) return null;
  const ch = getChapter(chapterId);
  const o = ch && ch.theme && ch.theme.spawn && ch.theme.spawn[sp.id];
  return o ? Object.assign({}, sp, o) : sp;
}

function createEnemy(state, enemyId, spawnIndex) {
  const d = findEnemyData(enemyId);
  const sp = spawnPointFor(state.chapterId, spawnIndex);
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
    targetType: d.targetType || 'single',
    coreStandoff: d.coreStandoff || 0,   // 원거리형: 거점에서 이만큼 떨어진 둘레에 서서 공격
    moveWhileAttacking: !!d.moveWhileAttacking,   // 원거리형: 쏘면서 계속 전진
    cooldown: 0,
    alive: true,
    atCore: false,   // 거점에 붙어 거점을 공격하는 중 (처치될 때까지 계속)
    coreSlot: null,  // 거점 둘레에서 차지한 자리(각도, 라디안). 도착하면 정해지고 그 자리까지 둘레를 따라 걸어감
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
  if (unit.targetType === 'all_in_range') return inRange;
  const main = inRange[0];
  if (unit.targetType === 'splash') {   // 첫 대상 + 그 주변 splashRadius 안의 적 (사거리 밖이어도 폭발에 휘말림)
    return [main].concat(state.enemies.filter((e) => e.alive && e !== main && dist(e.x, e.y, main.x, main.y) <= unit.splashRadius));
  }
  if (unit.targetType === 'line') {     // 카이셀 브레스: 첫 대상 쪽으로 뻗는 줄기(길이 lineLength·폭 lineWidth)에 걸린 적 전부 (뒤쪽 적 포함)
    return [main].concat(state.enemies.filter((e) => e.alive && e !== main && inLine(unit, main, e, unit.lineLength, unit.lineWidth, unit.lineMaxTilt)));
  }
  return [main];
}

// 줄기 방향: 유닛이 바라보는 쪽(대상이 있는 좌우) 기준 위아래 각도를 maxTilt 안으로 부드럽게 눌러 줌
// (가까운 적에게 급하게 꺾이지 않게. 브레스 그림도 같은 방식이라 보이는 줄기와 피해 줄기가 같음)
function lineDir(dx, dy, maxTilt) {
  const side = dx < 0 ? -1 : 1;
  let rel = Math.atan2(dy, Math.abs(dx));
  if (maxTilt) rel = maxTilt * Math.tanh(rel / maxTilt);
  return { ux: side * Math.cos(rel), uy: Math.sin(rel) };
}
// 유닛(from)에서 대상(toward) 쪽으로 뻗는 길이 len·폭 width의 줄기에 적 e가 걸리는지 (몸 반경까지 포함)
function inLine(from, toward, e, len, width, maxTilt) {
  const { ux, uy } = lineDir(toward.x - from.x, toward.y - from.y, maxTilt);
  const ex = e.x - from.x, ey = e.y - from.y;
  const along = ex * ux + ey * uy;                 // 줄기 방향으로 얼마나 앞인지
  const side = Math.abs(ex * uy - ey * ux);        // 줄기에서 옆으로 얼마나 떨어졌는지
  const r = e.radius || 0;
  return along >= -r && along <= len + r && side <= width / 2 + r;
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
  if (!getWaveData(state, state.wave)) return false;
  if (state.wave >= 2) addEnergy(state, GAME_DATA.config.waveStartBonus);
  for (const u of state.basicUnits) u.recallable = false;   // 전투에 들어간 그림자는 회수 잠금
  state.spawnIndex = 0;
  state.spawnTimer = 0;   // 첫 적은 즉시 생성
  state.stats.waveKills = 0;
  return setStatus(state, STATUS.PLAYING);
}

// WAVE_CLEAR → 다음 웨이브 PREPARATION
// 추출 그림자는 HP 0 또는 게임 종료까지 유지. 잔영은 웨이브가 끝날 때 모두 사라지므로 준비 단계에는 없음
function goToNextWave(state) {
  if (state.status !== STATUS.WAVE_CLEAR) return false;
  state.wave += 1;
  state.corpses = [];
  return setStatus(state, STATUS.PREPARATION);
}

/* ---------- 챕터 진행 저장 ----------
 * 규칙 쪽은 저장 데이터를 만들고 읽기만 함 (브라우저 저장소에 쓰는 것은 UI 쪽 persistSave)
 *  save.cleared[챕터] = { best: { coreHp, kills, extractions } }   클리어한 챕터와 최고 기록(남은 거점 HP 기준)
 *  save.resume[챕터]  = run                                          웨이브를 클리어한 순간의 진행 상황
 *  run: 다음 웨이브 번호·에너지·거점 HP·통계·살아 있는 그림자 → 다음 웨이브 배치 준비부터 이어함
 *  - 앞 챕터를 클리어해야 다음 챕터가 해금됨
 *  - 패배하거나 챕터를 클리어하면 그 챕터의 이어하기는 지워짐 (도중에 나가면 마지막 클리어 웨이브부터) */
const SAVE_VERSION = 1;

function createEmptySave() { return { version: SAVE_VERSION, cleared: {}, resume: {} }; }

function isNum(v) { return typeof v === 'number' && Number.isFinite(v); }

// 저장소에서 읽은 값을 검사해 올바른 부분만 살림 (깨졌거나 버전이 다르면 빈 저장)
function normalizeSave(raw) {
  const save = createEmptySave();
  if (!raw || typeof raw !== 'object' || raw.version !== SAVE_VERSION) return save;
  for (const ch of GAME_DATA.chapters) {
    const id = ch.chapterId;
    const c = raw.cleared && raw.cleared[id];
    if (c && typeof c === 'object') {
      const b = c.best || {};
      save.cleared[id] = { best: { coreHp: isNum(b.coreHp) ? b.coreHp : 0, kills: isNum(b.kills) ? b.kills : 0, extractions: isNum(b.extractions) ? b.extractions : 0 } };
    }
    const r = raw.resume && raw.resume[id];
    if (isValidRun(r, ch)) save.resume[id] = r;
  }
  return save;
}

function isValidRun(r, ch) {
  if (!r || typeof r !== 'object' || r.chapterId !== ch.chapterId) return false;
  if (!Number.isInteger(r.wave) || r.wave < 2 || r.wave > ch.waves.length) return false;
  if (!isNum(r.energy) || !isNum(r.coreHp) || r.coreHp <= 0) return false;
  return Array.isArray(r.basic) && Array.isArray(r.extracted) && r.stats && typeof r.stats === 'object';
}

function isChapterUnlocked(save, chapterId) {
  const i = GAME_DATA.chapters.findIndex((c) => c.chapterId === chapterId);
  if (i < 0) return false;
  if (i === 0 || GAME_DATA.config.unlockAllChapters) return true;   // 테스트 설정: 전부 열림
  return isChapterCleared(save, GAME_DATA.chapters[i - 1].chapterId);
}

function getNextChapter(chapterId) {
  const i = GAME_DATA.chapters.findIndex((c) => c.chapterId === chapterId);
  return i >= 0 ? GAME_DATA.chapters[i + 1] || null : null;
}

// 웨이브 클리어(WAVE_CLEAR) 순간의 진행 상황. 추출 그림자는 원점(대기 위치)에 둠
function serializeRun(state) {
  return {
    chapterId: state.chapterId,
    wave: state.wave + 1,
    energy: state.energy,
    coreHp: state.coreHp,
    stats: Object.assign({}, state.stats, { waveKills: 0 }),
    basic: state.basicUnits.filter((u) => u.alive).map((u) => ({
      typeId: u.typeId, x: u.mobile ? u.originX : u.x, y: u.mobile ? u.originY : u.y, hp: u.hp, energyCostPaid: u.energyCostPaid,
    })),
    extracted: state.extractedUnits.filter((u) => u.alive).map((u) => ({
      sourceEnemyId: u.sourceEnemyId, x: u.originX, y: u.originY, hp: u.hp, energyCostPaid: u.energyCostPaid,
    })),
  };
}

// 저장된 진행 상황 → 다음 웨이브 배치 준비(PREPARATION) 상태. 이전 웨이브의 그림자라 회수는 불가
function restoreRun(run, availableShadowIds) {
  const C = GAME_DATA.config;
  const state = createInitialState(run.chapterId, availableShadowIds);
  state.wave = run.wave;
  state.energy = Math.max(0, Math.min(C.maxEnergy, Math.round(run.energy)));
  state.coreHp = Math.max(1, Math.min(C.coreHp, Math.round(run.coreHp)));
  for (const k of Object.keys(state.stats)) if (isNum(run.stats[k])) state.stats[k] = run.stats[k];
  state.stats.waveKills = 0;
  setStatus(state, STATUS.PREPARATION);
  for (const b of run.basic) {
    const d = findShadowData(b.typeId);
    if (!d || !isNum(b.x) || !isNum(b.y) || countBasic(state) >= state.maxBasic) continue;
    const u = makeBasicUnit(state, d, b.x, b.y);
    if (isNum(b.hp)) u.hp = Math.max(1, Math.min(d.maxHp, Math.round(b.hp)));
    if (isNum(b.energyCostPaid)) u.energyCostPaid = b.energyCostPaid;
    u.recallable = false;
    state.basicUnits.push(u);
  }
  for (const e of run.extracted) {
    const data = findExtractionData(e.sourceEnemyId);
    if (!data || !isNum(e.x) || !isNum(e.y)) continue;
    const u = makeExtractedUnit(state, data, e.x, e.y);
    if (isNum(e.hp)) u.hp = Math.max(1, Math.min(data.maxHp, Math.round(e.hp)));
    if (isNum(e.energyCostPaid)) u.energyCostPaid = e.energyCostPaid;
    u.aiState = AI.IDLE;
    u.spawnTimer = 0;
    state.extractedUnits.push(u);
  }
  return state;
}

// 챕터 클리어 기록. 반환: 처음 클리어인지, 최고 기록인지, 새로 해금된 다음 챕터
function recordChapterClear(save, state) {
  const id = state.chapterId;
  const prev = save.cleared[id];
  const run = { coreHp: state.coreHp, kills: state.stats.kills, extractions: state.stats.extractionSuccesses };
  const next = getNextChapter(id);
  const unlockedNext = next && !isChapterUnlocked(save, next.chapterId) ? next : null;
  const newRecord = !prev || run.coreHp > prev.best.coreHp;
  const unlockedCards = prev ? [] : rewardShadowsFor(id);   // 처음 클리어할 때만 카드 해금
  save.cleared[id] = { best: newRecord ? run : prev.best };
  delete save.resume[id];
  return { firstClear: !prev, newRecord, unlockedNext, unlockedCards, maxBasic: maxBasicFor(getUnlockedShadowIds(save)) };
}

/* ---------- 일시정지 ----------
 * 전투 중(PLAYING)에만 멈출 수 있음. 멈춘 동안 updateGame이 아무것도 하지 않으므로
 * 적·그림자 이동, 공격, 쿨타임, 적 생성, 잔영 타이머가 모두 정지한다.
 * 소환·추출·해체도 isFieldActive가 false라 막힘. */
function pauseGame(state) {
  if (state.status !== STATUS.PLAYING) return false;
  return setStatus(state, STATUS.PAUSED);
}

function resumeGame(state) {
  if (state.status !== STATUS.PAUSED) return false;
  return setStatus(state, STATUS.PLAYING);
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
  updateEnemyMovement(state, dt);         // 3. 적 이동 / 거점 도달 (도달하면 멈춰서 거점 공격)
  updateExtractedAI(state, dt);           // 4. 추출 그림자 탐색 / 추격 / 복귀
  updateChargingBasics(state, dt);        //    돌격하는 기본 그림자(베르): 달려가 붙기 / 복귀
  updateCooldowns(state, dt);             // 5. 쿨타임
  const killed = processShadowAttacks(state); // 6. 그림자 공격 (기본 + 추출)
  processEnemyAttacks(state);             //    적 공격: 그림자 또는 거점 (이번 틱에 죽은 적은 공격하지 않음)
  if (state.coreHp <= 0) {                //    거점 HP 0 → 즉시 패배
    cleanupDead(state);
    state.selectedRemnantUid = null;
    setStatus(state, STATUS.DEFEAT);
    return;
  }
  for (const enemy of killed) {           // 7. 처치 보상 + 잔영 생성 (사망 1회당 1번)
    state.stats.kills += 1;
    state.stats.waveKills += 1;
    addEnergy(state, GAME_DATA.config.killReward);
    if (Math.random() < GAME_DATA.extraction.remnantChance) createRemnant(state, enemy);
    addCorpse(state, enemy);
  }
  cleanupDead(state);                     // 8. 사망 객체 일괄 제거
  updateEffects(state, dt);
  checkWaveComplete(state);               // 9. 웨이브 완료 판정
}

function updateSpawning(state, dt) {
  const wave = getWaveData(state, state.wave);
  if (!wave || state.spawnIndex >= wave.enemies.length) return;
  state.spawnTimer -= dt;
  while (state.spawnTimer <= 0 && state.spawnIndex < wave.enemies.length) {
    const entry = wave.enemies[state.spawnIndex];
    state.enemies.push(createEnemy(state, entry.enemyId, entry.spawn));
    state.events.push(`SPAWN_${entry.spawn}`);   // 화면 연출용 (균열 번쩍임)
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
    // 사거리 안에 그림자가 있거나 거점에 붙었으면 멈춤 (원거리형은 쏘면서 거점 둘레까지 계속 이동)
    e.moving = !e.atCore && (e.moveWhileAttacking || !findEnemyTarget(state, e));
    if (!e.moving) continue;
    if (e.coreSlot !== null) {        // 거점 둘레를 따라 자기 자리로 이동 중
      moveToCoreSlot(e, core, e.moveSpeed * dt);
      continue;
    }
    faceToward(e, core.x);
    moveToward(e, core.x, core.y, e.moveSpeed * dt, 0);
    if (dist(e.x, e.y, core.x, core.y) <= coreRingRadius(e, core)) {
      // 사라지지 않고 거점 둘레의 빈자리를 잡아 멈춰서 공격 (processEnemyAttacks)
      e.coreSlot = pickCoreSlot(state, e, core);
      moveToCoreSlot(e, core, 0);
    }
  }
}

// 거점 둘레 자리 잡기: 도착한 방향에서 가장 가까운, 다른 적과 겹치지 않는 각도를 고름
//  (도착 각도 → +1칸 → -1칸 → +2칸 … 순서). 둘레가 꽉 차면 도착 각도 그대로 (겹침 허용)
const CORE_SLOT_GAP = 2;   // 이웃한 적 사이 여유(px)
// 적이 서는 거점 둘레 반경: 거점 + 자기 크기 (+ 원거리형은 떨어져 서는 거리)
function coreRingRadius(e, core) { return core.radius + e.radius + (e.coreStandoff || 0); }
function pickCoreSlot(state, e, core) {
  const R = coreRingRadius(e, core);
  const a0 = Math.atan2(e.y - core.y, e.x - core.x);
  // 같은 둘레(반경이 비슷한)에 선 적끼리만 자리를 나눔 → 근접형과 원거리형은 서로 막지 않음
  const others = state.enemies.filter((o) => o !== e && o.alive && o.coreSlot !== null &&
    Math.abs(coreRingRadius(o, core) - R) < e.radius + o.radius);
  const step = (e.radius * 2 + CORE_SLOT_GAP) / R;
  const tries = Math.floor(Math.PI / step);
  for (let i = 0; i <= tries; i++) {
    for (const sign of i === 0 ? [1] : [1, -1]) {
      const a = a0 + sign * i * step;
      const free = others.every((o) => {
        const need = (e.radius + o.radius + CORE_SLOT_GAP) / ((R + coreRingRadius(o, core)) / 2);
        return Math.abs(angleDiff(a, o.coreSlot)) >= need;
      });
      if (free) return a;
    }
  }
  return a0;
}

// 거점 둘레(반경 = 거점 + 자기 크기)를 따라 자리 각도로 step(px)만큼 이동. 도착하면 atCore = true
function moveToCoreSlot(e, core, step) {
  const R = coreRingRadius(e, core);
  const cur = Math.atan2(e.y - core.y, e.x - core.x);
  const d = angleDiff(e.coreSlot, cur);
  const move = Math.min(Math.abs(d), step / R);
  const a = cur + Math.sign(d) * move;
  e.x = core.x + Math.cos(a) * R;
  e.y = core.y + Math.sin(a) * R;
  faceToward(e, core.x);
  if (Math.abs(d) - move < 1e-4) {
    e.atCore = true;
    e.moving = false;
  }
}

// 추출 그림자 AI: SPAWN → IDLE → CHASE → ATTACK → (대상 사망) → IDLE / RETURN
// 돌격하는 기본 그림자(베르): 추출 그림자와 같은 방식으로 탐색·추격하되, 배치한 자리(origin)에서 leash 안에서만 움직이고
// 붙으면(공격 사거리 안) 멈춰서 공격. 대상이 없으면 배치한 자리로 돌아감 (공격 자체는 processShadowAttacks)
function updateChargingBasics(state, dt) {
  const ex = GAME_DATA.extraction;
  for (const u of state.basicUnits) {
    if (!u.alive || !u.mobile) continue;
    let target = u.targetId === null ? null : state.enemies.find((e) => e.uid === u.targetId);
    if (!canChase(u, target)) target = findChaseTarget(state, u);
    u.targetId = target ? target.uid : null;
    u.moving = false;
    if (target) {
      faceToward(u, target.x);
      if (dist(u.x, u.y, target.x, target.y) <= u.attackRange) continue;   // 붙었음: 멈춰서 공격
      moveAroundCore(u, target.x, target.y, u.moveSpeed * dt, u.attackRange * 0.9);
      clampToRoam(u);
      clampToField(u);
      pushOutOfCore(u);
      u.moving = true;
      continue;
    }
    if (dist(u.x, u.y, u.originX, u.originY) > 0.5) {   // 돌아가기
      faceToward(u, u.originX);
      moveAroundCore(u, u.originX, u.originY, u.moveSpeed * dt, 0);
      u.moving = true;
      if (dist(u.x, u.y, u.originX, u.originY) < 0.5) { u.x = u.originX; u.y = u.originY; u.moving = false; }
    }
  }
}

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
      faceToward(s, target.x);
      if (dist(s.x, s.y, target.x, target.y) <= s.attackRange) {
        s.aiState = AI.ATTACK;
        continue;
      }
      s.aiState = AI.CHASE;
      moveAroundCore(s, target.x, target.y, s.moveSpeed * dt, s.attackRange * 0.9);   // 거점은 돌아서 감
      clampToRoam(s);
      clampToField(s);
      pushOutOfCore(s);
      continue;
    }

    // 추격할 적이 없음: 원점에서 멀면 복귀, 아니면 대기
    const fromOrigin = dist(s.x, s.y, s.originX, s.originY);
    if (s.aiState === AI.RETURN || fromOrigin > ex.returnThreshold) {
      s.aiState = AI.RETURN;
      faceToward(s, s.originX);
      moveAroundCore(s, s.originX, s.originY, s.moveSpeed * dt, 0);
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
  // 늦게 들어가는 피해: 마력구가 닿는 시각이 되면 그때 대상에게 피해 (그 사이 죽은 대상은 건너뜀)
  if (state.pendingHits.length) {
    state.pendingHits = state.pendingHits.filter((h) => {
      if (state.elapsed < h.at) return true;
      const t = state.enemies.find((e) => e.uid === h.uid);
      if (t && t.alive) {
        if (applyDamage(t, h.dmg)) killed.push(t);
        t.hitAt = state.elapsed;
      }
      return false;
    });
  }
  // 기본 그림자: 제자리에서 사거리 내 적 공격
  for (const u of state.basicUnits) {
    if (!u.alive || u.cooldown > 0) continue;
    const targets = findBasicTargets(state, u);
    if (targets.length === 0) continue;   // 대상이 없으면 쿨타임 0 유지 → 대상이 오면 즉시 공격
    const dmg = calcDamage(u.attack);
    faceToward(u, targets[0].x);   // 그림 방향(표시 전용)
    const sd = findShadowData(u.typeId);
    const fxStyle = sd.attackFx;
    const delay = sd.hitDelay || 0;   // 있으면 공격 이펙트가 닿는 때에 피해 (어금니 마력구)
    targets.forEach((t, ti) => {
      if (delay > 0) state.pendingHits.push({ uid: t.uid, dmg, at: state.elapsed + delay });
      else {
        if (applyDamage(t, dmg)) killed.push(t);
        t.hitAt = state.elapsed;   // 피격 애니메이션용
      }
      // 이펙트 그림은 유닛 앞에 1번만 (범위 공격이라도 겹쳐 그리지 않음). 이펙트가 없으면 대상마다 공격 선
      if (!fxStyle || ti === 0) {
        const fx = addEffect(state, u.x, u.y, t.x, t.y, 'shadow', fxStyle);
        fx.facing = u.facing;
        fx.radius = u.targetType === 'splash' ? u.splashRadius : u.targetType === 'line' ? 30 : u.attackRange;   // 폭발 원 크기 (blast, 브레스 그림이 없을 때 대신)
        fx.atTarget = u.targetType === 'splash' || u.targetType === 'line';   // 맞은 적 위에서 폭발
        fx.maxTilt = u.lineMaxTilt;   // 브레스 그림 각도 (피해 줄기와 같게)
        if (delay > 0) { fx.hitDelay = delay; fx.targetUid = t.uid; fx.life = fx.ttl = delay + ORB_IMPACT_TIME; }   // 이펙트가 피해 시각에 대상에게 닿고 잠깐 터짐
      }
    });
    u.attackAt = state.elapsed;
    u.cooldown = u.attackInterval;
  }
  // 추출 그림자: ATTACK 상태일 때 추격 대상 공격
  for (const s of state.extractedUnits) {
    if (!s.alive || s.aiState !== AI.ATTACK || s.cooldown > 0) continue;
    const t = state.enemies.find((e) => e.uid === s.targetId);
    if (!t || !t.alive || dist(s.x, s.y, t.x, t.y) > s.attackRange) continue;
    // 광역형의 그림자: 사거리 안 적 전부, 그 밖에는 추격 대상 하나
    const hits = s.targetType === 'all_in_range'
      ? state.enemies.filter((e) => e.alive && dist(s.x, s.y, e.x, e.y) <= s.attackRange)
      : [t];
    const dmg = calcDamage(s.attack);
    for (const e of hits) {
      if (applyDamage(e, dmg)) killed.push(e);   // 추출 그림자의 처치도 잔영 생성
      e.hitAt = state.elapsed;
    }
    s.attackAt = state.elapsed;   // 공격 애니메이션용
    faceToward(s, t.x);           // 그림 방향(표시 전용): 공격하는 적 쪽
    const fx = addEffect(state, s.x, s.y, t.x, t.y, 'extracted', findEnemyData(s.sourceEnemyId).attackFx);
    fx.facing = s.facing;
    fx.radius = s.attackRange;
    s.cooldown = s.attackInterval;
  }
  return killed;
}

function processEnemyAttacks(state) {
  const core = GAME_DATA.field.core;
  for (const e of state.enemies) {
    if (!e.alive || e.cooldown > 0) continue;
    const target = findEnemyTarget(state, e);   // 매번 다시 찾음 → 이미 죽은 그림자 공격 방지
    if (!target) {
      // 거점에 붙은 적: 사거리에 그림자가 없으면 공격 간격마다 공격력만큼 거점 피해 (처치될 때까지 반복)
      if (!e.atCore) continue;
      state.coreHp = Math.max(0, state.coreHp - e.attack);
      state.stats.coreDamageTaken += e.attack;
      state.coreHitAt = state.elapsed;   // 거점 흔들림 연출용 (표시 전용)
      faceToward(e, core.x);
      e.attackAt = state.elapsed;
      // 탄환은 거점 가장자리까지 날아감 (근접형은 원래대로 거점 쪽)
      const d = dist(e.x, e.y, core.x, core.y) || 1;
      const hx = core.x + (e.x - core.x) / d * core.radius * 0.7, hy = core.y + (e.y - core.y) / d * core.radius * 0.7;
      const cfx = addEffect(state, e.x, e.y, hx, hy, 'enemy', findEnemyData(e.typeId).attackFx);
      cfx.facing = e.facing;
      cfx.radius = e.attackRange;
      e.cooldown = e.attackInterval;
      continue;
    }
    // 광역형: 사거리 안 그림자 전부 / 그 밖: 가장 가까운 그림자 하나
    const hits = e.targetType === 'all_in_range' ? findEnemyTargetsInRange(state, e) : [target];
    const dmg = calcDamage(e.attack);
    for (const t of hits) {
      const died = applyDamage(t, dmg);
      t.hitAt = state.elapsed;
      if (died) addCorpse(state, t);   // 그림자 사망 연출 (스프라이트가 있는 유닛만 그려짐)
    }
    faceToward(e, target.x);
    e.attackAt = state.elapsed;   // 공격 애니메이션용
    const fx = addEffect(state, e.x, e.y, target.x, target.y, 'enemy', findEnemyData(e.typeId).attackFx);
    fx.facing = e.facing;
    fx.radius = e.attackRange;
    e.cooldown = e.attackInterval;
  }
}

function findEnemyTargetsInRange(state, enemy) {
  return getAllShadows(state).filter((s) => s.alive && dist(enemy.x, enemy.y, s.x, s.y) <= enemy.attackRange);
}

/* ---------- 애니메이션용 표시 정보 (게임 규칙에는 영향 없음) ---------- */
const CORPSE_TIME = 1.0;   // 사망 애니메이션 표시 시간(초)

// 바라보는 방향: 1 = 오른쪽, -1 = 왼쪽 (스프라이트 좌우 반전용)
function faceToward(unit, tx) {
  const dx = tx - unit.x;
  if (Math.abs(dx) > 0.5) unit.facing = dx < 0 ? -1 : 1;
}

function addCorpse(state, unit) {
  state.corpses.push({
    typeId: unit.kind === 'extracted' ? unit.sourceEnemyId : unit.typeId,
    extracted: unit.kind === 'extracted',
    x: unit.x,
    y: unit.y,
    facing: unit.facing || 1,
    spawn: unit.spawn,
    diedAt: state.elapsed,
  });
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
  const wave = getWaveData(state, state.wave);
  if (!wave) return;
  if (state.spawnIndex < wave.enemies.length || state.enemies.length > 0) return;
  const isLast = state.wave >= getWaveCount(state);   // 챕터 마지막 웨이브 → 챕터 클리어
  // 웨이브가 끝나면 추출하지 않은 잔영은 모두 사라짐 → 준비 단계에는 잔영이 남지 않음
  state.remnants = [];
  state.selectedRemnantUid = null;
  for (const u of state.basicUnits) {   // 돌격하는 그림자는 배치한 자리로 돌려놓음 (다음 웨이브 준비·저장은 그 자리 기준)
    if (u.mobile) { u.x = u.originX; u.y = u.originY; u.targetId = null; u.moving = false; }
  }
  setStatus(state, isLast ? STATUS.VICTORY : STATUS.WAVE_CLEAR);
}

// 공격 연출 (게임 규칙에 영향 없음). style: 없으면 공격 선, 'claw'면 할퀴기 자국
const LINE_FX_TIME = 0.12;
const ATTACK_FX_TIME = { claw: 0.3, slash: 0.46, ice: 0.3, bearclaw: 0.36, slam: 0.4, bite: 0.36, bolt: 0.28, blast: 0.4, breath: 0.55, orb: 0.56, berclaw: 0.28 };   // 이펙트 종류별 재생 시간(초, 시작 지연 포함)
const ORB_IMPACT_TIME = 0.18;   // 마력구가 닿은 뒤 터지며 흩어지는 시간(초)
function addEffect(state, x1, y1, x2, y2, kind, style) {
  const ttl = ATTACK_FX_TIME[style] || LINE_FX_TIME;
  const fx = { x1, y1, x2, y2, kind, style, ttl, life: ttl };
  state.effects.push(fx);
  return fx;
}

function updateEffects(state, dt) {
  for (const fx of state.effects) fx.ttl -= dt;
  state.effects = state.effects.filter((fx) => fx.ttl > 0);
  state.corpses = state.corpses.filter((c) => state.elapsed - c.diedAt < CORPSE_TIME);
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
    if (!['single', 'all_in_range', 'splash', 'line'].includes(s.targetType)) errors.push(`shadows ${s.id}: targetType은 single · all_in_range · splash · line 입니다.`);
    if (s.targetType === 'splash' && !isPos(s.splashRadius)) errors.push(`shadows ${s.id}: splash 공격은 splashRadius가 필요합니다.`);
    if (s.targetType === 'line' && !(isPos(s.lineLength) && isPos(s.lineWidth))) errors.push(`shadows ${s.id}: line 공격은 lineLength·lineWidth가 필요합니다.`);
    if (s.hitDelay !== undefined && !(s.hitDelay >= 0 && s.hitDelay < s.attackInterval)) errors.push(`shadows ${s.id}: hitDelay는 0 이상, 공격 간격보다 짧아야 합니다.`);
    if (s.charge !== undefined && !(s.charge && isPos(s.charge.speed) && isPos(s.charge.search) && isPos(s.charge.leash))) errors.push(`shadows ${s.id}: charge는 speed·search·leash(양수)가 필요합니다.`);
    if (s.unlockAfterChapter !== undefined && !(data.chapters || []).some((ch) => ch.chapterId === s.unlockAfterChapter)) errors.push(`shadows ${s.id}: unlockAfterChapter ${s.unlockAfterChapter} 챕터가 없습니다.`);
  }
  const extraCards = data.shadows.filter((s) => s.unlockAfterChapter !== undefined).length;
  if (c.maxBasic + extraCards > c.maxArmy) errors.push('config: 카드를 모두 해금했을 때 기본 그림자 최대 수가 maxArmy를 넘습니다.');
  for (const e of data.enemies) {
    if (ids.has(e.id)) errors.push(`enemies: 중복 ID ${e.id}`);
    ids.add(e.id);
    for (const k of ['maxHp', 'attack', 'moveSpeed', 'attackInterval', 'attackRange', 'radius']) {
      if (!isPos(e[k])) errors.push(`enemies ${e.id}: ${k} 값이 올바르지 않습니다 (${e[k]}).`);
    }
    if (e.targetType !== undefined && !['single', 'all_in_range'].includes(e.targetType)) errors.push(`enemies ${e.id}: targetType은 single 또는 all_in_range 입니다.`);
    if (e.coreStandoff !== undefined && !(typeof e.coreStandoff === 'number' && e.coreStandoff >= 0)) errors.push(`enemies ${e.id}: coreStandoff는 0 이상 숫자여야 합니다.`);
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
    if (u.targetType !== undefined && !['single', 'all_in_range'].includes(u.targetType)) errors.push(`extraction.units ${u.sourceEnemyId}: targetType은 single 또는 all_in_range 입니다.`);
    for (const k of ['cost', 'maxHp', 'attack', 'moveSpeed', 'attackRange', 'attackInterval']) {
      if (!isPos(u[k])) errors.push(`extraction.units ${u.sourceEnemyId}: ${k} 값이 올바르지 않습니다 (${u[k]}).`);
    }
  }

  if (!data.chapters || !data.chapters.length) errors.push('chapters: 챕터가 없습니다.');
  const chapterIds = new Set();
  for (const ch of data.chapters || []) {   // 챕터별 출현 지점 덮어쓰기: 있는 출현 지점 id만, y는 전장 안
    const ov = ch.theme && ch.theme.spawn;
    if (!ov) continue;
    for (const [id, o] of Object.entries(ov)) {
      if (!F.spawnPoints.some((sp) => sp.id === id)) errors.push(`chapters ${ch.chapterId}: theme.spawn의 ${id} 출현 지점이 없습니다.`);
      if (o.y !== undefined && !(o.y >= 0 && o.y <= F.height)) errors.push(`chapters ${ch.chapterId}: theme.spawn.${id}.y가 전장 밖입니다.`);
    }
  }
  (data.chapters || []).forEach((ch, ci) => {
    const at = `chapters[${ci}]`;
    if (!Number.isInteger(ch.chapterId) || ch.chapterId < 1) errors.push(`${at}: chapterId는 1 이상의 정수여야 합니다.`);
    if (chapterIds.has(ch.chapterId)) errors.push(`${at}: 중복 chapterId ${ch.chapterId}`);
    chapterIds.add(ch.chapterId);
    if (ch.theme && ch.theme.map !== null && ch.theme.map !== undefined && typeof ch.theme.map !== 'string') errors.push(`${at}: theme.map은 경로 문자열 또는 null 입니다.`);
    if (!ch.waves || !ch.waves.length) { errors.push(`${at}: 웨이브가 없습니다.`); return; }
    ch.waves.forEach((w, i) => {
      if (!isPos(w.spawnInterval)) errors.push(`${at}.waves[${i}]: spawnInterval 값이 올바르지 않습니다.`);
      if (!w.enemies.length) errors.push(`${at}.waves[${i}]: 적이 없습니다.`);
      w.enemies.forEach((en, j) => {
        if (!data.enemies.some((d) => d.id === en.enemyId)) errors.push(`${at}.waves[${i}].enemies[${j}]: 없는 적 ID ${en.enemyId}`);
        if (!Number.isInteger(en.spawn) || en.spawn < 0 || en.spawn >= F.spawnPoints.length) errors.push(`${at}.waves[${i}].enemies[${j}]: spawn은 0~${F.spawnPoints.length - 1} 사이여야 합니다.`);
      });
    });
  });
  return errors;
}


/* ==================================================================
 * [5] 렌더링 (Canvas) — 게임 규칙을 바꾸지 않고 그리기만 함
 * ================================================================== */
const COLORS = {
  bg: '#0b0d17', grid: 'rgba(255,255,255,0.03)', arena: '#11152a', arenaLine: '#262d4b',
  mapShade: 'rgba(6,8,16,0.28)', textOutline: 'rgba(5,6,12,0.85)',
  core: 'rgba(29,18,51,0.6)', coreLine: '#8b6cff', coreHp: '#3ddc97', coreHpLow: '#ff5c7a',
  spawn: '#ff5c7a',
  ghostOk: '#3ddc97', ghostBad: '#ff5c7a', recall: '#ffcf5c',
  remnant: '#7b5cff', remnantRing: '#c9b8ff', selected: '#ffffff',
  extracted: '#241a46', extractedLine: '#a98bff',
  text: '#e6e8f2', subText: '#8b91b0', hpBack: 'rgba(0,0,0,0.6)',
  hpShadow: '#7cc4ff', hpExtracted: '#c3b2ff', hpEnemy: '#ff6b6b',
  fxShadow: '#9fd0ff', fxExtracted: '#c9b8ff', fxEnemy: '#ff9a6b',
  range: 'rgba(124,196,255,0.10)', rangeLine: 'rgba(124,196,255,0.35)',
  detect: 'rgba(185,166,255,0.45)', roam: 'rgba(185,166,255,0.06)', rangeEnemy: 'rgba(255,107,107,0.35)',
};

const MAP_IMAGE_SRC = 'assets/map.webp';   // 1602×981 맵 디자인 (중앙 문양 = 거점, 푸른 균열 4곳 = 적 출현 방향)

// 맵 이미지 속 푸른 불꽃 위치(전장 좌표, 불꽃 중심). 표시 전용 — 게임 규칙과 무관
const MAP_FLAMES = [
  { x: 305, y: 27 }, { x: 653, y: 27 },   // 위쪽 벽감
  { x: 63,  y: 73 }, { x: 896, y: 74 },   // 위쪽 모서리 기둥
  { x: 71,  y: 525 }, { x: 888, y: 525 }, // 아래쪽 모서리 기둥
];

/* ---------- 출현 균열 빛 ----------
 * 맵 이미지를 자기 자신과 여러 번 곱하면(multiply) 회색 돌바닥은 거의 검게 사라지고
 * 밝은 하늘색 균열만 남는다. 픽셀을 직접 읽지 않으므로 파일로 열어도(file://) 동작한다.
 * 이 '균열만 남은 이미지'를 출현 지점 영역에서만 빛처럼 더해서 그린다. */
const CRACK_BLUR_SCALE = 5;   // 작게 줄였다 늘려서 번지는 빛을 만듦
const CRACK_RES = 2;          // 균열 선은 2배 해상도로 만들어 고해상도 화면에서도 또렷하게

// 1챕터(기본 맵) 균열 영역 = 출현 지점의 crack 영역 (side = 출현 지점 번호 → 그쪽에서 적이 나오면 번쩍)
function spawnCrackRects() {
  return GAME_DATA.field.spawnPoints.map((sp, i) => sp.crack && { ...sp.crack, side: i }).filter(Boolean);
}

function buildCrackGlow(img, rects = spawnCrackRects()) {
  const F = GAME_DATA.field;
  const W = F.width * CRACK_RES;
  const H = F.height * CRACK_RES;
  const sharp = document.createElement('canvas');
  sharp.width = W;
  sharp.height = H;
  const c = sharp.getContext('2d');
  c.drawImage(img, 0, 0, W, H);
  c.globalCompositeOperation = 'multiply';
  for (let i = 0; i < 3; i++) c.drawImage(img, 0, 0, W, H);   // 밝기^4 → 균열만 남음
  // 출현 지점 균열 영역만 남기고 나머지는 지움
  c.globalCompositeOperation = 'destination-in';
  c.beginPath();
  for (const r of rects) c.rect(r.x * CRACK_RES, r.y * CRACK_RES, r.w * CRACK_RES, r.h * CRACK_RES);
  c.fillStyle = '#fff';
  c.fill();

  const soft = document.createElement('canvas');
  soft.width = Math.ceil(F.width / CRACK_BLUR_SCALE);
  soft.height = Math.ceil(F.height / CRACK_BLUR_SCALE);
  const s = soft.getContext('2d');
  s.imageSmoothingEnabled = true;
  s.drawImage(sharp, 0, 0, soft.width, soft.height);
  return { sharp, soft, rects };
}

// 평소에는 출현 지점마다 박자를 달리해 은은하게 맥동, 적이 나오면 번쩍였다가 사그라듦
function drawCrackGlow(ctx, view, glow) {
  if (!glow) return;
  const k = CRACK_BLUR_SCALE;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.imageSmoothingEnabled = true;
  glow.rects.forEach((r, i) => {
    const base = 0.35 + 0.2 * Math.sin(view.time * 1.8 + i * 1.57);
    const a = Math.min(1, base + (view.crackFlash[r.side] || 0) * 0.9);
    // 번지는 빛 (작은 이미지를 늘려 그림 → 흐릿하게 퍼짐)
    ctx.globalAlpha = a;
    ctx.drawImage(glow.soft, r.x / k, r.y / k, r.w / k, r.h / k, r.x, r.y, r.w, r.h);
    ctx.drawImage(glow.soft, r.x / k, r.y / k, r.w / k, r.h / k, r.x, r.y, r.w, r.h);
    // 균열 선 자체
    ctx.globalAlpha = a * 0.8;
    const q = CRACK_RES;
    ctx.drawImage(glow.sharp, r.x * q, r.y * q, r.w * q, r.h * q, r.x, r.y, r.w, r.h);
  });
  ctx.restore();
}

/* ---------- 캐릭터 스프라이트 ----------
 * 시트 규칙: 칸 크기 cell×cell, 한 줄 = 동작 하나, 왼쪽→오른쪽 = 프레임, 캐릭터는 오른쪽을 봄(왼쪽은 좌우 반전).
 * groundY: 그 줄에서 발이 닿는 높이(칸 기준). 줄마다 발 높이가 달라도 같은 땅 위에 서도록 맞춤.
 * 스프라이트가 없는 적은 기존 원형으로 그림. 게임 판정(위치·충돌)은 그대로이고 그리기만 바뀜. */
const SPRITES = {
  EN_001: {   // 일반형
    src: 'assets/sprites/en_001.png',
    cell: 64,         // 도트 1칸 = 전장 1px (고해상도 화면에서는 2×2 화면 픽셀) → 또렷한 도트
    scale: 1,         // 정수 배율만 사용해야 도트가 고르게 보임
    anchorX: 32,      // 칸 안에서 몸 가운데 x
    bodyTop: 16,      // 이동 줄에서 머리 끝 높이 (HP바 위치 계산용)
    shadow: { w: 19, h: 3, dx: 1 },   // 발밑 그림자: 가로 반지름·세로 반지름·가운데 보정(px)
    anims: {
      idle:   { row: 0, frames: 4, fps: 3, groundY: 62 },                    // 멈춰 서 있을 때 (첫 시트의 서 있는 프레임)
      attack: { row: 1, frames: 5, fps: 10, strikeFrame: 2, air: [2, 3], groundY: 60 },   // 0~1 웅크림, 2~3 덮침(타격, 공중), 4 복귀
      hit:    { row: 2, frames: 2, fps: 10, groundY: 60 },
      death:  { row: 3, frames: 5, fps: 9, groundY: 56 },
      // 이동 (다리가 번갈아 움직이는 달리기). stride: 한 바퀴(6프레임) 동안 나아가는 거리(px)
      //  → 재생 속도 = 프레임 수 × 이동 속도 ÷ stride. 빠른 유닛일수록 다리도 빨라져 발이 미끄러지지 않음
      walk:   { row: 4, frames: 6, fps: 10, stride: 36, groundY: 62 },
    },
  },
  EN_002: {   // 돌격형 (말 탄 얼음 요정)
    src: 'assets/sprites/en_002.png',
    cellW: 64, cellH: 60,
    scale: 1,
    anchorX: 35,      // 칸 안에서 말 몸 가운데 x
    bodyTop: 8,       // 머리카락 끝 높이 (HP바 위치)
    shadow: { w: 20, h: 3, dx: 0 },
    anims: {
      idle:   { row: 4, frames: 6, fps: 6, groundY: 58 },   // 서 있는 대기 (따로 받은 6프레임, 다른 줄과 크기 맞춰 축소)
      walk:   { row: 0, frames: 4, fps: 8, stride: 40, groundY: 58 },   // 말 달리기 한 바퀴(4프레임)에 40px
      attack: { row: 1, frames: 5, fps: 10, strikeFrame: 3, groundY: 58 },   // 0~2 단검 들어올림, 3 돌진 베기(타격), 4 복귀
      hit:    { row: 2, frames: 2, fps: 10, groundY: 58 },
      death:  { row: 3, frames: 5, fps: 9, groundY: 58 },
    },
  },
  EN_003: {   // 중장갑형 (푸른 균열 코브라). 줄마다 연결 덩어리로 프레임을 나누고 흰 배 가운데·몸 아래를 맞춰 108×64 칸으로 정렬
    src: 'assets/sprites/en_003.png',
    cellW: 108, cellH: 64,
    scale: 1,
    anchorX: 50,      // 칸 안에서 몸 가운데 x (흰 배는 58, 똬리는 그보다 왼쪽)
    bodyTop: 18,      // 이동 줄의 머리 끝 높이 (HP바 위치)
    shadow: { w: 26, h: 4, dx: -4 },
    anims: {
      idle:   { row: 0, frames: 4, fps: 4, groundY: 62 },
      walk:   { row: 1, frames: 6, fps: 6, stride: 24, groundY: 62 },   // 기어가기 한 바퀴(6프레임)에 24px (느린 유닛)
      attack: { row: 2, frames: 5, fps: 9, strikeFrame: 3, groundY: 62 },   // 0~2 고개를 들고 입을 벌림, 3 앞으로 물기(타격), 4 복귀
      hit:    { row: 3, frames: 2, fps: 10, groundY: 62 },
      death:  { row: 4, frames: 5, fps: 8, groundY: 62 },
    },
  },
  SH_001: {   // 아이언 (방패 기사). 원본 격자가 고르지 않아 프레임마다 발 가운데·발끝을 맞춰 72×64 칸으로 정렬
    src: 'assets/sprites/sh_001.png',   // 푸른 번개·방패 문양·눈빛을 보랏빛으로 바꾼 시트
    cellW: 72, cellH: 64,
    scale: 1,
    glow: true,       // 그림자 유닛: 보랏빛 윤곽 빛
    anchorX: 38,      // 칸 안에서 발 가운데 x
    bodyTop: 10,      // 뿔 끝 높이 (HP바 위치)
    shadow: { w: 18, h: 4, dx: 2, op: 1.4 },
    anims: {
      idle:   { row: 0, frames: 4, fps: 4, groundY: 60 },
      walk:   { row: 1, frames: 6, fps: 8, stride: 36, groundY: 60 },   // 기본 그림자는 제자리라 지금은 쓰지 않음
      attack: { row: 2, frames: 5, fps: 10, strikeFrame: 3, groundY: 60 },   // 0~2 방패 들어올림, 3 내려찍기(타격), 4 복귀
      hit:    { row: 3, frames: 2, fps: 10, groundY: 60 },
      death:  { row: 4, frames: 5, fps: 9, groundY: 60 },
    },
  },
  SH_003: {   // 탱크 (곰, 갈기 디자인). 프레임마다 뒤쪽 끝·발끝을 맞춰 80×64 칸으로 정렬
    src: 'assets/sprites/sh_003.png',
    cellW: 80, cellH: 64,
    scale: 1,
    glow: true,       // 그림자 유닛: 보랏빛 윤곽 빛
    anchorX: 35,      // 칸 안에서 몸 가운데 x
    bodyTop: 12,      // 갈기 끝 높이 (HP바 위치)
    shadow: { w: 24, h: 4, dx: 0, op: 1.3 },
    anims: {
      idle:   { row: 0, frames: 4, fps: 4, groundY: 60 },
      walk:   { row: 1, frames: 6, fps: 8, stride: 40, groundY: 60 },   // 기본 그림자는 제자리라 지금은 쓰지 않음
      attack: { row: 2, frames: 6, fps: 10, strikeFrame: 4, groundY: 60 },   // 0~3 웅크렸다 일어섬, 4 내려찍기(타격), 5 복귀
      hit:    { row: 3, frames: 2, fps: 10, groundY: 60 },
      death:  { row: 4, frames: 5, fps: 9, groundY: 60 },
    },
  },
  SH_005: {   // 카이셀 (용). 프레임마다 꼬리 끝(왼쪽)·발끝을 맞춰 96×72 칸으로 정렬. 색은 이그리트 톤(보랏빛)에 맞춤
    src: 'assets/sprites/sh_005.png',
    cellW: 96, cellH: 72,
    scale: 1,
    glow: true,       // 그림자 유닛: 보랏빛 윤곽 빛
    anchorX: 50,      // 칸 안에서 몸 가운데 x (앞뒤 발 사이)
    bodyTop: 6,       // 뿔·날개 끝 높이 (HP바 위치)
    shadow: { w: 30, h: 4, dx: 0, op: 1.3 },
    anims: {
      idle:   { row: 0, frames: 4, fps: 4, groundY: 69 },
      walk:   { row: 1, frames: 6, fps: 8, stride: 44, groundY: 69 },   // 기본 그림자는 제자리라 지금은 쓰지 않음
      // 0~2 고개를 들고 숨을 모음, 3 날개를 펴고 입을 벌려 브레스(타격, 원본의 작은 입김은 지우고 이펙트로 대신), 4 복귀
      // 3번은 브레스가 나오는 동안 유지하고, 브레스가 사라지는 때에 맞춰 4번(복귀)으로 끝남
      attack: { row: 2, frames: 5, fps: 9, strikeFrame: 3, strikeHold: ATTACK_FX_TIME.breath - 1 / 9, groundY: 69 },
      hit:    { row: 3, frames: 2, fps: 10, groundY: 69 },
      death:  { row: 4, frames: 5, fps: 8, groundY: 69 },
    },
  },
  SH_004: {   // 어금니 (마법사). 프레임마다 붉은 가면 가운데 x·옷자락 끝을 맞춰 100×68 칸으로 정렬 (원본 흰 테두리 정리)
    src: 'assets/sprites/sh_004.png',   // 원본이 이미 보랏빛이라 색은 그대로 (붉은 가면·손은 원본)
    cellW: 100, cellH: 68,
    scale: 1,
    glow: true,       // 그림자 유닛: 보랏빛 윤곽 빛
    anchorX: 56,      // 칸 안에서 가면 가운데 x
    bodyTop: 4,       // 머리 뒤 촉수 끝 높이 (HP바 위치)
    shadow: { w: 20, h: 4, dx: -2, op: 1.2 },
    anims: {
      idle:   { row: 0, frames: 4, fps: 5, groundY: 66 },
      walk:   { row: 1, frames: 6, fps: 8, stride: 40, groundY: 66 },   // 기본 그림자는 제자리라 지금은 쓰지 않음
      // 0~2 두 손을 모았다가 앞으로, 3 손을 뻗어 마력구를 모아 던짐(타격), 4 복귀. 3번은 마력구를 모으는 동안 유지
      attack: { row: 2, frames: 5, fps: 9, strikeFrame: 3, strikeHold: 0.22, groundY: 66 },
      hit:    { row: 3, frames: 2, fps: 10, groundY: 66 },
      death:  { row: 4, frames: 5, fps: 8, groundY: 66 },
    },
  },
  SH_006: {   // 베르 (날개 달린 개미 왕). 프레임마다 어두운 몸 가운데 x·발끝을 맞춰 104×68 칸으로 정렬
    src: 'assets/sprites/sh_006.png',   // 원본이 이미 보랏빛이라 색은 그대로. 반투명 날개는 살짝만 더 비치게, 눈·몸의 보랏빛 빛은 조금 밝게 (몸 색은 원본)
    cellW: 104, cellH: 68,
    scale: 1,
    glow: true,       // 그림자 유닛: 보랏빛 윤곽 빛
    anchorX: 50,      // 칸 안에서 몸 가운데 x
    bodyTop: 4,       // 머리 가시 끝 높이 (HP바 위치)
    shadow: { w: 16, h: 3, dx: 0, op: 1.2 },
    anims: {
      idle:   { row: 0, frames: 4, fps: 8, groundY: 66 },   // 날갯짓 (빠르게)
      walk:   { row: 1, frames: 6, fps: 12, stride: 50, groundY: 66 },   // 기본 그림자는 제자리라 지금은 쓰지 않음
      // 0 웅크림, 1 손을 뻗음, 2 발톱으로 할큄(타격), 3~4 복귀. 공격 간격이 0.45초라 빠르게 재생
      attack: { row: 2, frames: 5, fps: 14, strikeFrame: 2, groundY: 66 },
      hit:    { row: 3, frames: 2, fps: 10, groundY: 66 },
      death:  { row: 4, frames: 5, fps: 8, groundY: 66 },
    },
  },
  SH_002: {   // 이그리트 (기본 그림자: 제자리 고정이라 이동 동작 없음)
    src: 'assets/sprites/sh_002.png',   // 갑옷·빛만 그림자 보랏빛으로 바꾼 시트 (붉은 머리카락은 원본 그대로)
    glow: true,       // 추출 그림자처럼 보랏빛 윤곽 빛
    cellW: 80, cellH: 64,   // 머리카락·검이 좌우로 길어서 가로가 넓은 칸
    scale: 1,
    anchorX: 45,      // 칸 안에서 몸 가운데 x
    bodyTop: 8,       // 투구 끝 높이 (HP바 위치)
    shadow: { w: 21, h: 4, dx: 0, op: 1.5 },   // 망토까지 덮도록 넓게, 어두운 몸과 구분되게 진하게 (op: 진하기 배율)
    anims: {
      idle:   { row: 0, frames: 4, fps: 4, groundY: 60 },
      attack: { row: 1, frames: 6, fps: 12, strikeFrame: 4, groundY: 60 },   // 0~3 겨눔·검 들어올림, 4 내려베기(타격), 5 복귀
      hit:    { row: 2, frames: 2, fps: 10, groundY: 60 },
      death:  { row: 3, frames: 5, fps: 9, groundY: 60 },
    },
  },
};
const SPRITE_FEET_OFFSET = 12;        // 유닛 중심(판정 위치)에서 발까지 아래로
const EXTRACTED_SPRITE_SCALE = 1;     // 추출 그림자 배율 (정수 배율 유지)
const EXTRACTED_TINT = 'rgba(38, 22, 88, 0.86)';   // 추출 그림자 색 (원본 위에 덮는 보랏빛)
// 피격 연출: 맞은 순간 하얗게 번쩍였다가 사그라들고, 좌우로 짧게 흔들림 (그리기 전용, 판정과 무관)
const HIT_FLASH_TIME = 0.16;   // 번쩍임 지속(초)
const HIT_SHAKE_TIME = 0.22;   // 흔들림 지속(초)
const HIT_SHAKE_PX = 2;        // 흔들림 최대 폭(px, 도트 1칸 = 1px)
const HIT_SHAKE_HZ = 28;       // 흔들림 빠르기
const GROUND_SHADOW = '#05030a';            // 적 발밑 그림자 색
const GROUND_SHADOW_EXTRACTED = '#1a0838';  // 추출 그림자 발밑 그림자 색 (보랏빛)

// 챕터별 모습: SPRITES에 'EN_001@ch2'처럼 '종류@ch챕터' 이름으로 넣으면 그 챕터에서 우선 사용 (없거나 못 불러오면 기본 모습)
function spriteFor(typeId, chapterId) {
  if (chapterId !== undefined) {
    const skin = SPRITES[`${typeId}@ch${chapterId}`];
    if (skin && skin.img) return skin;
  }
  const cfg = SPRITES[typeId];
  return cfg && cfg.img ? cfg : null;
}

function spriteGroundY(y) { return y + SPRITE_FEET_OFFSET; }

function spriteTopY(cfg, y, scaleMul) {
  const ref = cfg.anims.walk || cfg.anims.idle;
  return spriteGroundY(y) - (ref.groundY - cfg.bodyTop) * cfg.scale * scaleMul;
}

function spawnClipTop(spawn, chapterId) {
  const sp = spawnPointFor(chapterId, spawn);
  return sp && sp.revealTop !== undefined && sp.revealTop !== null ? sp.revealTop : null;
}

function withClip(ctx, clipTop, draw) {
  if (clipTop === null) { draw(); return; }
  const F = GAME_DATA.field;
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, clipTop, F.width, F.height - clipTop);
  ctx.clip();
  draw();
  ctx.restore();
}

// 지금 보여줄 동작과 프레임. 시간은 게임 시간(state.elapsed)이라 일시정지하면 애니메이션도 멈춤
//  - 공격 순간(attackAt)부터 타격 프레임 이후를 재생 → 공격 선과 덮치는 동작이 맞음
//  - 공격 직전(쿨타임이 거의 끝남)에는 웅크리는 프레임
//  - 피격(hitAt) 직후 짧게 피격 프레임, 그 외에는 움직이면 이동, 멈춰 있으면 대기
function pickAnim(unit, time, moving, cfg, engaged) {
  const atk = cfg.anims.attack;
  if (unit.attackAt !== undefined) {
    const t = time - unit.attackAt;
    // strikeHold(초)가 있으면 타격 프레임을 그만큼 유지한 뒤 나머지 프레임 (카이셀: 브레스를 뿜는 동안 입을 벌리고 있음)
    const hold = atk.strikeHold || 1 / atk.fps;
    const rest = (atk.frames - atk.strikeFrame - 1) / atk.fps;
    if (t >= 0 && t < hold + rest) {
      const frame = t < hold ? atk.strikeFrame : atk.strikeFrame + 1 + Math.floor((t - hold) * atk.fps);
      return { anim: 'attack', frame: Math.min(atk.frames - 1, frame) };
    }
  }
  if (unit.hitAt !== undefined) {
    const hit = cfg.anims.hit;
    const t = time - unit.hitAt;
    if (t >= 0 && t < hit.frames / hit.fps) return { anim: 'hit', frame: Math.floor(t * hit.fps) };
  }
  const windup = atk.strikeFrame / atk.fps;
  if (engaged && unit.cooldown > 0 && unit.cooldown <= windup) {
    const f = Math.floor((windup - unit.cooldown) * atk.fps);
    return { anim: 'attack', frame: Math.max(0, Math.min(atk.strikeFrame - 1, f)) };
  }
  const name = moving ? 'walk' : 'idle';
  const loop = cfg.anims[name];
  const t = time + unit.uid * 0.37;   // 유닛마다 박자를 어긋나게 해서 똑같이 움직이지 않도록
  const fps = loop.stride && unit.moveSpeed ? loop.frames * unit.moveSpeed / loop.stride : loop.fps;
  // breathe: 한 장짜리 대기 그림을 1.4초 주기로 살짝 들썩이게 (도트가 번지지 않게 1px 단위)
  const bob = loop.breathe ? (Math.sin(t * Math.PI * 2 / 1.4) > 0.2 ? loop.breathe : 0) : 0;
  return { anim: name, frame: Math.floor(t * fps) % loop.frames, bob };
}

// 맞은 지 얼마나 됐는지로 번쩍임 세기(0~1)와 흔들림(px)을 계산. 게임 시간 기준이라 일시정지하면 같이 멈춤
function hitFx(hitAt, time) {
  if (hitAt === undefined) return null;
  const t = time - hitAt;
  if (t < 0 || t >= Math.max(HIT_FLASH_TIME, HIT_SHAKE_TIME)) return null;
  const flash = t < HIT_FLASH_TIME ? 1 - t / HIT_FLASH_TIME : 0;
  const decay = t < HIT_SHAKE_TIME ? 1 - t / HIT_SHAKE_TIME : 0;
  // 도트가 번지지 않도록 1px 단위로 끊어서 흔듦
  const shakeX = Math.round(Math.sin(t * HIT_SHAKE_HZ * Math.PI * 2) * HIT_SHAKE_PX * decay);
  return { flash, shakeX };
}

// 발밑 그림자: 1px 단위 계단 모양 타원(도트 느낌). 바깥은 옅게, 안쪽은 진하게 두 겹
//  - 공중 프레임(덮칠 때)에는 그림자가 작고 옅어져서 뛰어오른 느낌
function drawGroundShadow(ctx, cfg, animName, frame, x, y, alpha, scaleMul, color) {
  const sh = cfg.shadow;
  if (!sh || alpha <= 0) return;
  const a = cfg.anims[animName];
  const air = a && a.air && a.air.includes(frame);
  const k = (air ? 0.72 : 1) * cfg.scale * scaleMul;
  const rx = sh.w * k;
  const ry = Math.max(2, Math.round(sh.h * k));
  const cx = Math.round(x + (sh.dx || 0) * scaleMul);
  const cy = Math.round(spriteGroundY(y)) - 1;
  ctx.save();
  ctx.fillStyle = color;
  for (const [scale, op] of [[1, 0.4], [0.66, 0.4]]) {   // [크기, 진하기]
    ctx.globalAlpha = Math.min(1, alpha * op * (sh.op || 1) * (air ? 0.7 : 1));
    const rr = Math.max(1, Math.round(ry * scale));
    for (let dy = -rr + 1; dy <= rr - 1; dy++) {
      const half = Math.round(rx * scale * Math.sqrt(1 - (dy / rr) ** 2));
      ctx.fillRect(cx - half, cy + dy, half * 2, 1);
    }
  }
  ctx.restore();
}

function drawSpriteFrame(ctx, cfg, tinted, animName, frame, x, y, facing, alpha, scaleMul, bob, fx) {
  const img = tinted ? cfg.tinted : cfg.img;
  if (!img || alpha <= 0) return;
  const a = cfg.anims[animName];
  const s = cfg.scale * scaleMul;
  // 화면 픽셀 단위로 위치를 맞춰야 도트가 번지지 않음
  const k = ctx.getTransform().a;
  const px = Math.round(x * k) / k;
  const py = Math.round((spriteGroundY(y) - (bob || 0)) * k) / k;
  const sx = fx ? fx.shakeX : 0;
  ctx.save();
  ctx.imageSmoothingEnabled = false;   // 도트는 부드럽게 늘리지 않고 그대로
  ctx.globalAlpha = alpha;
  if (tinted || cfg.glow) {   // 그림자 유닛: 보랏빛 윤곽 빛
    ctx.shadowColor = COLORS.extractedLine;
    ctx.shadowBlur = 8;
  }
  ctx.translate(px + sx, py);
  ctx.scale(facing * s, s);
  const cw = cfg.cellW || cfg.cell, ch = cfg.cellH || cfg.cell;
  const sxCell = frame * cw, syCell = a.row * ch;
  ctx.drawImage(img, sxCell, syCell, cw, ch, -cfg.anchorX, -a.groundY, cw, ch);
  // 피격 번쩍임: 같은 프레임의 흰 실루엣을 위에 덮고, 흰 빛을 살짝 번지게 함
  if (fx && fx.flash > 0 && cfg.flash) {
    ctx.globalAlpha = alpha * fx.flash * (tinted ? 0.75 : 0.9);
    ctx.shadowColor = tinted ? 'rgba(200, 170, 255, 0.9)' : 'rgba(255, 240, 225, 0.9)';
    ctx.shadowBlur = 10 * fx.flash;
    ctx.drawImage(cfg.flash, sxCell, syCell, cw, ch, -cfg.anchorX, -a.groundY, cw, ch);
  }
  ctx.restore();
}

// 원본 시트를 보랏빛 그림자로 물들인 사본 (픽셀을 읽지 않으므로 파일로 열어도 동작)
function buildTintedSheet(img, color = EXTRACTED_TINT) {
  const c = document.createElement('canvas');
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const x = c.getContext('2d');
  x.drawImage(img, 0, 0);
  x.globalCompositeOperation = 'source-atop';   // 그림이 있는 픽셀에만 색을 덮음
  x.fillStyle = color;
  x.fillRect(0, 0, c.width, c.height);
  return c;
}

function loadSprites() {
  for (const [id, cfg] of Object.entries(SPRITES)) {
    const img = new Image();
    img.onload = () => {
      cfg.img = img;
      cfg.tinted = buildTintedSheet(img);
      cfg.flash = buildTintedSheet(img, '#ffffff');   // 피격 번쩍임용 흰 실루엣
    };
    img.onerror = () => console.warn(`[스프라이트 불러오기 실패] ${id}: ${cfg.src}`);
    img.src = cfg.src;
  }
}

// 맵 위쪽 석상의 두 눈(전장 좌표). 표시 전용
const STATUE_EYES = [{ x: 455, y: 7 }, { x: 504, y: 7 }];
// 눈빛 맥동(초): 서서히 밝아짐(rise) → 사그라듦(fall) → 잠시 원래 밝기로 쉼.
// 맥동 한 번마다 색이 바뀜: 푸른빛 → 붉은빛 → 푸른빛 → … 반복
const EYE_PULSE = { period: 4.2, rise: 1.1, fall: 1.9 };
const EYE_COLORS = [
  { glow: [120, 200, 255], mid: [80, 160, 255],  core: [230, 248, 255], cover: null },          // 푸른빛
  { glow: [255, 70, 60],   mid: [220, 30, 30],   core: [255, 150, 135], cover: [200, 25, 25] }, // 붉은빛
];

function easeInOut(u) { return 0.5 - 0.5 * Math.cos(Math.PI * Math.max(0, Math.min(1, u))); }

// 0(평소) ~ 1(가장 밝음)
function eyePulse(t) {
  const p = t % EYE_PULSE.period;
  if (p < EYE_PULSE.rise) return easeInOut(p / EYE_PULSE.rise);
  if (p < EYE_PULSE.rise + EYE_PULSE.fall) return 1 - easeInOut((p - EYE_PULSE.rise) / EYE_PULSE.fall);
  return 0;
}

function rgba(c, alpha) { return `rgba(${c[0]},${c[1]},${c[2]},${Math.max(0, alpha).toFixed(3)})`; }

// 석상 눈이 빛났다가 사그라드는 연출 (맥동마다 푸른빛 / 붉은빛 번갈아)
function drawStatueEyes(ctx, time) {
  const a = eyePulse(time);
  if (a < 0.01) return;
  const col = EYE_COLORS[Math.floor(time / EYE_PULSE.period) % EYE_COLORS.length];
  ctx.save();
  for (const e of STATUE_EYES) {
    // 붉은빛일 때는 맵에 그려진 하늘색 눈을 먼저 덮어서 붉게 보이도록 (일반 혼합)
    if (col.cover) {
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = rgba(col.cover, 0.9 * a);
      ctx.beginPath();
      ctx.ellipse(e.x, e.y, 7, 2.6, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalCompositeOperation = 'lighter';
    // 가로로 긴 은은한 빛 번짐
    ctx.save();
    ctx.translate(e.x, e.y);
    ctx.scale(1.8, 1);
    const glow = ctx.createRadialGradient(0, 0, 0, 0, 0, 14);
    glow.addColorStop(0, rgba(col.glow, 0.6 * a));
    glow.addColorStop(0.5, rgba(col.mid, 0.22 * a));
    glow.addColorStop(1, rgba(col.mid, 0));
    ctx.fillStyle = glow;
    ctx.fillRect(-14, -14, 28, 28);
    ctx.restore();
    // 눈동자 자리의 밝은 심
    ctx.fillStyle = rgba(col.core, 0.85 * a);
    ctx.beginPath();
    ctx.ellipse(e.x, e.y, 6, 1.8, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

// 주기가 다른 사인파를 섞어 불규칙하게 흔들리는 값 (-1 ~ 1)
function flicker(t, seed) {
  return 0.55 * Math.sin(t * 7.3 + seed)
       + 0.30 * Math.sin(t * 13.1 + seed * 2.1)
       + 0.15 * Math.sin(t * 23.7 + seed * 3.7);
}

// 불꽃 혀 모양: 아래는 둥글고 위로 갈수록 가늘어지며 끝이 sway만큼 기울어짐
function flameTonguePath(ctx, x, y, w, h, sway) {
  ctx.beginPath();
  ctx.moveTo(x, y + w);
  ctx.bezierCurveTo(x - w * 1.4, y + w * 0.2, x - w * 0.7 + sway * 0.4, y - h * 0.5, x + sway, y - h);
  ctx.bezierCurveTo(x + w * 0.7 + sway * 0.4, y - h * 0.5, x + w * 1.4, y + w * 0.2, x, y + w);
  ctx.closePath();
}

// 불꽃 색: glow = 빛 번짐, outer = 바깥 불꽃 혀, inner = 안쪽 밝은 심
const FLAME_BLUE   = { glow: [80, 170, 255], glow2: [60, 140, 255], outer: [70, 160, 255], inner: [210, 240, 255] };   // 신전(챕터 1·기본 맵)
const FLAME_ORANGE = { glow: [255, 150, 60], glow2: [255, 110, 30], outer: [255, 130, 40], inner: [255, 235, 170] };   // 오크 주둔지 횃불·모닥불

// 맵의 불꽃 위에 빛 번짐 + 불꽃 혀를 겹쳐 그려 일렁이는 느낌을 줌 (실제 시간 기준이라 일시정지·준비 중에도 움직임)
//  - flames: { x, y(불꽃 중심, 전장 좌표), s(크기 배율, 기본 1) }
function drawMapFlames(ctx, time, flames = MAP_FLAMES, pal = FLAME_BLUE) {
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';   // 빛처럼 밝기를 더하는 혼합
  flames.forEach((f, i) => {
    const seed = i * 1.7;
    const k = flicker(time, seed);
    const k2 = flicker(time * 1.3, seed + 5);
    const s = f.s || 1;

    // 1) 빛 번짐: 반경·밝기가 흔들림
    const r = (24 + k * 4) * s;
    const gy = f.y - 2 * s;
    const glow = ctx.createRadialGradient(f.x, gy, 0, f.x, gy, r);
    glow.addColorStop(0, rgba(pal.glow, 0.32 + k * 0.08));
    glow.addColorStop(0.45, rgba(pal.glow2, 0.12 + k * 0.04));
    glow.addColorStop(1, rgba(pal.glow2, 0));
    ctx.fillStyle = glow;
    ctx.fillRect(f.x - r, gy - r, r * 2, r * 2);

    // 2) 불꽃 혀: 바깥 → 안쪽(밝은 심) 두 겹, 높이와 기울기가 따로 흔들림
    const baseY = f.y + 6 * s;
    ctx.fillStyle = rgba(pal.outer, 0.45 + k2 * 0.1);
    flameTonguePath(ctx, f.x, baseY, 4.5 * s, (14 + k * 2.5) * s, k2 * 2.2 * s);
    ctx.fill();
    ctx.fillStyle = rgba(pal.inner, 0.55 + k * 0.15);
    flameTonguePath(ctx, f.x, baseY + 1 * s, 2.4 * s, (7.5 + k2 * 1.5) * s, k * 1.2 * s);
    ctx.fill();
  });
  ctx.restore();
}

// ── 오크 주둔지(챕터 3) 배경 연출 ── 좌표는 맵 그림(1602×981) 기준 → 그릴 때 전장 좌표로 바꿈
//  - 횃불·모닥불 11곳이 전부 일렁임 (주황 불꽃)
//  - 문 위 소뿔 해골의 두 눈이 붉게 빛났다가 사라지기를 반복
const mapToField = (x, y) => ({ x: x * GAME_DATA.field.width / 1602, y: y * GAME_DATA.field.height / 981 });
const ORC_FLAMES = [
  // [맵 x, 맵 y(불꽃 밝은 부분 가운데), 크기]
  [169, 24, 0.55], [1457, 30, 0.55],     // 위쪽 모서리 망루
  [583, 99, 0.9], [1025, 100, 0.9],      // 정문 양옆 화로
  [359, 154, 0.8],                       // 모닥불
  [82, 234, 0.7], [1522, 232, 0.7],      // 위쪽 좌우 화로
  [78, 586, 0.85], [1530, 601, 0.85],    // 아래쪽 좌우 화로
  [514, 824, 1.2], [1085, 821, 1.2],     // 아래 출입구 양옆 큰 화로
].map(([x, y, s]) => ({ ...mapToField(x, y), s }));
const ORC_SKULL_EYES = [[785.5, 51], [822.5, 52]].map(([x, y]) => mapToField(x, y));
const SKULL_EYE_PULSE = { period: 3.6, rise: 0.7, hold: 0.5, fall: 1.0 };   // 나머지 시간은 꺼져 있음

function drawSkullEyes(ctx, time) { drawRedEyes(ctx, ORC_SKULL_EYES, pulseLevel(time, SKULL_EYE_PULSE)); }

// ── 악마성(챕터 4) 배경 연출 ── 좌표는 맵 그림(1602×981) 기준 → 그릴 때 전장 좌표로 바꿈
//  - 촛대 10개의 촛불 30개가 전부 일렁임
//  - 가고일 석상 두 마리의 눈이 붉게 빛났다가 사라지기를 반복
//  - 북쪽 성 창문이 방 안 불을 껐다 켜듯 꺼졌다 켜짐 (켤 때 살짝 깜빡). 가운데 큰 창 따로, 양쪽 쌍창은 같이
const FLAME_CANDLE = { glow: [255, 150, 80], glow2: [255, 90, 50], outer: [255, 170, 80], inner: [255, 240, 200] };
const DEMON_CANDLES = [
  // 촛대마다 [가운데, 왼쪽, 오른쪽] 불꽃 (맵 px)
  [[296.7, 85.8], [283.3, 96.7], [309.7, 96.7]],      // 위 왼쪽
  [[553.7, 85.8], [540.3, 96.7], [567.5, 96.7]],      // 위 가운데 왼쪽
  [[1053.3, 85.8], [1040.3, 97.2], [1066.7, 97.2]],   // 위 가운데 오른쪽
  [[1319.5, 85.8], [1306.7, 97.5], [1332.8, 97.5]],   // 위 오른쪽
  [[97.5, 255.8], [84.5, 266.7], [110.8, 267.2]],     // 왼쪽 위
  [[1520.8, 305], [1507.5, 317.5], [1534.2, 317.5]],  // 오른쪽 위
  [[97.5, 715], [84.5, 730], [110, 730]],             // 왼쪽 아래
  [[1507.5, 715.8], [1494.2, 728.3], [1520, 729.2]],  // 오른쪽 아래
  [[556.7, 836.7], [544.2, 850.8], [569.2, 850.8]],   // 아래 왼쪽
  [[1050.8, 835], [1037.8, 850.8], [1063.7, 850.8]],  // 아래 오른쪽
].flat().map(([x, y], i) => ({ ...mapToField(x, y - 1), s: i % 3 === 0 ? 0.34 : 0.3 }));
const DEMON_GARGOYLE_EYES = [[439, 54], [455, 54], [1152, 53], [1168, 53]].map(([x, y]) => mapToField(x, y));
const GARGOYLE_EYE_PULSE = { period: 4.4, rise: 0.9, hold: 0.6, fall: 1.2 };   // 해골 눈보다 느리게

// 빛났다 사라지는 맥동 세기 0~1 (rise → hold → fall → 나머지는 꺼짐)
function pulseLevel(time, P, offset = 0) {
  const t = ((time + offset) % P.period + P.period) % P.period;
  let a = 0;
  if (t < P.rise) a = t / P.rise;
  else if (t < P.rise + P.hold) a = 1;
  else if (t < P.rise + P.hold + P.fall) a = 1 - (t - P.rise - P.hold) / P.fall;
  return a * a * (3 - 2 * a);
}

// 붉은 눈빛 (해골·가고일 공용): 빛 번짐 + 밝은 심
function drawRedEyes(ctx, eyes, a, r = 9) {
  if (a < 0.01) return;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (const e of eyes) {
    const glow = ctx.createRadialGradient(e.x, e.y, 0, e.x, e.y, r);
    glow.addColorStop(0, `rgba(255,60,40,${(0.75 * a).toFixed(3)})`);
    glow.addColorStop(0.4, `rgba(255,30,20,${(0.3 * a).toFixed(3)})`);
    glow.addColorStop(1, 'rgba(255,30,20,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(e.x - r, e.y - r, r * 2, r * 2);
    ctx.fillStyle = `rgba(255,190,150,${(0.9 * a).toFixed(3)})`;   // 눈동자 심
    ctx.beginPath();
    ctx.ellipse(e.x, e.y, 1.6, 1.1, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

// 창문 빛: assets/maps/ch4_windows.png = 맵에서 창문 유리만 남긴 그림 (맵 x 590부터, 높이 130)
const DEMON_WINDOWS = {
  src: 'assets/maps/ch4_windows.png', mapX: 590, mapW: 430, mapH: 130,
  rooms: [   // 창마다 유리 범위(맵 px)와 빛 번짐 가운데. light: 같은 번호끼리 같이 켜지고 꺼짐
    { x0: 590, x1: 685, cx: 637, cy: 66, light: 1 },   // 왼쪽 쌍창 ┐ 같이
    { x0: 755, x1: 850, cx: 802, cy: 70, light: 0 },   // 가운데 큰 창 (따로)
    { x0: 925, x1: 1020, cx: 975, cy: 66, light: 1 },  // 오른쪽 쌍창 ┘
  ],
  img: null, dark: null,
};
// 방 불 켜짐 정도 0~1: 켜짐 3~7초 / 꺼짐 1.5~3.5초를 방마다 따로 (같은 시각이면 항상 같은 결과)
const roomLightCache = [];
function roomRand(i, n, k) {   // 0~1 고정 난수
  const v = Math.sin(i * 127.1 + n * 311.7 + k * 74.7) * 43758.5453;
  return v - Math.floor(v);
}
function roomLight(i, time) {
  let c = roomLightCache[i];
  if (!c || time < c.start) c = roomLightCache[i] = { n: 0, start: -roomRand(i, 0, 9) * 4 };
  for (;;) {
    const on = 3 + roomRand(i, c.n, 1) * 4, off = 1.5 + roomRand(i, c.n, 2) * 2;
    if (time < c.start + on + off) {
      const t = time - c.start;
      if (t < on) {
        // 켜는 순간: 0.35초 동안 두어 번 깜빡이다 켜짐
        if (t < 0.35) return (t < 0.06 || (t > 0.14 && t < 0.2) || t > 0.27) ? 1 : 0.25;
        return 1;
      }
      const to = t - on;
      return to < 0.12 ? 1 - to / 0.12 : 0;   // 끌 때는 빠르게
    }
    c.start += on + off; c.n++;
  }
}

function drawDemonWindows(ctx, time) {
  const W = DEMON_WINDOWS;
  if (!W.img) return;
  const F = GAME_DATA.field, kx = F.width / 1602, ky = F.height / 981;
  if (!W.dark) {   // 유리 모양 그대로 어두운 색으로 칠한 그림 (꺼진 방)
    const c = document.createElement('canvas'); c.width = W.mapW; c.height = W.mapH;
    const cx = c.getContext('2d');
    cx.drawImage(W.img, 0, 0);
    cx.globalCompositeOperation = 'source-in';
    cx.fillStyle = 'rgb(28,12,26)';
    cx.fillRect(0, 0, W.mapW, W.mapH);
    W.dark = c;
  }
  W.rooms.forEach((r) => {
    const lv = roomLight(r.light, time);
    const sx = r.x0 - W.mapX, sw = r.x1 - r.x0;
    const dx = r.x0 * kx, dw = sw * kx, dh = W.mapH * ky;
    ctx.save();
    if (lv < 1) {   // 꺼짐: 유리를 어둡게 덮음
      ctx.globalAlpha = (1 - lv) * 0.88;
      ctx.drawImage(W.dark, sx, 0, sw, W.mapH, dx, 0, dw, dh);
    }
    if (lv > 0) {   // 켜짐: 유리를 조금 더 밝게 + 창 앞으로 붉은 빛 번짐
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = lv * 0.35;
      ctx.drawImage(W.img, sx, 0, sw, W.mapH, dx, 0, dw, dh);
      ctx.globalAlpha = 1;
      const p = mapToField(r.cx, r.cy), rad = 34;
      const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, rad);
      g.addColorStop(0, `rgba(255,50,60,${(0.22 * lv).toFixed(3)})`);
      g.addColorStop(1, 'rgba(255,50,60,0)');
      ctx.fillStyle = g;
      ctx.fillRect(p.x - rad, p.y - rad, rad * 2, rad * 2);
    }
    ctx.restore();
  });
}

// ── 개미굴(챕터 5) 배경 연출 ── 좌표는 맵 그림(1602×981) 기준
//  - 굴 3곳 안쪽의 분홍빛이 밝아졌다가 사라지기를 반복 (굴마다 때가 조금씩 다름)
//  - 바닥 보라 균열 5곳은 1챕터 균열처럼 늘 은은하게 맥동하며 빛나고, 그쪽에서 적이 나오면 번쩍 (동·서)
//  - 알 무더기에 약한 분홍빛이 은은하게 숨 쉬듯 빛남
//  - assets/maps/ch5_glow.png = 맵에서 굴 안쪽 빛과 균열만 남긴 그림. 꺼질 때는 이 모양대로 어둡게 덮고,
//    켜질 때는 빛을 더하고 번짐(흐리게 한 그림)을 얹음
const ANT_GLOW = { src: 'assets/maps/ch5_glow.png', img: null, dark: null, bloom: null, soft: null };
const ANT_TUNNEL_PULSE = { period: 5.2, rise: 1.3, hold: 0.9, fall: 1.6 };
const ANT_GLOW_REGIONS = [
  // 굴: 빛 번짐 가운데(cx,cy)·반경(rad, 맵 px)
  { x0: 690, y0: 40, x1: 940, y1: 195, cx: 822, cy: 138, rad: 120, pulse: ANT_TUNNEL_PULSE, offset: 0,   dark: 0.7, bright: 0.75, glow: [255, 80, 220] },
  { x0: 205, y0: 80, x1: 345, y1: 195, cx: 300, cy: 150, rad: 70,  pulse: ANT_TUNNEL_PULSE, offset: 1.8, dark: 0.7, bright: 0.75, glow: [255, 80, 220] },
  // 오른쪽 굴: 안쪽 빛이 거의 알이라 빛을 약하게 (알이 너무 진하게 번쩍이지 않도록)
  { x0: 1350, y0: 95, x1: 1480, y1: 192, cx: 1418, cy: 156, rad: 60, pulse: ANT_TUNNEL_PULSE, offset: 3.4, dark: 0.45, bright: 0.28, bloom: 0.35, halo: 0.5, glow: [255, 80, 220] },
];
// 바닥 균열 (맵 px 영역): 1챕터 균열처럼 늘 은은하게 맥동하며 빛나고, 그쪽(side = 출현 지점 번호)에서 적이 나오면 번쩍
const ANT_CRACKS = [
  { x0: 140, y0: 300, x1: 390, y1: 440, side: 3 },    // 서쪽 위
  { x0: 200, y0: 610, x1: 390, y1: 700, side: 3 },    // 서쪽 아래
  { x0: 1380, y0: 325, x1: 1510, y1: 395, side: 1 },  // 동쪽 위
  { x0: 1260, y0: 485, x1: 1470, y1: 560, side: 1 },  // 동쪽 가운데
  { x0: 1120, y0: 715, x1: 1350, y1: 810, side: 1 },  // 동쪽 아래
];
// 알 무더기: 가운데·반경(맵 px)
const ANT_EGGS = [
  [130, 145, 42], [262, 175, 16], [434, 80, 24], [539, 160, 32], [1091, 149, 26], [1246, 97, 32],
  [1570, 230, 34], [40, 425, 36], [100, 870, 62], [1320, 925, 32], [1264, 944, 18], [1445, 900, 26],
];

function buildAntGlow() {
  const G = ANT_GLOW, w = G.img.width, h = G.img.height;
  const dark = document.createElement('canvas'); dark.width = w; dark.height = h;
  const dc = dark.getContext('2d');
  dc.drawImage(G.img, 0, 0);
  dc.globalCompositeOperation = 'source-in';
  dc.fillStyle = 'rgb(36,24,50)';   // 바닥 돌 그늘색
  dc.fillRect(0, 0, w, h);
  G.dark = dark;
  const bloom = document.createElement('canvas'); bloom.width = w; bloom.height = h;
  const bc = bloom.getContext('2d');
  // 균열 번짐: 1챕터와 같은 방식 (작게 줄였다가 늘려 그려 흐릿하게 퍼짐)
  const soft = document.createElement('canvas');
  soft.width = Math.ceil(w / CRACK_BLUR_SCALE); soft.height = Math.ceil(h / CRACK_BLUR_SCALE);
  const sc = soft.getContext('2d');
  sc.imageSmoothingEnabled = true;
  sc.drawImage(G.img, 0, 0, soft.width, soft.height);
  G.soft = soft;
  if ('filter' in bc) {             // 흐리게 번진 빛 (지원하지 않는 브라우저는 번짐 없이)
    bc.filter = 'blur(5px)';
    bc.drawImage(G.img, 0, 0);
    bc.drawImage(G.img, 0, 0);
    G.bloom = bloom;
  }
}

function drawAntNest(ctx, view) {
  const time = view.time;
  const G = ANT_GLOW;
  const F = GAME_DATA.field, kx = F.width / 1602, ky = F.height / 981;
  if (G.img) {
    if (!G.dark) buildAntGlow();
    for (const r of ANT_GLOW_REGIONS) {
      const lv = pulseLevel(time, r.pulse, r.offset);
      const sw = r.x1 - r.x0, sh = r.y1 - r.y0;
      const dx = r.x0 * kx, dy = r.y0 * ky, dw = sw * kx, dh = sh * ky;
      ctx.save();
      if (lv < 1) {                 // 사라짐: 빛 모양대로 어둡게 덮음
        ctx.globalAlpha = (1 - lv) * r.dark;
        ctx.drawImage(G.dark, r.x0, r.y0, sw, sh, dx, dy, dw, dh);
      }
      if (lv > 0.01) {              // 빛남: 빛 더하기 + 번짐 + 둘레 은은한 빛
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = lv * r.bright;
        ctx.drawImage(G.img, r.x0, r.y0, sw, sh, dx, dy, dw, dh);
        if (G.bloom) {
          ctx.globalAlpha = lv * r.bright * (r.bloom ?? 1);
          ctx.drawImage(G.bloom, r.x0, r.y0, sw, sh, dx, dy, dw, dh);
        }
        ctx.globalAlpha = 1;
        const p = mapToField(r.cx, r.cy), rad = r.rad * kx;
        const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, rad);
        g.addColorStop(0, rgba(r.glow, 0.14 * lv * (r.halo ?? 1)));
        g.addColorStop(1, rgba(r.glow, 0));
        ctx.fillStyle = g;
        ctx.fillRect(p.x - rad, p.y - rad, rad * 2, rad * 2);
      }
      ctx.restore();
    }
  }
  // 바닥 균열: 1챕터 drawCrackGlow와 같은 세기·박자 (번지는 빛 두 겹 + 균열 선)
  if (G.img && G.soft) {
    const q = CRACK_BLUR_SCALE;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.imageSmoothingEnabled = true;
    ANT_CRACKS.forEach((r, i) => {
      const base = 0.35 + 0.2 * Math.sin(time * 1.8 + i * 1.57);
      const a = Math.min(1, base + (view.crackFlash[r.side] || 0) * 0.9);
      const sw = r.x1 - r.x0, sh = r.y1 - r.y0;
      const dx = r.x0 * kx, dy = r.y0 * ky, dw = sw * kx, dh = sh * ky;
      ctx.globalAlpha = a;
      ctx.drawImage(G.soft, r.x0 / q, r.y0 / q, sw / q, sh / q, dx, dy, dw, dh);
      ctx.drawImage(G.soft, r.x0 / q, r.y0 / q, sw / q, sh / q, dx, dy, dw, dh);
      ctx.globalAlpha = a * 0.8;
      ctx.drawImage(G.img, r.x0, r.y0, sw, sh, dx, dy, dw, dh);
    });
    ctx.restore();
  }
  // 알: 약한 분홍빛이 3초 안팎으로 숨 쉬듯
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ANT_EGGS.forEach(([x, y, rr], i) => {
    const p = mapToField(x, y), rad = rr * kx * 1.5;
    const a = 0.1 + 0.08 * (0.5 + 0.5 * Math.sin(time * 2.1 + i * 2.3));
    const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, rad);
    g.addColorStop(0, `rgba(255,150,230,${a.toFixed(3)})`);
    g.addColorStop(0.6, `rgba(230,110,220,${(a * 0.4).toFixed(3)})`);
    g.addColorStop(1, 'rgba(230,110,220,0)');
    ctx.fillStyle = g;
    ctx.fillRect(p.x - rad, p.y - rad, rad * 2, rad * 2);
  });
  ctx.restore();
}

// ── 카르테논 신전 최종(챕터 6) 배경 연출 ── 1챕터 신전과 같은 구성(불꽃 6곳·석상 눈빛·출현 균열 빛)을 붉은빛으로
//  - 석상 눈은 붉게만 빛나고(1챕터는 푸른빛·붉은빛 번갈아), 눈동자가 한곳을 보다가 휙 다른 곳으로 시선을 옮김
const FLAME_RED = { glow: [255, 70, 50], glow2: [230, 30, 30], outer: [255, 60, 40], inner: [255, 200, 170] };
const DARK_FLAMES = [
  [506.5, 42.5], [1096, 43],      // 위쪽 벽감
  [94, 119], [1508, 119],         // 위쪽 모서리 기둥
  [108.5, 879], [1494.5, 878],    // 아래쪽 모서리 기둥
].map(([x, y]) => mapToField(x, y));
// 붉은 균열 (맵 px 영역 → 전장 좌표). side = 출현 지점 번호(0 북·1 동·2 남·3 서) → 그쪽에서 적이 나오면 번쩍
const DARK_CRACKS = [
  [680, 115, 905, 265, 0], [1380, 420, 1570, 545, 1], [695, 690, 885, 895, 2], [30, 415, 225, 540, 3],
  [190, 170, 300, 285, 3], [1300, 170, 1410, 260, 1], [170, 690, 295, 790, 3], [1295, 715, 1410, 815, 1],
].map(([x0, y0, x1, y1, side]) => {
  const a = mapToField(x0, y0), b = mapToField(x1, y1);
  return { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y, side };
});
const DARK_EYES = [[767, 23], [846, 23]].map(([x, y]) => mapToField(x, y));

// 눈동자 시선: 한곳을 잠시 보다가 빠르게 다른 곳으로 휙 옮김 (x·y는 -1~1, hold = 머무는 시간 초)
const DARK_EYE_GAZE = [
  { x: 0, y: 0, hold: 1.6 }, { x: -1, y: 0.2, hold: 1.2 }, { x: -0.4, y: 0.5, hold: 0.7 },
  { x: 1, y: 0.1, hold: 1.4 }, { x: 0.3, y: -0.5, hold: 0.9 }, { x: 1, y: 0.4, hold: 0.8 }, { x: -0.8, y: -0.2, hold: 1.1 },
];
const DARK_EYE_MOVE = 0.16;            // 시선을 옮기는 데 걸리는 시간(초)
const DARK_EYE_RANGE = { x: 3.2, y: 1.2 };   // 최대 움직임(전장 px)
const DARK_EYE_CYCLE = DARK_EYE_GAZE.reduce((t, g) => t + g.hold + DARK_EYE_MOVE, 0);
function darkEyeGaze(time) {
  let t = time % DARK_EYE_CYCLE;
  for (let i = 0; i < DARK_EYE_GAZE.length; i++) {
    const g = DARK_EYE_GAZE[i], nx = DARK_EYE_GAZE[(i + 1) % DARK_EYE_GAZE.length];
    if (t < g.hold) return { x: g.x, y: g.y };
    t -= g.hold;
    if (t < DARK_EYE_MOVE) {
      const u = easeInOut(t / DARK_EYE_MOVE);
      return { x: g.x + (nx.x - g.x) * u, y: g.y + (nx.y - g.y) * u };
    }
    t -= DARK_EYE_MOVE;
  }
  return { x: 0, y: 0 };
}

function drawDarkStatueEyes(ctx, time) {
  const gz = darkEyeGaze(time);
  const dx = gz.x * DARK_EYE_RANGE.x, dy = gz.y * DARK_EYE_RANGE.y;
  const a = eyePulse(time);   // 1챕터와 같은 박자로 맥동 (붉은빛만)
  ctx.save();
  for (const e of DARK_EYES) {
    // 1) 맵에 그려진 눈동자와 그 둘레 붉은 빛을 눈구멍 색으로 덮음 (움직이는 눈동자로 대신 그림)
    ctx.globalCompositeOperation = 'source-over';
    ctx.save();
    ctx.translate(e.x, e.y);
    ctx.scale(1.6, 1);
    const cover = ctx.createRadialGradient(0, 0, 0, 0, 0, 4.6);
    cover.addColorStop(0, 'rgba(34,3,8,1)');
    cover.addColorStop(0.7, 'rgba(34,3,8,0.9)');
    cover.addColorStop(1, 'rgba(34,3,8,0)');
    ctx.fillStyle = cover;
    ctx.fillRect(-5, -5, 10, 10);
    ctx.restore();
    // 2) 움직이는 눈동자: 늘 붉게 빛나고, 맥동 때 더 밝고 넓게
    const x = e.x + dx, y = e.y + dy;
    ctx.globalCompositeOperation = 'lighter';
    const r = 5 + a * 5;
    const glow = ctx.createRadialGradient(x, y, 0, x, y, r);
    glow.addColorStop(0, `rgba(255,60,50,${(0.55 + a * 0.35).toFixed(3)})`);
    glow.addColorStop(0.45, `rgba(220,25,25,${(0.22 + a * 0.18).toFixed(3)})`);
    glow.addColorStop(1, 'rgba(220,25,25,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = 'rgb(225,30,35)';          // 붉은 테
    ctx.beginPath(); ctx.arc(x, y, 1.9, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = `rgba(255,170,160,${(0.85 + a * 0.15).toFixed(3)})`;   // 밝은 심
    ctx.beginPath(); ctx.arc(x, y, 0.9, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}

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

// 맵 이미지 위에서도 읽히도록 어두운 외곽선을 두른 글자
function drawLabel(ctx, text, x, y, color, font) {
  ctx.font = font || '11px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 3;
  ctx.strokeStyle = COLORS.textOutline;
  ctx.strokeText(text, x, y);
  ctx.lineWidth = 1;
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}

// 할퀴기 이펙트 (assets/sprites/fx_claw.png): 6프레임, 줄 0 붉은색(적 늑대) · 줄 1 보랏빛(추출 그림자 늑대)
//  - 그림은 왼쪽에서 오른쪽으로 할퀴는 방향 → 공격한 쪽이 오른쪽이면 좌우 반전
//  - 원본은 아래→위로 긋는 모양이라 위아래를 뒤집어 위→아래로 할퀴게 그림
//  - 맞은 유닛 몸통 가운데에서 공격한 쪽으로 조금 당겨 붙임. 파일이 없으면 공격 선으로 대신 그림
// 이그리트처럼 맞은 상대를 따라가지 않고, 공격한 늑대가 바라보는 쪽 바로 앞(앞발 높이)에 그림
const CLAW_FX = {
  src: 'assets/sprites/fx_claw.png', w: 48, h: 40, frames: 6,
  rows: { enemy: 0, extracted: 1 },
  glow: { enemy: 'rgba(255, 60, 70, 0.55)', extracted: 'rgba(160, 120, 255, 0.6)' },
  bodyLift: 6,   // 판정 위치에서 위로(px) = 앞발·입 높이
  reach: 30,     // 늑대가 바라보는 쪽으로 떨어진 거리(px)
};
// 이그리트 베기 (assets/sprites/fx_slash.png, 80×54 도트 6프레임). 색은 이그리트 갑옷 보라에 맞춰
// 색상을 옮기고 채도를 낮춘 그림. 원본은 아래→위로 휘두르는 모양이라
// 할퀴기처럼 위아래를 뒤집어 위→아래로 내려베게 그림.
// 맞은 적 위가 아니라 이그리트가 바라보는 쪽 바로 앞(reach px)에 검 높이로 그림.
// 적의 위치(위·아래·거리)와 상관없이 이그리트 그림 기준으로 고정 → 검을 휘두르는 것처럼 보임
const SLASH_FX = {
  src: 'assets/sprites/fx_slash.png', w: 80, h: 54, frames: 6,
  rows: {},
  glow: { shadow: 'rgba(169, 139, 255, 0.6)' },   // 이그리트 윤곽 빛과 같은 색
  bodyLift: 5,   // 내려베기 프레임의 검 높이에 맞춤 (판정 위치에서 위로 px, 발끝은 아래로 12px)
  reach: 36,     // 이그리트가 바라보는 쪽으로 떨어진 거리(px) = 검이 닿는 곳
  delay: 0.08,   // 내려베기 프레임이 보인 뒤에 궤적이 나오도록 시작을 늦춤(초)
};
// 돌격형 얼음 베기 (assets/sprites/fx_ice.png, 50×40 도트 5프레임). 줄 0 푸른색(적) · 줄 1 보랏빛(추출 그림자)
// 맞은 상대를 따라가지 않고, 돌격형이 바라보는 쪽 바로 앞(단검 높이)에 위→아래로 내려베게 그림
const ICE_FX = {
  src: 'assets/sprites/fx_ice.png', w: 50, h: 40, frames: 5,
  rows: { enemy: 0, extracted: 1 },
  glow: { enemy: 'rgba(90, 170, 255, 0.6)', extracted: 'rgba(160, 120, 255, 0.6)' },
  bodyLift: 10,  // 판정 위치에서 위로(px) = 말 머리·단검 높이
  reach: 22,     // 돌격형이 바라보는 쪽으로 떨어진 거리(px)
};
// 중장갑형 물기 (assets/sprites/fx_bite.png, 40×40 도트 6프레임, 직접 그림). 위아래 턱이 벌어졌다 닫히며 물고,
// 닫히는 순간 충격 빛 → 이빨 자국·파편. 줄 0 푸른빛(적, 뱀 균열 색) · 줄 1 보랏빛(추출 그림자). 뱀 입 앞에 그림
const BITE_FX = {
  src: 'assets/sprites/fx_bite.png', w: 40, h: 40, frames: 6,
  rows: { enemy: 0, extracted: 1 },
  glow: { enemy: 'rgba(80, 200, 255, 0.55)', extracted: 'rgba(160, 120, 255, 0.6)' },
  bodyLift: 19,  // 판정 위치에서 위로(px) = 물기 프레임의 입 높이 (발끝은 아래로 12px)
  reach: 42,     // 뱀이 바라보는 쪽으로 떨어진 거리(px) = 입 끝에 살짝 겹치게
  upright: true, // 그린 모양 그대로 (위아래 반전 안 함)
};
// 탱크 발톱 (assets/sprites/fx_bearclaw.png, 69×56 도트 6프레임, 세로로 1.22배 늘림). 곰이 바라보는 쪽 바로 앞에 내려찍듯 그림
const BEARCLAW_FX = {
  src: 'assets/sprites/fx_bearclaw.png', w: 69, h: 56, frames: 6,
  rows: {},
  glow: { shadow: 'rgba(169, 139, 255, 0.6)' },
  bodyLift: 8,   // 판정 위치에서 위로(px) = 앞발 높이
  reach: 35,     // 곰이 바라보는 쪽으로 떨어진 거리(px)
  mirror: true,  // 원본 그림을 좌우로 뒤집어서 그림
};
// 아이언 방패 내려찍기 (assets/sprites/fx_slam.png, 56×61 도트 6프레임, 보랏빛: 호를 그리며 솟구친 뒤 바닥 균열). 땅에서 솟구치는 충격이라
// 위아래를 뒤집지 않고, 그림 아래쪽을 아이언 발끝 높이에 맞춰 앞쪽에 그림
const SLAM_FX = {
  src: 'assets/sprites/fx_slam.png', w: 56, h: 61, frames: 6,
  rows: {},
  glow: { shadow: 'rgba(169, 139, 255, 0.6)' },
  bodyLift: 14,  // 솟구치는 호의 아래(칸 y 56)가 아이언 발끝(판정 위치 +12)에 오도록. 바닥 균열은 발끝보다 3px 아래로 퍼짐
  reach: 30,     // 아이언이 바라보는 쪽으로 떨어진 거리(px)
  upright: true, // 위아래 반전 안 함
};
// 카이셀 브레스 (assets/sprites/fx_breath.png, 128×38 도트 8프레임, 보랏빛): 입에서 뿜어져 길게 뻗었다가 흩어짐.
// 다른 이펙트와 달리 맞은 적 쪽으로 방향을 돌림. 광역 공격이라 적이 가까워도 줄이지 않고 늘 같은 길이로 뒤쪽 적까지 뻗음
// (피해도 이 줄기를 따라 들어감: 데이터 targetType 'line', lineLength 180 ≈ 입 앞 37px + 브레스 142px)
const BREATH_FX = {
  src: 'assets/sprites/fx_breath.png', w: 128, h: 38, frames: 8,
  originX: 3, originY: 19,   // 칸 안에서 브레스가 시작되는 곳 (초승달 머리 뒤쪽 끝, 줄 가운데)
  length: 118,               // 배율 1일 때 머리에서 불꽃 끝까지(px)
  mouthReach: 37,            // 카이셀 판정 위치에서 바라보는 쪽으로 입까지(px) = 브레스 프레임(공격 3번째)에서 벌린 입 앞 (칸 x 87)
  mouthLift: 31,             // 판정 위치에서 위로 입 높이(px) = 칸 y 28 (발끝 y 69는 판정 위치 아래 12px)에서 2px 더 위 (눈으로 맞춤)
  scale: 1.2,                // 늘 이 배율 (약 142px: 사거리 150 끝의 적과 그 뒤 폭발 범위까지)
  maxTilt: 0.9,              // 데이터에 lineMaxTilt가 없을 때 쓰는 최대 각도(라디안)
  glow: 'rgba(169, 139, 255, 0.6)',
};
function drawBreathFx(ctx, fx) {
  const B = BREATH_FX;
  if (!B.img) return false;
  const p = Math.min(0.999, Math.max(0, (fx.life - fx.ttl) / fx.life));
  const frame = Math.floor(p * B.frames);
  const dir = fx.facing || (fx.x2 >= fx.x1 ? 1 : -1);
  const mx = fx.x1 + dir * B.mouthReach, my = fx.y1 - B.mouthLift;
  const tx = fx.x2, ty = fx.y2 - 6;   // 맞은 적 몸통 높이
  // 각도: 입에서 적을 본 각도를 바라보는 쪽 기준 maxTilt 안으로 부드럽게 눌러 줌 (작은 각도는 거의 그대로,
  // 가까운 적처럼 큰 각도일수록 덜 꺾임). 피해 줄기도 같은 방식이라 거의 같은 쪽으로 뻗음
  const d = lineDir(dir * Math.max(8, dir * (tx - mx)), ty - my, fx.maxTilt ?? B.maxTilt);
  const ang = Math.atan2(d.uy, d.ux);
  const k = B.scale;
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.shadowColor = B.glow;
  ctx.shadowBlur = 6;
  ctx.translate(mx, my);
  ctx.rotate(ang);
  if (Math.abs(ang) > Math.PI / 2) ctx.scale(1, -1);   // 왼쪽으로 뿜을 때 불꽃 모양이 뒤집혀 보이지 않게
  ctx.scale(k, k);
  ctx.drawImage(B.img, frame * B.w, 0, B.w, B.h, -B.originX, -B.originY, B.w, B.h);
  ctx.restore();
  return true;
}
// 어금니 마력구 (assets/sprites/fx_orb.png, 80×72 칸 7프레임 × 2줄): 줄 0 = 손끝에서 모으기, 줄 1 = 날아가기 → 터지며 흩어짐.
// 뻗은 손 앞에서 구슬이 커진 뒤 맞은 적(몸통 높이)까지 날아가 터짐. 날아가는 방향으로 그림을 돌림.
// 피해는 데이터 hitDelay(초) 뒤 구슬이 닿는 순간에 들어감
const ORB_FX = {
  src: 'assets/sprites/fx_orb.png', w: 80, h: 72,
  handReach: 20,     // 어금니 판정 위치에서 바라보는 쪽으로 손끝 앞까지(px) = 공격 3번째 프레임의 뻗은 손 (칸 x 76)
  handLift: 25,      // 판정 위치에서 위로 손 높이(px) = 칸 y 29 (발끝 y 66은 판정 위치 아래 12px)
  charge: 0.18,      // 모으기 시간(초): 줄 0의 0~5번 프레임. 날아가는 시간 = 피해 시각(hitDelay) - 모으기 (줄 1의 0~3번 반복)
  chargeScale: 0.6, flyScale: 0.85,
  headX: 62, headY: 36,   // 줄 1 칸 안에서 구슬 머리 위치 (꼬리는 왼쪽)
  glow: 'rgba(190, 120, 255, 0.6)',
};
function drawOrbFx(ctx, fx, state) {
  const O = ORB_FX;
  if (!O.img) return false;
  const t = fx.life - fx.ttl;
  const dir = fx.facing || (fx.x2 >= fx.x1 ? 1 : -1);
  const hx = fx.x1 + dir * O.handReach, hy = fx.y1 - O.handLift;
  // 날아가는 동안 대상이 움직이면 따라감 (닿을 때까지). 닿은 뒤에는 그 자리에서 터짐
  const tgt = state && fx.targetUid !== undefined && t < (fx.hitDelay || 0) ? state.enemies.find((e) => e.uid === fx.targetUid && e.alive) : null;
  if (tgt) { fx.x2 = tgt.x; fx.y2 = tgt.y; }
  const tx = fx.x2, ty = fx.y2 - 8;   // 맞은 적 몸통 높이
  const ang = Math.atan2(ty - hy, tx - hx);
  const charge = Math.min(O.charge, (fx.hitDelay || 0.38) * 0.5);
  const flyT = Math.max(0.05, (fx.hitDelay || 0.38) - charge);   // 피해가 들어가는 순간 구슬이 적에게 닿음
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.shadowColor = O.glow;
  ctx.shadowBlur = 6;
  if (t < charge) {                         // 1) 손끝에서 모으기
    const f = Math.min(5, Math.floor(t / charge * 6));
    ctx.translate(hx, hy);
    ctx.scale(O.chargeScale, O.chargeScale);
    ctx.drawImage(O.img, f * O.w, 0, O.w, O.h, -O.w / 2, -O.h / 2, O.w, O.h);
  } else {
    const u = (t - charge) / flyT;
    let x = tx, y = ty, f;
    if (u < 1) {                            // 2) 날아가기 (꼬리 달린 구슬)
      x = hx + (tx - hx) * u; y = hy + (ty - hy) * u;
      f = Math.floor(u * 4) % 4;
    } else {                                // 3) 맞은 자리에서 터지며 흩어짐
      const rest = Math.max(0.001, fx.life - charge - flyT);
      f = 4 + Math.min(2, Math.floor((t - charge - flyT) / rest * 3));
    }
    ctx.translate(x, y);
    ctx.rotate(ang);
    if (Math.abs(ang) > Math.PI / 2) ctx.scale(1, -1);   // 왼쪽으로 날아갈 때 그림이 뒤집혀 보이지 않게
    ctx.scale(O.flyScale, O.flyScale);
    ctx.drawImage(O.img, f * O.w, O.h, O.w, O.h, -O.headX, -O.headY, O.w, O.h);
  }
  ctx.restore();
  return true;
}
// 베르 할퀴기 (assets/sprites/fx_berclaw.png, 80×60 도트 6프레임, 보랏빛 초승달). 베르가 바라보는 쪽, 뻗은 발톱 앞에 위→아래로 그림
const BERCLAW_FX = {
  src: 'assets/sprites/fx_berclaw.png', w: 80, h: 60, frames: 6,
  rows: {},
  glow: { shadow: 'rgba(169, 139, 255, 0.6)' },
  bodyLift: 17,  // 판정 위치에서 위로(px) = 할퀴는 프레임의 발톱 높이 (칸 y 37, 발끝 y 66은 판정 위치 아래 12px)
  reach: 36,     // 베르가 바라보는 쪽으로 떨어진 거리(px) = 뻗은 발톱 끝(칸 x 91) 바로 앞
  // 원본은 아래→위로 긋는 모양이라 위아래를 뒤집어 위→아래로 할퀴게 그림 (upright 없음)
};
const ATTACK_FX = { claw: CLAW_FX, slash: SLASH_FX, ice: ICE_FX, bearclaw: BEARCLAW_FX, slam: SLAM_FX, bite: BITE_FX, berclaw: BERCLAW_FX };

// 잔영 (assets/sprites/remnant.png): 보랏빛 그림자 불꽃 6프레임 반복. 파일이 없으면 기존 원형으로 그림
//  - 바닥 웅덩이를 쓰러진 적의 발밑에 맞춤. 클릭 판정(잔영 위치 반경 16px)은 그대로
//  - 남은 시간은 웅덩이 둘레의 타원 호로 표시
const REMNANT_FX = {
  src: 'assets/sprites/remnant.png', w: 38, h: 41, fps: 6,
  // 재생 순서: 원본 2~5번째 그림(칸 1~4)만 사용. 비슷한 1·6번째는 빼서 멈칫하는 느낌 없앰.
  // 5번째에서 2번째로 건너뛰지 않도록 갔다가 되돌아오게 반복
  sequence: [1, 2, 3, 4, 3, 2],
  shade: 'rgba(10, 4, 26, 0.38)',   // 원본 위에 덮는 어두운 색 (밝기 낮추기)
  groundY: 40,     // 칸 안에서 바닥선
  baseY: 35,       // 칸 안에서 웅덩이 가운데 높이
  feetDrop: 9,     // 잔영 위치에서 바닥선까지 아래로(px)
  ring: { rx: 21, ry: 7 },
};

// 그림 파일 없이 코드로 그리는 기본 공격 연출 (원거리 탄환·폭발 원). 전용 이펙트 그림이 생기면 ATTACK_FX로 바꿀 수 있음
//  색: 적은 주황·붉은빛, 기본 그림자는 카드 색 계열, 추출 그림자는 보랏빛
const PROC_FX_COLORS = {
  bolt:  { enemy: [255, 170, 70],  shadow: [255, 140, 60], extracted: [200, 160, 255] },
  blast: { enemy: [255, 90, 60],   shadow: [110, 215, 255], extracted: [190, 150, 255] },
};
const PROC_FX = {
  // 탄환: 쏜 쪽에서 맞은 쪽으로 날아가며 꼬리를 남기고, 끝에서 작게 터짐
  bolt(ctx, fx) {
    const c = PROC_FX_COLORS.bolt[fx.kind] || PROC_FX_COLORS.bolt.enemy;
    const p = Math.min(1, (fx.life - fx.ttl) / fx.life);
    const t = Math.min(1, p / 0.8);
    const x1 = fx.x1, y1 = fx.y1 - 10, x2 = fx.x2, y2 = fx.y2 - 8;
    const x = x1 + (x2 - x1) * t, y = y1 + (y2 - y1) * t;
    ctx.save();
    ctx.lineCap = 'round';
    if (t < 1) {
      const tt = Math.max(0, t - 0.25);
      ctx.strokeStyle = rgba(c, 0.55);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x1 + (x2 - x1) * tt, y1 + (y2 - y1) * tt);
      ctx.lineTo(x, y);
      ctx.stroke();
      ctx.shadowColor = rgba(c, 0.9);
      ctx.shadowBlur = 8;
      ctx.fillStyle = rgba(c, 1);
      drawCircle(ctx, x, y, 3.5); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      drawCircle(ctx, x, y, 1.5); ctx.fill();
    } else {
      const q = (p - 0.8) / 0.2;
      ctx.strokeStyle = rgba(c, 1 - q);
      ctx.lineWidth = 2;
      drawCircle(ctx, x2, y2, 4 + q * 8); ctx.stroke();
    }
    ctx.restore();
  },
  // 폭발 원: 가운데에서 범위만큼 퍼지며 옅어짐. atTarget이면 맞은 적 위(카이셀), 아니면 공격한 쪽 둘레(광역형)
  blast(ctx, fx) {
    const c = PROC_FX_COLORS.blast[fx.kind] || PROC_FX_COLORS.blast.enemy;
    const p = Math.min(1, (fx.life - fx.ttl) / fx.life);
    const cx = fx.atTarget ? fx.x2 : fx.x1, cy = fx.atTarget ? fx.y2 : fx.y1;
    const R = (fx.radius || 40) * (0.35 + 0.65 * Math.sqrt(p));
    ctx.save();
    ctx.fillStyle = rgba(c, 0.22 * (1 - p));
    ctx.beginPath(); ctx.ellipse(cx, cy + 4, R, R * 0.55, 0, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = rgba(c, 0.9 * (1 - p));
    ctx.lineWidth = 2;
    ctx.shadowColor = rgba(c, 0.8);
    ctx.shadowBlur = 8;
    ctx.beginPath(); ctx.ellipse(cx, cy + 4, R, R * 0.55, 0, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
  },
};

// ── 설원 숲(챕터 2) 배경 연출 ── 좌표는 맵 그림(1602×981) 기준, 그릴 때 전장 크기로 줄임. 실제 시간 기준이라 준비·일시정지 중에도 움직임
//  - 바람 세기(snowWind)를 눈과 나무가 같이 써서, 돌풍이 불 때 눈이 몰아치고 나무도 조금 더 흔들림
const SNOW_MAP = { w: 1602, h: 981 };
// 수정 보석: 가운데·크기(맵 px). 은은하게 빛이 맥동하고, 간간히 면 위에 별빛이 반짝임
const SNOW_CRYSTALS = [
  { x: 522, y: 87, w: 92, h: 72 }, { x: 1095, y: 115, w: 70, h: 62 }, { x: 1441, y: 206, w: 64, h: 62 },
  { x: 1429, y: 164, w: 30, h: 30 }, { x: 43, y: 494, w: 56, h: 58 }, { x: 1544, y: 500, w: 73, h: 64 },
  { x: 232, y: 879, w: 67, h: 71 }, { x: 1424, y: 849, w: 68, h: 67 },
];
// 흔들리는 나무: 잘라낼 영역(x0,y0,x1,y1)과 밑동 높이(base, 여기서는 안 움직임). 위로 갈수록 더 휘어짐
const SNOW_TREES = [
  { x0: 285, y0: 0,   x1: 410,  y1: 150, base: 150, phase: 0.0 },
  { x0: 1185, y0: 0,  x1: 1305, y1: 140, base: 140, phase: 2.1 },
  { x0: 1475, y0: 0,  x1: 1602, y1: 270, base: 270, phase: 4.0 },
  { x0: 55, y0: 810,  x1: 200,  y1: 981, base: 981, phase: 1.3 },
  { x0: 1125, y0: 860, x1: 1220, y1: 981, base: 981, phase: 3.2 },
  { x0: 1490, y0: 715, x1: 1602, y1: 981, base: 981, phase: 5.1 },
];
const TREE_SWAY_PX = 2.6;     // 나무 꼭대기가 움직이는 최대 폭(맵 px)
const TREE_SWAY_STEPS = 15;   // 미리 그려 두는 흔들림 단계 수 (-1 ~ 1)
const SNOW_FLAKES = 70;       // 눈송이 최대 수 (돌풍 때 전부, 평소엔 일부만)

// 바람 세기 0~1: 평소 약하게, 10초 안팎마다 3~4초 돌풍
function snowWind(t) {
  const gust = Math.max(0, Math.sin(t * 0.55) * 0.6 + Math.sin(t * 0.23 + 1.3) * 0.5 - 0.35);
  return Math.min(1, 0.15 + gust * 1.4);
}

// 나무 한 그루를 흔들림 단계별로 미리 그려 둠: 가로 줄마다 높이에 따라 옆으로 밀고, 가장자리는 부드럽게 비침
function buildSwayFrames(img, t) {
  const w = t.x1 - t.x0, h = t.y1 - t.y0, frames = [];
  const mask = document.createElement('canvas'); mask.width = w; mask.height = h;
  const mc = mask.getContext('2d');
  mc.save(); mc.translate(w / 2, h * 0.55); mc.scale(w / 2, h * 0.55);
  const g = mc.createRadialGradient(0, 0, 0, 0, 0, 1);
  g.addColorStop(0, 'rgba(0,0,0,1)'); g.addColorStop(0.6, 'rgba(0,0,0,1)'); g.addColorStop(1, 'rgba(0,0,0,0)');
  mc.fillStyle = g; mc.fillRect(-1, -1, 2, 2); mc.restore();
  for (let s = 0; s < TREE_SWAY_STEPS; s++) {
    const a = (s / (TREE_SWAY_STEPS - 1)) * 2 - 1;
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const cx = c.getContext('2d');
    cx.imageSmoothingEnabled = true;
    const STRIP = 2;
    for (let y = 0; y < h; y += STRIP) {
      const rise = Math.max(0, (t.base - (t.y0 + y)) / (t.base - t.y0));   // 밑동 0 → 꼭대기 1
      const dx = a * TREE_SWAY_PX * Math.pow(rise, 1.6);
      cx.drawImage(img, t.x0, t.y0 + y, w, STRIP, dx, y, w, STRIP);
    }
    cx.globalCompositeOperation = 'destination-in';
    cx.drawImage(mask, 0, 0);
    frames.push(c);
  }
  return frames;
}

function drawSnowTrees(ctx, entry, time) {
  if (!entry || !entry.img) return;
  if (!entry.swayFrames) entry.swayFrames = SNOW_TREES.map((t) => buildSwayFrames(entry.img, t));
  const F = GAME_DATA.field, kx = F.width / SNOW_MAP.w, ky = F.height / SNOW_MAP.h;
  const wind = snowWind(time);
  SNOW_TREES.forEach((t, i) => {
    // 바람 방향(오른쪽)으로 살짝 기운 채 흔들림. 돌풍이면 더 크게
    const sway = Math.sin(time * 1.7 + t.phase) * (0.35 + wind * 0.45) + wind * 0.25;
    const a = Math.max(-1, Math.min(1, sway));
    const fr = entry.swayFrames[i][Math.round((a + 1) / 2 * (TREE_SWAY_STEPS - 1))];
    ctx.drawImage(fr, t.x0 * kx, t.y0 * ky, (t.x1 - t.x0) * kx, (t.y1 - t.y0) * ky);
  });
}

// 수정 반짝임: 빛 번짐 맥동 + 수정마다 다른 때에 4갈래 별빛이 짧게 반짝
function drawSnowCrystals(ctx, time) {
  const F = GAME_DATA.field, kx = F.width / SNOW_MAP.w, ky = F.height / SNOW_MAP.h;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  SNOW_CRYSTALS.forEach((c, i) => {
    const x = c.x * kx, y = c.y * ky, r = Math.max(c.w, c.h) * kx * 0.75;
    const pulse = 0.5 + 0.5 * Math.sin(time * 1.6 + i * 1.9);
    const glow = ctx.createRadialGradient(x, y, 0, x, y, r);
    glow.addColorStop(0, `rgba(110,200,255,${(0.16 + pulse * 0.14).toFixed(3)})`);
    glow.addColorStop(1, 'rgba(110,200,255,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
    // 별빛: 수정마다 주기 2.6~4.2초 중 0.5초 동안. 면 위 세 자리를 돌아가며
    const period = 2.6 + (i * 0.37) % 1.6;
    const cyc = (time + i * 0.83) / period;
    const p = (cyc % 1) / (0.5 / period);
    if (p < 1) {
      const spots = [[0, -0.22], [-0.2, 0.02], [0.18, -0.05]];
      const [ox, oy] = spots[Math.floor(cyc) % spots.length];
      const sx = x + ox * c.w * kx, sy = y + oy * c.h * ky;
      const k = Math.sin(p * Math.PI);            // 0 → 1 → 0
      const len = (3 + c.w * kx * 0.12) * k;
      ctx.fillStyle = `rgba(225,245,255,${(0.9 * k).toFixed(3)})`;
      ctx.beginPath();                             // 가늘고 긴 4갈래 별
      ctx.moveTo(sx, sy - len); ctx.lineTo(sx + 0.8, sy - 0.8); ctx.lineTo(sx + len, sy); ctx.lineTo(sx + 0.8, sy + 0.8);
      ctx.lineTo(sx, sy + len); ctx.lineTo(sx - 0.8, sy + 0.8); ctx.lineTo(sx - len, sy); ctx.lineTo(sx - 0.8, sy - 0.8);
      ctx.closePath(); ctx.fill();
      const core = ctx.createRadialGradient(sx, sy, 0, sx, sy, 3.5);
      core.addColorStop(0, `rgba(255,255,255,${(0.8 * k).toFixed(3)})`);
      core.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = core;
      ctx.fillRect(sx - 4, sy - 4, 8, 8);
    }
  });
  ctx.restore();
}

// 휘날리는 눈: 평소엔 드문드문, 돌풍 때 많아지고 바람 쪽(오른쪽)으로 비스듬히 날림. 유닛 위에 그림
const snowFx = { flakes: null, last: null };
function drawSnowfall(ctx, time) {
  const F = GAME_DATA.field;
  if (!snowFx.flakes) {
    snowFx.flakes = Array.from({ length: SNOW_FLAKES }, (_, i) => ({
      x: Math.random() * F.width, y: Math.random() * F.height,
      vy: 16 + Math.random() * 22, size: Math.random() < 0.3 ? 2 : 1.4,
      seed: Math.random() * 10, alpha: 0.45 + Math.random() * 0.4, order: i / SNOW_FLAKES,
    }));
  }
  const dt = snowFx.last === null ? 0 : Math.min(0.1, Math.max(0, time - snowFx.last));
  snowFx.last = time;
  const wind = snowWind(time);
  const amount = 0.18 + wind * 0.82;            // 보이는 눈송이 비율
  ctx.save();
  for (const f of snowFx.flakes) {
    f.x += (14 + wind * 70 + Math.sin(time * 1.3 + f.seed) * 8) * dt;
    f.y += f.vy * (0.8 + wind * 0.5) * dt;
    if (f.y > F.height + 4) { f.y = -4; f.x = Math.random() * F.width; }
    if (f.x > F.width + 4) { f.x = -4; f.y = Math.random() * F.height; }
    const fade = Math.max(0, Math.min(1, (amount - f.order) * 8));   // 늘고 줄 때 부드럽게
    if (fade <= 0) continue;
    ctx.fillStyle = `rgba(235,245,255,${(f.alpha * fade).toFixed(3)})`;
    ctx.fillRect(f.x, f.y, f.size, f.size);
  }
  ctx.restore();
}

// 챕터 배경 맵: 경로별로 한 번만 불러와 보관. status: loading → ok / fail
const mapCache = {};
function loadMap(src) {
  if (!src || mapCache[src]) return mapCache[src] || null;
  const entry = { img: null, crackGlow: null, status: 'loading' };
  mapCache[src] = entry;
  const img = new Image();
  img.onload = () => {
    entry.img = img;
    entry.status = 'ok';
    if (src === MAP_IMAGE_SRC) entry.crackGlow = buildCrackGlow(img);   // 균열 빛은 기본 맵에서만 뽑음
  };
  img.onerror = () => { entry.status = 'fail'; console.warn(`[맵 이미지 불러오기 실패] ${src}`); };
  img.src = src;
  return entry;
}

// 챕터의 배경: 전용 맵을 불러왔으면 그것, 아니면 기본 맵(신전) + 연출. tint는 있으면 항상 덮음
function currentMapTheme(chapterId) {
  const ch = getChapter(chapterId);
  const th = (ch && ch.theme) || {};
  const base = mapCache[MAP_IMAGE_SRC];
  const own = th.map ? mapCache[th.map] : null;
  if (own && own.status === 'ok' && th.map !== MAP_IMAGE_SRC) {
    return { img: own.img, entry: own, tint: th.tint || null, decor: th.decor === 'temple', snow: th.decor === 'snow', orc: th.decor === 'orc', demon: th.decor === 'demon', ant: th.decor === 'ant', darkTemple: th.decor === 'darktemple', crackGlow: base && base.crackGlow };
  }
  return { img: base && base.img, tint: th.tint || null, decor: true, crackGlow: base && base.crackGlow };
}

// 중앙 거점 오브젝트 (assets/sprites/core.png, 104×101 도트). 그림이 없는 챕터는 챕터 1 거점, 그것도 없으면 기존 원형으로 그림
//  - 옆면 두께까지 포함한 전체 모양의 가운데를 거점 좌표(= 맵 중앙 문양)에 맞춤. 판정(반경 45)은 그대로
//  - 돌 색은 맵 석상 얼굴 돌 색에 맞춘 그림 (푸른 빛은 원본 그대로)
//  - 챕터 2~6: 같은 단상을 맵 색에 맞춰 다시 칠한 그림 (돌 = 맵 바닥색, 빛 = 맵 강조색)
//    2 설원 숲: 밝은 푸른 돌·푸른 빛 / 3 오크 주둔지: 흙색 돌·주황 빛 / 4 악마성: 보랏빛 돌·붉은 빛
//    5 개미굴: 짙은 보라 돌·자홍 빛 / 6 카르테논 신전(최종): 어두운 돌·붉은 빛
//  - 남은 HP는 별 문양 위 숫자로만 표시 (상단 HUD에도 표시됨)
const CORE_SHAPE = { w: 104, h: 101, anchorX: 52, anchorY: 50, starY: 44 };   // anchor: 전체 모양 가운데, starY: 별 문양 높이 → HP 숫자 위치
const CORE_SPRITES = {
  1: { src: 'assets/sprites/core.png',     ...CORE_SHAPE },
  2: { src: 'assets/sprites/core_ch2.png', ...CORE_SHAPE },
  3: { src: 'assets/sprites/core_ch3.png', ...CORE_SHAPE },
  4: { src: 'assets/sprites/core_ch4.png', ...CORE_SHAPE },
  5: { src: 'assets/sprites/core_ch5.png', ...CORE_SHAPE },
  6: { src: 'assets/sprites/core_ch6.png', ...CORE_SHAPE },
};
function coreSpriteFor(chapterId) {
  const own = CORE_SPRITES[chapterId];
  if (own && own.img) return own;
  return CORE_SPRITES[1].img ? CORE_SPRITES[1] : null;
}

// 거점 피격 흔들림: 맞은 순간 좌우로 크게(3px) 흔들리다 잦아들고, 처음에만 아래로 1px 덜컹. 1px 단위라 도트가 번지지 않음
const CORE_SHAKE_TIME = 0.3;   // 지속(초)
const CORE_SHAKE_PX = 3;       // 최대 폭(px)
const CORE_SHAKE_HZ = 22;      // 빠르기
function coreShake(state) {
  if (state.coreHitAt === undefined) return { dx: 0, dy: 0 };
  const t = state.elapsed - state.coreHitAt;
  if (t < 0 || t >= CORE_SHAKE_TIME) return { dx: 0, dy: 0 };
  const decay = 1 - t / CORE_SHAKE_TIME;
  return {
    dx: Math.round(Math.sin(t * CORE_SHAKE_HZ * Math.PI * 2) * CORE_SHAKE_PX * decay),
    dy: t < 0.06 ? 1 : 0,
  };
}

function drawCoreSprite(ctx, core, state, C) {
  const k = ctx.getTransform().a;
  const sh = coreShake(state);
  const x = Math.round((core.x - C.anchorX + sh.dx) * k) / k;
  const y = Math.round((core.y - C.anchorY + sh.dy) * k) / k;
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(C.img, x, y);
  const sy = core.y - C.anchorY + C.starY + sh.dy;   // 별 문양 가운데 (숫자도 같이 흔들림)
  ctx.restore();
  // 남은 HP가 CORE_HP_LOW 이하면 현재 HP 숫자만 붉게, ' / 최대'는 흰색 그대로
  const font = 'bold 12px Galmuri11, sans-serif';
  const cur = `${state.coreHp}`, rest = ` / ${state.maxCoreHp}`;
  ctx.font = font;
  const wCur = ctx.measureText(cur).width, wAll = ctx.measureText(cur + rest).width;
  const left = core.x + sh.dx - wAll / 2;
  ctx.lineWidth = 1;
  drawLabel(ctx, cur, left + wCur / 2, sy + 1, state.coreHp <= CORE_HP_LOW ? COLORS.coreHpLow : COLORS.text, font);
  drawLabel(ctx, rest, left + wCur + (wAll - wCur) / 2, sy + 1, COLORS.text, font);
}
const CORE_HP_LOW = 50;   // 거점 HP가 이 값 이하면 숫자를 붉게

function loadFxSheets() {
  for (const fx of [CLAW_FX, SLASH_FX, ICE_FX, BEARCLAW_FX, SLAM_FX, BITE_FX, BERCLAW_FX, BREATH_FX, ORB_FX, REMNANT_FX, DEMON_WINDOWS, ANT_GLOW, ...Object.values(CORE_SPRITES)]) {
    const img = new Image();
    img.onload = () => { fx.img = fx.shade ? buildTintedSheet(img, fx.shade) : img; };
    img.onerror = () => console.warn(`[이펙트 불러오기 실패] ${fx.src}`);
    img.src = fx.src;
  }
}

function drawRemnantSprite(ctx, r, time, isSelected, isHover) {
  const R = REMNANT_FX;
  // 다음 프레임으로 서서히 겹쳐 바뀌게 해서 뚝뚝 끊기지 않도록. 잔영마다 박자를 어긋나게
  const t = (time + r.uid * 0.29) * R.fps;
  const i = Math.floor(t) % R.sequence.length;
  const frame = R.sequence[i];
  const next = R.sequence[(i + 1) % R.sequence.length];
  const blend = t - Math.floor(t);
  const k = ctx.getTransform().a;
  const gx = Math.round(r.x * k) / k;
  const gy = Math.round((r.y + R.feetDrop) * k) / k;   // 바닥선
  const cy = gy - (R.groundY - R.baseY);                // 웅덩이 가운데
  // 남은 시간: 웅덩이 둘레 타원 호 (12시 방향부터 시계 방향으로 줄어듦)
  ctx.save();
  ctx.strokeStyle = COLORS.remnantRing;
  ctx.globalAlpha = 0.85;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.ellipse(gx, cy, R.ring.rx, R.ring.ry, 0, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * (r.ttl / r.duration));
  ctx.stroke();
  ctx.restore();
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  const dx = gx - Math.floor(R.w / 2), dy = gy - R.groundY;
  // 두 프레임을 작은 버퍼에 '더하기'로 섞으면 (지금×(1−b) + 다음×b) 겹친 부분이 옅어지지 않음
  // → 그냥 반투명으로 겹칠 때 생기던 깜빡임 없이 부드럽게 바뀜
  if (!R.buf) {
    R.buf = document.createElement('canvas');
    R.buf.width = R.w;
    R.buf.height = R.h;
  }
  const b = R.buf.getContext('2d');
  b.clearRect(0, 0, R.w, R.h);
  b.globalCompositeOperation = 'lighter';
  b.globalAlpha = 1 - blend;
  b.drawImage(R.img, frame * R.w, 0, R.w, R.h, 0, 0, R.w, R.h);
  b.globalAlpha = blend;
  b.drawImage(R.img, next * R.w, 0, R.w, R.h, 0, 0, R.w, R.h);
  b.globalAlpha = 1;
  b.globalCompositeOperation = 'source-over';
  ctx.drawImage(R.buf, dx, dy);
  ctx.restore();
  if (isSelected || isHover) {
    ctx.strokeStyle = isSelected ? COLORS.selected : COLORS.remnantRing;
    ctx.lineWidth = isSelected ? 2 : 1;
    ctx.beginPath();
    ctx.ellipse(gx, cy, R.ring.rx + 5, R.ring.ry + 3, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.lineWidth = 1;
  }
}

// 공격 이펙트 시트 그리기 (할퀴기·베기 공용). 시트를 아직 못 불러왔으면 false → 공격 선으로 대신 그림
function drawAttackFx(ctx, fx) {
  const S = ATTACK_FX[fx.style];
  if (!S || !S.img) return false;
  const delay = S.delay || 0;
  const elapsed = fx.life - fx.ttl;
  if (elapsed < delay) return true;   // 시작 지연 중: 아무것도 그리지 않음 (공격 선도 없음)
  const p = Math.min(0.999, Math.max(0, (elapsed - delay) / (fx.life - delay)));
  const frame = Math.floor(p * S.frames);
  const row = S.rows[fx.kind] ?? 0;
  // 그림은 왼쪽→오른쪽 방향. 공격한 유닛이 왼쪽을 보면(또는 적이 왼쪽에 있으면) 좌우 반전
  const dir = fx.facing ? fx.facing : (fx.x2 >= fx.x1 ? 1 : -1);
  const k = ctx.getTransform().a;        // 화면 픽셀에 맞춰 도트가 번지지 않게
  let ex = fx.x2 - dir * (S.pullX || 0), ey = fx.y2;   // 기본: 맞은 유닛 위
  if (S.reach) {   // 공격한 유닛이 바라보는 쪽 바로 앞에 표시 (적 위치를 따라가지 않음)
    ex = fx.x1 + dir * S.reach;
    ey = fx.y1;
  }
  const x = Math.round(ex * k) / k;
  const y = Math.round((ey - S.bodyLift) * k) / k;
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.shadowColor = S.glow[fx.kind] || Object.values(S.glow)[0];   // 어두운 바닥에서도 보이도록 옅은 빛
  ctx.shadowBlur = 6;
  ctx.translate(x, y);
  ctx.scale(S.mirror ? -dir : dir, S.upright ? 1 : -1);   // 위아래 반전: 위→아래로 긋는 모양 (mirror면 좌우도 반대로, upright면 위아래 그대로)
  ctx.drawImage(S.img, frame * S.w, row * S.h, S.w, S.h, -S.w / 2, -S.h / 2, S.w, S.h);
  ctx.restore();
  return true;
}

function render(ctx, state, view) {
  const F = GAME_DATA.field;
  const core = F.core;
  const placing = !!state.selectedShadowId && isFieldActive(state);
  // 캔버스 실제 해상도(고해상도 화면이면 2배)와 상관없이 항상 전장 좌표(960×588)로 그림
  ctx.setTransform(ctx.canvas.width / F.width, 0, 0, ctx.canvas.height / F.height, 0, 0);

  const theme = currentMapTheme(state.chapterId);   // 챕터 배경 (맵 그림이 없으면 기본 맵 + 색)
  if (theme.img) {
    // 맵 디자인 이미지를 전장 크기에 맞춰 그림 (판정 좌표와는 별개)
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(theme.img, 0, 0, F.width, F.height);
    if (theme.snow) drawSnowTrees(ctx, theme.entry, view.time);   // 설원 숲: 나무 흔들림 (어둡게 덮기 전에 맵과 함께)
    ctx.fillStyle = COLORS.mapShade;   // 유닛이 잘 보이도록 살짝 어둡게
    ctx.fillRect(0, 0, F.width, F.height);
    if (theme.tint) {                  // 챕터 분위기 색 (전용 맵이 없을 때 기본 맵 위에 덮음)
      ctx.fillStyle = theme.tint;
      ctx.fillRect(0, 0, F.width, F.height);
    }
    if (theme.decor) {                 // 기본 맵(신전) 전용 연출: 위치가 기본 맵 그림에 맞춰져 있음
      drawMapFlames(ctx, view.time);   // 불꽃 일렁임 (유닛보다 아래에 그림)
      drawStatueEyes(ctx, view.time);  // 석상 눈빛 맥동
      drawCrackGlow(ctx, view, theme.crackGlow);   // 출현 균열 빛 (적이 나올 때 번쩍)
    }
    if (theme.snow) drawSnowCrystals(ctx, view.time);   // 설원 숲: 수정 반짝임
    if (theme.orc) {                   // 오크 주둔지: 횃불 일렁임 + 해골 눈빛
      drawMapFlames(ctx, view.time, ORC_FLAMES, FLAME_ORANGE);
      drawSkullEyes(ctx, view.time);
    }
    if (theme.demon) {                 // 악마성: 촛불 일렁임 + 가고일 눈빛 + 창문 불 켜고 끄기
      drawDemonWindows(ctx, view.time);
      drawMapFlames(ctx, view.time, DEMON_CANDLES, FLAME_CANDLE);
      drawRedEyes(ctx, DEMON_GARGOYLE_EYES, pulseLevel(view.time, GARGOYLE_EYE_PULSE), 8);
    }
    if (theme.darkTemple) {            // 카르테논 신전(최종): 1챕터와 같은 연출을 붉은빛으로 + 석상 눈동자 움직임
      if (!theme.entry.darkCrackGlow) theme.entry.darkCrackGlow = buildCrackGlow(theme.img, DARK_CRACKS);
      drawMapFlames(ctx, view.time, DARK_FLAMES, FLAME_RED);
      drawDarkStatueEyes(ctx, view.time);
      drawCrackGlow(ctx, view, theme.entry.darkCrackGlow);
    }
    if (theme.ant) drawAntNest(ctx, view);   // 개미굴: 굴 안쪽 빛 맥동 + 바닥 균열 빛(1챕터식) + 알 빛
  } else {
    // 이미지를 불러오지 못했을 때의 기본 배경 + 격자
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
  }

  // 배치 불가 구역(맵 가장자리·거점·출현 지점·기존 기본 그림자 주변)은 화면에 따로 칠하지 않음.
  // 규칙(checkPlacement)은 그대로이며, 배치 미리보기 테두리가 초록/빨강으로 바뀌어 알려줌.
  // 적 출현 지점도 별도 표시 없음 (맵의 푸른 균열이 방향을 알려줌)

  // 중앙 거점 + HP 링
  const hpRatio = state.coreHp / state.maxCoreHp;
  const coreSprite = coreSpriteFor(state.chapterId);
  if (coreSprite) {
    drawCoreSprite(ctx, core, state, coreSprite);
  } else {
  ctx.save();
  ctx.shadowColor = COLORS.coreLine;
  ctx.shadowBlur = 18;
  ctx.fillStyle = COLORS.core;   // 반투명: 맵 중앙 문양이 비쳐 보이도록
  drawCircle(ctx, core.x, core.y, core.radius); ctx.fill();
  ctx.restore();
  ctx.strokeStyle = COLORS.coreLine;
  ctx.lineWidth = 2;
  drawCircle(ctx, core.x, core.y, core.radius);
  ctx.stroke();
  ctx.lineWidth = 5;
  ctx.strokeStyle = hpRatio <= 0.3 ? COLORS.coreHpLow : COLORS.coreHp;
  ctx.beginPath();
  ctx.arc(core.x, core.y, core.radius + 7, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * hpRatio);
  ctx.stroke();
  ctx.lineWidth = 1;
  drawLabel(ctx, '거점', core.x, core.y - 8, COLORS.coreLine, 'bold 14px sans-serif');
  drawLabel(ctx, `${state.coreHp} / ${state.maxCoreHp}`, core.x, core.y + 10, COLORS.text, '12px sans-serif');
  }

  // 범위 표시 (D 키)
  if (view.showRanges) {
    for (const u of state.basicUnits) {
      if (u.mobile) {   // 돌격하는 그림자: 움직일 수 있는 범위(배치한 자리 기준)
        ctx.fillStyle = COLORS.roam;
        drawCircle(ctx, u.originX, u.originY, u.maxRoamRadius); ctx.fill();
      }
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
    const isSelected = state.selectedRemnantUid === r.uid;
    const isHover = view.hoverRemnantUid === r.uid;
    if (REMNANT_FX.img) { drawRemnantSprite(ctx, r, state.elapsed, isSelected, isHover); continue; }
    const pulse = 0.55 + 0.25 * Math.sin(view.time * 5 + r.uid);
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
    const cfg = spriteFor(u.typeId);
    if (cfg) {   // 스프라이트: 대기·공격·피격 애니메이션 (대부분 제자리 고정, 돌격하는 그림자는 이동도)
      const engaged = findBasicTargets(state, u).length > 0;
      const pick = pickAnim(u, state.elapsed, !!u.moving, cfg, engaged);   // 돌격하는 그림자는 달리는 동안 이동 동작
      drawGroundShadow(ctx, cfg, pick.anim, pick.frame, u.x, u.y, 1, 1, GROUND_SHADOW);
      const selected = state.selectedUnitUid === u.uid;
      const recallHover = !selected && view.hoverUnitUid === u.uid && canRecall(state, u).ok;
      if (selected || recallHover) {   // 발밑 표시: 선택(흰색) / 회수 가능(노란색)
        ctx.strokeStyle = selected ? COLORS.selected : COLORS.recall;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.ellipse(u.x, spriteGroundY(u.y), 20, 7, 0, 0, Math.PI * 2);
        ctx.stroke();
        ctx.lineWidth = 1;
      }
      drawSpriteFrame(ctx, cfg, false, pick.anim, pick.frame, u.x, u.y, u.facing || 1, 1, 1, 0, hitFx(u.hitAt, state.elapsed));
      drawHpBar(ctx, u.x, spriteTopY(cfg, u.y, 1) - 6, 30, u.hp / u.maxHp, COLORS.hpShadow);
      continue;
    }
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

  // 사망 애니메이션 (적·추출 그림자). 북쪽 출현 적은 출현 연출과 같은 선 아래만 그림
  for (const c of state.corpses) {
    const cfg = spriteFor(c.typeId, state.chapterId);
    if (!cfg) continue;
    const t = state.elapsed - c.diedAt;
    const anim = cfg.anims.death;
    const frame = Math.min(anim.frames - 1, Math.floor(t * anim.fps));
    const fade = t < 0.6 ? 1 : Math.max(0, 1 - (t - 0.6) / (CORPSE_TIME - 0.6));
    const clipTop = c.extracted ? null : spawnClipTop(c.spawn, state.chapterId);
    const scaleMul = c.extracted ? EXTRACTED_SPRITE_SCALE : 1;
    withClip(ctx, clipTop, () => {
      drawGroundShadow(ctx, cfg, 'death', frame, c.x, c.y, fade, scaleMul, c.extracted ? GROUND_SHADOW_EXTRACTED : GROUND_SHADOW);
      // 마지막 일격도 번쩍이고 흔들리도록 사망 시각을 피격 시각으로 사용
      drawSpriteFrame(ctx, cfg, c.extracted, 'death', frame, c.x, c.y, c.facing, fade, scaleMul, 0, hitFx(c.diedAt, state.elapsed));
    });
  }

  // 추출 그림자
  for (const s of state.extractedUnits) {
    const src = findEnemyData(s.sourceEnemyId);
    const r = s.radius;
    const spawnRatio = s.aiState === AI.SPAWN ? 1 - s.spawnTimer / GAME_DATA.extraction.spawnDelay : 1;
    const cfg = spriteFor(s.sourceEnemyId, state.chapterId);
    if (cfg) {   // 스프라이트가 있으면 적 그림을 보랏빛 그림자로 물들여서 그림
      const pick = pickAnim(s, state.elapsed, s.aiState === AI.CHASE || s.aiState === AI.RETURN, cfg, s.aiState === AI.ATTACK);
      const alpha = 0.35 + 0.65 * Math.max(0, Math.min(1, spawnRatio));
      drawGroundShadow(ctx, cfg, pick.anim, pick.frame, s.x, s.y, alpha, EXTRACTED_SPRITE_SCALE, GROUND_SHADOW_EXTRACTED);
      drawSpriteFrame(ctx, cfg, true, pick.anim, pick.frame, s.x, s.y, s.facing || 1, alpha, EXTRACTED_SPRITE_SCALE, pick.bob, hitFx(s.hitAt, state.elapsed));
      if (state.selectedUnitUid === s.uid || view.hoverUnitUid === s.uid) {
        ctx.strokeStyle = state.selectedUnitUid === s.uid ? COLORS.selected : COLORS.remnantRing;
        ctx.lineWidth = state.selectedUnitUid === s.uid ? 2 : 1;
        ctx.beginPath();
        ctx.ellipse(s.x, spriteGroundY(s.y), 20, 7, 0, 0, Math.PI * 2);   // 발밑 선택 표시
        ctx.stroke();
        ctx.lineWidth = 1;
      }
      drawHpBar(ctx, s.x, spriteTopY(cfg, s.y, EXTRACTED_SPRITE_SCALE) - 6, 28, s.hp / s.maxHp, COLORS.hpExtracted);
      continue;
    }
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
    const clipTop = spawnClipTop(e.spawn, state.chapterId);   // 출현 연출: 지정한 선 위쪽은 가려서 문·벽·굴 아래에서 나오는 것처럼
    const cfg = spriteFor(e.typeId, state.chapterId);
    if (cfg) {   // 스프라이트: 이동·공격·피격 애니메이션
      const pick = pickAnim(e, state.elapsed, e.moving, cfg, !e.moving);
      withClip(ctx, clipTop, () => {
        drawGroundShadow(ctx, cfg, pick.anim, pick.frame, e.x, e.y, 1, 1, GROUND_SHADOW);
        drawSpriteFrame(ctx, cfg, false, pick.anim, pick.frame, e.x, e.y, e.facing || 1, 1, 1, pick.bob, hitFx(e.hitAt, state.elapsed));
        drawHpBar(ctx, e.x, spriteTopY(cfg, e.y, 1) - 6, 30, e.hp / e.maxHp, COLORS.hpEnemy);
      });
      continue;
    }
    if (clipTop !== null) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, clipTop, F.width, F.height - clipTop);
      ctx.clip();
    }
    ctx.fillStyle = d.color;
    drawCircle(ctx, e.x, e.y, e.radius); ctx.fill();
    ctx.strokeStyle = e.moving ? 'rgba(0,0,0,0.4)' : '#ffffff';   // 멈춰서 싸우는 중이면 흰 테두리
    ctx.lineWidth = e.moving ? 1 : 2;
    ctx.stroke();
    ctx.lineWidth = 1;
    drawLabel(ctx, d.name, e.x, e.y + e.radius + 10, COLORS.text, '10px sans-serif');
    drawHpBar(ctx, e.x, e.y - e.radius - 9, 30, e.hp / e.maxHp, COLORS.hpEnemy);
    if (clipTop !== null) ctx.restore();
  }

  // 공격 선 / 할퀴기 자국
  for (const fx of state.effects) {
    if (PROC_FX[fx.style]) { PROC_FX[fx.style](ctx, fx); continue; }   // 그림 없이 코드로 그리는 탄환·폭발
    if (fx.style === 'orb') {      // 어금니 마력구 (그림이 없으면 탄환으로 대신)
      if (drawOrbFx(ctx, fx, state)) continue;
      PROC_FX.bolt(ctx, fx); continue;
    }
    if (fx.style === 'breath') {   // 카이셀 브레스 (그림이 없으면 폭발 원으로 대신)
      if (drawBreathFx(ctx, fx)) continue;
      PROC_FX.blast(ctx, fx); continue;
    }
    if (ATTACK_FX[fx.style]) {   // 이펙트 시트가 있는 공격은 공격 선 없이 이펙트만
      if (drawAttackFx(ctx, fx)) continue;
      if (fx.ttl < fx.life - LINE_FX_TIME) continue;   // 이펙트 파일이 없으면 처음 잠깐만 공격 선
    }
    ctx.strokeStyle = fx.kind === 'shadow' ? COLORS.fxShadow : fx.kind === 'extracted' ? COLORS.fxExtracted : COLORS.fxEnemy;
    ctx.globalAlpha = Math.max(0, (fx.ttl - fx.life + LINE_FX_TIME) / LINE_FX_TIME);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(fx.x1, fx.y1);
    ctx.lineTo(fx.x2, fx.y2);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.lineWidth = 1;
  }

  // 설원 숲: 휘날리는 눈 (유닛 위, 배치 미리보기 아래)
  if (theme.snow) drawSnowfall(ctx, view.time);

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
    drawCircle(ctx, view.mouse.x, view.mouse.y, d.charge ? d.charge.leash : d.attackRange); ctx.stroke();   // 돌격하는 그림자는 달려갈 수 있는 범위
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
  view: {
    mouse: null, hoverRemnantUid: null, hoverUnitUid: null, showRanges: false, time: 0, confirmDismantleUid: null,
    crackFlash: [0, 0, 0, 0],       // 출현 지점별 번쩍임 세기 (적이 나올 때 1 → 서서히 0)
  },
  toastTimer: null,
  lastTime: null,
  accumulator: 0,
  save: null,          // 챕터 진행 저장 (createEmptySave 모양). 브라우저 저장소와 같은 내용
  lastStatus: null,    // 상태가 바뀌는 순간(웨이브 클리어·승리·패배)을 잡아 저장하기 위함
  clearInfo: null,     // 방금 챕터를 클리어한 결과 (최고 기록·해금 안내용)
  screen: 'title',     // READY 상태에서 보여줄 화면: 'title' | 'chapters'
  confirmRestartId: null,   // '처음부터'를 한 번 누른 챕터 (한 번 더 누르면 진행 삭제 후 시작)
};

/* ---------- 브라우저 저장소 (localStorage) ----------
 * 사생활 보호 모드·저장소 차단 등으로 읽기/쓰기가 실패해도 게임은 그대로 진행 (그때는 저장되지 않음) */
const SAVE_KEY = 'arise-defense-save';

function loadSave() {
  try {
    const text = window.localStorage.getItem(SAVE_KEY);
    return normalizeSave(text ? JSON.parse(text) : null);
  } catch (err) {
    console.warn('[저장 불러오기 실패]', err);
    return createEmptySave();
  }
}

function persistSave() {
  try {
    window.localStorage.setItem(SAVE_KEY, JSON.stringify(game.save));
  } catch (err) {
    console.warn('[저장 실패]', err);
  }
}

// 상태가 바뀐 순간 한 번: 웨이브 클리어 → 이어하기 저장, 챕터 클리어 → 기록·해금, 패배 → 이어하기 삭제
function onStatusChanged(st) {
  if (st.status === STATUS.WAVE_CLEAR) {
    game.save.resume[st.chapterId] = serializeRun(st);
    persistSave();
  } else if (st.status === STATUS.VICTORY) {
    game.clearInfo = recordChapterClear(game.save, st);
    persistSave();
  } else if (st.status === STATUS.DEFEAT) {
    delete game.save.resume[st.chapterId];
    persistSave();
  }
}

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

// 이번 판에 쓸 수 있는 카드만 표시 (챕터 보상으로 해금된 카드 포함). 숫자 키 = 카드 순서
// 카드 6장(데이터의 모든 기본 그림자)을 처음부터 3열 2줄로 고정해서 보여 줌.
// 아직 해금되지 않은 카드는 어둡게 덮고 자물쇠 + 해금 조건을 표시, 해금되면 풀림. 숫자 키는 카드 자리 번호 그대로
const LOCK_ICON =   // 도트 자물쇠 (12×14)
  '<svg class="lock-icon" viewBox="0 0 12 14" width="24" height="28" shape-rendering="crispEdges" aria-hidden="true">' +
  '<path fill="currentColor" d="M3 1h6v1h1v4H8V3H4v3H2V2h1z"/>' +
  '<path fill="currentColor" d="M1 6h10v7H1z"/>' +
  '<path fill="#0a0d1c" d="M5 8h2v3H5z"/></svg>';
function buildShadowCards() {
  const wrap = game.ui.cards;
  const all = GAME_DATA.shadows;
  const open = game.state.availableShadowIds;
  const key = all.map((s) => s.id + (open.includes(s.id) ? '' : '!')).join(',');
  if (wrap.dataset.ids === key) return;   // 같은 카드·해금 상태면 다시 만들지 않음
  wrap.dataset.ids = key;
  wrap.innerHTML = '';
  wrap.style.setProperty('--cols', all.length <= 4 ? all.length : 3);   // 5장 이상은 3열 2줄
  wrap.classList.toggle('compact', all.length > 4);
  all.forEach((s, i) => {
    const locked = !open.includes(s.id);
    const btn = document.createElement('button');
    btn.className = 'card' + (locked ? ' locked' : '');
    btn.type = 'button';
    btn.dataset.shadowId = s.id;
    btn.style.setProperty('--card-color', s.color);
    if (s.cardImage) {   // 카드 배경 그림 (텍스트가 잘 보이도록 CSS에서 어둡게 덮음)
      btn.classList.add('has-art');
      btn.style.setProperty('--card-art', `url("${s.cardImage}")`);
    }
    btn.innerHTML =
      `<span class="card-key">${i + 1}</span>` +
      `<span class="card-name">${s.name}</span>` +
      `<span class="card-role">${ROLE_TEXT[s.role] || s.role}</span>` +
      `<span class="card-stats">HP ${s.maxHp} · ATK ${s.attack} · 사거리 ${s.attackRange}</span>` +
      `<span class="card-cost">에너지 ${s.cost}</span>` +
      (locked ? `<span class="card-lock">${LOCK_ICON}<span class="card-lock-text">챕터 ${s.unlockAfterChapter} 클리어 시 해금</span></span>` : '');
    if (locked) btn.setAttribute('aria-disabled', 'true');
    btn.addEventListener('click', () => selectShadow(s.id));
    wrap.appendChild(btn);
  });
}

function selectShadow(id) {
  const st = game.state;
  if (!isFieldActive(st)) return;
  if (!st.availableShadowIds.includes(id)) {   // 잠긴 카드
    const d = findShadowData(id);
    if (d) showToast(`${d.name}: 챕터 ${d.unlockAfterChapter} 클리어 시 해금`, 'warn');
    return;
  }
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
      else showToast(reasonText(result, game.state), 'warn');
      return;
    }
  }
  clearSelection();
}

// 화면 좌표 → 전장 좌표 (캔버스 테두리 두께는 빼고 그림이 그려지는 안쪽 기준)
function toFieldPos(evt) {
  const c = game.canvas;
  const rect = c.getBoundingClientRect();
  const F = GAME_DATA.field;
  return {
    x: (evt.clientX - rect.left - c.clientLeft) * (F.width / c.clientWidth),
    y: (evt.clientY - rect.top - c.clientTop) * (F.height / c.clientHeight),
  };
}

// 캔버스 해상도를 화면에 보이는 크기 × 기기 픽셀 배율로 맞춤 → 레티나 화면에서도 흐릿하지 않음
function fitCanvasToScreen() {
  const F = GAME_DATA.field;
  const cssW = game.canvas.clientWidth;   // 테두리를 뺀 실제 그림 영역 폭
  if (cssW === 0) return;
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(cssW * dpr);
  const h = Math.round(w * F.height / F.width);
  if (game.canvas.width !== w || game.canvas.height !== h) {
    game.canvas.width = w;
    game.canvas.height = h;
  }
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
    else showToast(reasonText(result, game.state), 'warn');
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
    showToast(reasonText(result, game.state), 'warn');
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
    showToast(reasonText(result, game.state), 'warn');   // 에너지 부족 등: 잔영 유지
  }
}

// 챕터를 처음(웨이브 1)부터 시작. 그 챕터의 이어하기 진행은 지워짐
function newGame(chapterId = game.state.chapterId) {
  delete game.save.resume[chapterId];
  persistSave();
  setGameState(createInitialState(chapterId, getUnlockedShadowIds(game.save)));
  setStatus(game.state, STATUS.PREPARATION);
  game.lastStatus = game.state.status;
}

// 저장된 진행(마지막으로 클리어한 웨이브 다음)부터 이어서 시작
function resumeChapter(chapterId) {
  const run = game.save.resume[chapterId];
  if (!run) { newGame(chapterId); return; }
  setGameState(restoreRun(run, getUnlockedShadowIds(game.save)));
  showToast(`챕터 ${chapterId} · WAVE ${game.state.wave}부터 이어합니다`, 'ok');
}

function setGameState(state) {
  game.state = state;
  game.lastStatus = state.status;
  game.accumulator = 0;
  game.clearInfo = null;
  game.confirmRestartId = null;
  hideToast();   // 이전 판의 메시지가 남지 않도록
  if (game.ui.cards) buildShadowCards();   // 해금된 카드가 늘었을 수 있음
}

// 챕터 선택 화면 (READY). 진행 중이던 판은 버림 — 이어하기는 마지막으로 클리어한 웨이브 기준
function goToChapters() {
  setGameState(createInitialState(game.state ? game.state.chapterId : undefined, getUnlockedShadowIds(game.save)));
  game.screen = 'chapters';
  buildChapterList();
}

function goToTitle() {
  setGameState(createInitialState(game.state ? game.state.chapterId : undefined, getUnlockedShadowIds(game.save)));
  game.screen = 'title';
}

// 챕터 카드 목록: 잠김 / 도전 가능 / 진행 중(이어하기) / 클리어(최고 기록)
function buildChapterList() {
  const list = game.ui.chapterList;
  const save = game.save;
  const maxHp = GAME_DATA.config.coreHp;
  list.innerHTML = '';
  GAME_DATA.chapters.forEach((ch, i) => {
    const id = ch.chapterId;
    const unlocked = isChapterUnlocked(save, id);
    const cleared = save.cleared[id];                  // 실제 기록 (최고 기록 표시용)
    const done = isChapterCleared(save, id);           // 테스트 설정 포함 클리어 여부
    const run = save.resume[id];
    const card = document.createElement('div');
    card.className = 'chapter-card' + (unlocked ? '' : ' locked') + (done ? ' cleared' : '') + (run ? ' progress' : '');
    const badge = !unlocked ? '잠김' : run ? '진행 중' : done ? '클리어' : '도전 가능';
    const lines = [`웨이브 ${ch.waves.length}개`];
    const fresh = newEnemiesIn(id);
    if (fresh.length && i > 0) lines.push(`새 적: ${fresh.map((e) => e.name).join(' · ')}`);
    const rewards = rewardShadowsFor(id);
    if (rewards.length) lines.push(`클리어 보상: ${rewards.map((r) => `${r.name} 카드`).join(' · ')}${done ? ' (획득)' : ''}`);
    if (cleared) lines.push(`최고 기록 · 거점 HP ${cleared.best.coreHp}/${maxHp} · 처치 ${cleared.best.kills}`);
    const prev = GAME_DATA.chapters[i - 1];
    let buttons;
    if (!unlocked) {
      buttons = `<button type="button" class="btn-secondary" disabled>챕터 ${prev.chapterId} 클리어 시 해금</button>`;
    } else if (run) {
      const confirming = game.confirmRestartId === id;
      buttons = `<button type="button" class="btn-secondary" data-action="restart" data-chapter="${id}">${confirming ? '정말 처음부터?' : '처음부터'}</button>` +
        `<button type="button" class="btn-primary" data-action="resume" data-chapter="${id}">이어하기</button>`;
    } else {
      buttons = `<button type="button" class="btn-primary" data-action="start" data-chapter="${id}">${done ? '다시 도전' : '시작'}</button>`;
    }
    card.innerHTML =
      `<div class="chapter-head"><span class="chapter-no">CHAPTER ${id}</span><span class="chapter-badge">${badge}</span></div>` +
      `<h3 class="chapter-name">${ch.name}</h3>` +
      `<p class="chapter-desc">${ch.desc}</p>` +
      lines.map((t) => `<p class="chapter-info">${t}</p>`).join('') +
      (run ? `<p class="chapter-info resume">WAVE ${run.wave}부터 이어하기 · 거점 HP ${run.coreHp}/${maxHp}</p>` : '') +
      `<div class="chapter-buttons">${buttons}</div>`;
    list.appendChild(card);
  });
}

function onChapterListClick(evt) {
  const btn = evt.target.closest('button[data-action]');
  if (!btn || btn.disabled) return;
  const id = Number(btn.dataset.chapter);
  if (!isChapterUnlocked(game.save, id)) return;
  const action = btn.dataset.action;
  if (action === 'resume') resumeChapter(id);
  else if (action === 'start') newGame(id);
  else if (action === 'restart') {
    // 진행 중인 챕터를 처음부터: 한 번 더 눌러야 진행이 지워짐
    if (game.confirmRestartId === id) newGame(id);
    else { game.confirmRestartId = id; buildChapterList(); }
  }
}

function onStartWave() {
  if (startWave(game.state)) showToast(`WAVE ${game.state.wave} 시작`, 'ok');
}

function onResultPrimary() {
  const st = game.state;
  if (st.status === STATUS.WAVE_CLEAR) goToNextWave(st);
  else if (st.status === STATUS.VICTORY) {
    const next = getNextChapter(st.chapterId);
    if (next && isChapterUnlocked(game.save, next.chapterId)) {
      if (game.save.resume[next.chapterId]) resumeChapter(next.chapterId);
      else newGame(next.chapterId);
    } else newGame(st.chapterId);
  } else if (st.status === STATUS.DEFEAT) newGame(st.chapterId);
}

function onPause() {
  if (pauseGame(game.state)) hideToast();
}

function onResume() {
  if (resumeGame(game.state)) showToast('전투 재개', 'ok');
}

function togglePause() {
  if (game.state.status === STATUS.PAUSED) onResume();
  else onPause();
}

// 다른 탭·창으로 전환해 화면이 가려지면 자동으로 일시정지
function onVisibilityChange() {
  if (document.hidden) onPause();
}

function hasSelection(st) {
  return st.selectedShadowId !== null || st.selectedRemnantUid !== null || st.selectedUnitUid !== null;
}

function onKeyDown(evt) {
  if (evt.repeat) return;
  const key = evt.key.toLowerCase();
  if (key === 'd') { game.view.showRanges = !game.view.showRanges; return; }
  if (key === 'p') { togglePause(); return; }
  if (key === 'escape') {
    // Esc: 일시정지 중이면 계속하기 → 선택된 것이 있으면 선택 해제 → 전투 중이면 일시정지
    const st = game.state;
    if (st.status === STATUS.PAUSED) onResume();
    else if (hasSelection(st)) clearSelection();
    else onPause();
    return;
  }
  const num = Number(evt.key);
  const all = GAME_DATA.shadows;   // 숫자 키 = 카드 자리 번호 (잠긴 카드는 selectShadow에서 막음)
  if (Number.isInteger(num) && num >= 1 && num <= all.length) selectShadow(all[num - 1].id);
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
      return `카드를 고르고 전장 빈 곳을 클릭해 기본 그림자를 배치하세요 (최대 ${st.maxBasic}기). 남은 잔영은 지금도 추출할 수 있습니다.`;
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
    if (ev.startsWith('SPAWN_')) game.view.crackFlash[Number(ev.slice(6))] = 1;   // 해당 균열 번쩍
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

  setText(ui.chapter, `챕터 ${st.chapterId}`);
  setText(ui.wave, `${st.wave} / ${getWaveCount(st)}`);
  setText(ui.energy, `${st.energy} / ${st.maxEnergy}`);
  setText(ui.coreCur, `${st.coreHp}`);
  setText(ui.coreMax, `${st.maxCoreHp}`);
  setText(ui.army, `${countArmy(st)} / ${C.maxArmy}`);
  setText(ui.armyBasic, `기본 ${countBasic(st)}/${st.maxBasic}`);
  setText(ui.status, STATUS_TEXT[st.status]);
  setText(ui.hint, hintText(st));
  ui.coreCur.classList.toggle('danger', st.coreHp <= CORE_HP_LOW);   // 거점 위 숫자와 같은 기준

  const basicFull = countBasic(st) >= st.maxBasic || countArmy(st) >= C.maxArmy;
  for (const btn of ui.cards.children) {
    const d = findShadowData(btn.dataset.shadowId);
    btn.classList.toggle('selected', st.selectedShadowId === d.id);
    btn.classList.toggle('poor', !btn.classList.contains('locked') && (st.energy < d.cost || basicFull));
  }

  setHidden(ui.btnStart, st.status !== STATUS.PREPARATION);
  setText(ui.btnStart, `WAVE ${st.wave} 시작`);
  setHidden(ui.btnPause, st.status !== STATUS.PLAYING);   // 웨이브 시작 버튼 자리에 표시

  syncExtractPanel(st);
  syncUnitPanel(st);

  setHidden(ui.overlayPause, st.status !== STATUS.PAUSED);
  if (st.status === STATUS.PAUSED) {
    setText(ui.pauseStats, `챕터 ${st.chapterId} · WAVE ${st.wave} · 처치 ${st.stats.waveKills} · 군단 ${countArmy(st)}/${C.maxArmy} · 거점 HP ${st.coreHp}/${st.maxCoreHp} · 에너지 ${st.energy}`);
  }

  setHidden(ui.overlayTitle, st.status !== STATUS.READY || game.screen !== 'title');
  setHidden(ui.overlayChapters, st.status !== STATUS.READY || game.screen !== 'chapters');
  const showResult = st.status === STATUS.WAVE_CLEAR || st.status === STATUS.VICTORY || st.status === STATUS.DEFEAT;
  setHidden(ui.overlayResult, !showResult);
  if (showResult) {
    const s = st.stats;
    let extra = '';
    if (st.status === STATUS.WAVE_CLEAR) {
      setText(ui.resultTitle, '웨이브 방어 성공');
      setText(ui.resultDesc, `챕터 ${st.chapterId} · WAVE ${st.wave} 클리어 · 처치 ${s.waveKills} · 군단 ${countArmy(st)}/${C.maxArmy} · 거점 HP ${st.coreHp}/${st.maxCoreHp}`);
      setText(ui.btnResultPrimary, '다음 웨이브 준비');
      setText(ui.btnResultTitle, '저장하고 나가기');
      extra = `진행 저장됨 · 챕터 선택에서 WAVE ${st.wave + 1}부터 이어할 수 있습니다`;
    } else if (st.status === STATUS.VICTORY) {
      const info = game.clearInfo || {};
      const next = getNextChapter(st.chapterId);
      setText(ui.resultTitle, `챕터 ${st.chapterId} 클리어!`);
      setText(ui.resultDesc, `전 웨이브 클리어 · 총 처치 ${s.kills} · 추출 ${s.extractionSuccesses} · 거점 HP ${st.coreHp}/${st.maxCoreHp}`);
      setText(ui.btnResultPrimary, next ? '다음 챕터' : '다시 도전');
      setText(ui.btnResultTitle, '챕터 선택');
      const parts = [];
      if (info.unlockedCards && info.unlockedCards.length) {
        parts.push(`${info.unlockedCards.map((c) => `${c.name}(${ROLE_TEXT[c.role] || c.role})`).join(' · ')} 카드 획득! 기본 그림자 최대 ${info.maxBasic}기`);
      }
      if (info.unlockedNext) parts.push(`챕터 ${info.unlockedNext.chapterId} 「${info.unlockedNext.name}」 해금!`);
      if (info.newRecord && !info.firstClear) parts.push('최고 기록 갱신!');
      if (!next) parts.push('모든 챕터를 클리어했습니다');
      extra = parts.join('\n');   // 안내마다 한 줄씩
    } else {
      setText(ui.resultTitle, '던전 방어 실패');
      setText(ui.resultDesc, `챕터 ${st.chapterId} · WAVE ${st.wave}에서 거점 파괴 · 총 처치 ${s.kills} · 추출 ${s.extractionSuccesses}`);
      setText(ui.btnResultPrimary, '다시 도전');
      setText(ui.btnResultTitle, '챕터 선택');
    }
    setText(ui.resultExtra, extra);
    setHidden(ui.resultExtra, !extra);
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
  const flash = game.view.crackFlash;   // 균열 번쩍임은 약 1초에 걸쳐 사그라듦
  for (let i = 0; i < flash.length; i++) flash[i] = Math.max(0, flash[i] - delta * 1.1);

  const step = GAME_DATA.config.fixedStep;
  game.accumulator += delta;
  let steps = 0;
  while (game.accumulator >= step && steps < 30) {
    updateGame(game.state, step);
    game.accumulator -= step;
    steps += 1;
  }
  if (steps >= 30) game.accumulator = 0;
  if (game.state.status !== game.lastStatus) {
    game.lastStatus = game.state.status;
    onStatusChanged(game.state);
  }

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
    chapter: $('hud-chapter'), wave: $('hud-wave'), energy: $('hud-energy'), coreCur: $('hud-core-cur'), coreMax: $('hud-core-max'), army: $('hud-army'),
    armyBasic: $('hud-army-basic'), status: $('hud-status'),
    hint: $('hint'), toast: $('toast'), cards: $('shadow-cards'), btnStart: $('btn-start-wave'),
    extractPanel: $('extract-panel'), extractName: $('extract-name'), extractStats: $('extract-stats'),
    extractCost: $('extract-cost'), extractTime: $('extract-time'), btnExtract: $('btn-extract'),
    unitPanel: $('unit-panel'), unitKind: $('unit-kind'), unitName: $('unit-name'), unitStats: $('unit-stats'),
    unitState: $('unit-state'), unitRefund: $('unit-refund'), unitActions: $('unit-actions'), unitConfirm: $('unit-confirm'),
    overlayTitle: $('overlay-title'), overlayResult: $('overlay-result'),
    resultTitle: $('result-title'), resultDesc: $('result-desc'), resultExtra: $('result-extra'),
    btnResultPrimary: $('btn-result-primary'), btnResultTitle: $('btn-result-title'),
    overlayChapters: $('overlay-chapters'), chapterList: $('chapter-list'),
    btnPause: $('btn-pause'), overlayPause: $('overlay-pause'), pauseStats: $('pause-stats'),
  };

  game.save = loadSave();
  setGameState(createInitialState(undefined, getUnlockedShadowIds(game.save)));

  // 맵 디자인 이미지. 불러오기 전·실패 시에는 기본 배경으로 그림
  loadMap(MAP_IMAGE_SRC);
  for (const ch of GAME_DATA.chapters) if (ch.theme && ch.theme.map) loadMap(ch.theme.map);   // 챕터 전용 맵 (있는 것만)
  loadSprites();   // 캐릭터 스프라이트 (불러오기 전·실패 시에는 원형으로 그림)
  loadFxSheets();  // 공격 이펙트 (불러오기 전·실패 시에는 공격 선)

  game.canvas.addEventListener('click', onCanvasClick);
  game.canvas.addEventListener('mousemove', onMouseMove);
  game.canvas.addEventListener('mouseleave', onMouseLeave);
  $('app').addEventListener('contextmenu', onSecondaryClick);   // 기본 그림자 위: 회수 / 그 밖: 선택 해제
  $('btn-play').addEventListener('click', goToChapters);
  game.ui.chapterList.addEventListener('click', onChapterListClick);
  $('btn-chapters-back').addEventListener('click', goToTitle);
  game.ui.btnStart.addEventListener('click', onStartWave);
  game.ui.btnExtract.addEventListener('click', onExtract);
  $('btn-extract-cancel').addEventListener('click', () => { game.state.selectedRemnantUid = null; });
  $('btn-unit-close').addEventListener('click', () => { game.state.selectedUnitUid = null; });
  $('btn-dismantle').addEventListener('click', () => { game.view.confirmDismantleUid = game.state.selectedUnitUid; });
  $('btn-dismantle-cancel').addEventListener('click', () => { game.view.confirmDismantleUid = null; });   // 변화 없음
  $('btn-dismantle-confirm').addEventListener('click', onDismantleConfirm);
  game.ui.btnResultPrimary.addEventListener('click', onResultPrimary);
  game.ui.btnResultTitle.addEventListener('click', goToChapters);   // 웨이브 클리어 화면에서는 '저장하고 나가기'
  game.ui.btnPause.addEventListener('click', onPause);
  $('btn-resume').addEventListener('click', onResume);
  $('btn-pause-restart').addEventListener('click', () => newGame());   // 이 챕터를 웨이브 1부터 (이어하기 진행 삭제)
  $('btn-pause-title').addEventListener('click', goToChapters);   // 이어하기는 마지막으로 클리어한 웨이브부터
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('resize', fitCanvasToScreen);
  fitCanvasToScreen();
  document.addEventListener('visibilitychange', onVisibilityChange);

  requestAnimationFrame(frame);
}

if (typeof document !== 'undefined') boot();
